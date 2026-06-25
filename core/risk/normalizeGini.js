// core/risk/normalizeGini.js
// Gini coefficient normalization + regional fallback for the Argus economic inequality indicator.
//
// Normalization range: 20 (low inequality) → 65 (extreme inequality) → 0–100 risk scale.
// Higher Gini = higher inequality = higher economic risk.
//
// Fallback hierarchy (when ISO3 data is unavailable):
//   1. Regional median (by World Bank regional grouping)
//   2. Global median (38.0)

'use strict';

var GINI_MIN = 20;
var GINI_MAX = 65;

// Regional medians — World Bank Development Research Group estimates
var REGIONAL_MEDIANS = {
  'Sub-Saharan Africa':          42.0,
  'Latin America & Caribbean':   45.5,
  'Middle East & North Africa':  34.0,
  'East Asia & Pacific':         37.5,
  'South Asia':                  33.0,
  'Europe & Central Asia':       31.5,
  'North America':               38.5,
};

var GLOBAL_MEDIAN = 38.0;

// ISO3 → World Bank region mapping (covers all countries in baseline.json)
var ISO3_TO_REGION = {
  // Sub-Saharan Africa
  NGA:'Sub-Saharan Africa', ETH:'Sub-Saharan Africa', ZAF:'Sub-Saharan Africa',
  GHA:'Sub-Saharan Africa', KEN:'Sub-Saharan Africa', TZA:'Sub-Saharan Africa',
  MOZ:'Sub-Saharan Africa', ZMB:'Sub-Saharan Africa', ZWE:'Sub-Saharan Africa',
  COD:'Sub-Saharan Africa', CMR:'Sub-Saharan Africa', CIV:'Sub-Saharan Africa',
  SEN:'Sub-Saharan Africa', AGO:'Sub-Saharan Africa', UGA:'Sub-Saharan Africa',
  RWA:'Sub-Saharan Africa', MLI:'Sub-Saharan Africa', SOM:'Sub-Saharan Africa',
  SDN:'Sub-Saharan Africa',
  // Latin America & Caribbean
  BRA:'Latin America & Caribbean', MEX:'Latin America & Caribbean',
  ARG:'Latin America & Caribbean', COL:'Latin America & Caribbean',
  PER:'Latin America & Caribbean', CHL:'Latin America & Caribbean',
  ECU:'Latin America & Caribbean', BOL:'Latin America & Caribbean',
  PRY:'Latin America & Caribbean', URY:'Latin America & Caribbean',
  PAN:'Latin America & Caribbean', CRI:'Latin America & Caribbean',
  GTM:'Latin America & Caribbean', HND:'Latin America & Caribbean',
  SLV:'Latin America & Caribbean', NIC:'Latin America & Caribbean',
  DOM:'Latin America & Caribbean', HTI:'Latin America & Caribbean',
  VEN:'Latin America & Caribbean', CUB:'Latin America & Caribbean',
  // Middle East & North Africa
  SAU:'Middle East & North Africa', IRN:'Middle East & North Africa',
  EGY:'Middle East & North Africa', ARE:'Middle East & North Africa',
  ISR:'Middle East & North Africa', SYR:'Middle East & North Africa',
  YEM:'Middle East & North Africa', LBY:'Middle East & North Africa',
  IRQ:'Middle East & North Africa', LBN:'Middle East & North Africa',
  JOR:'Middle East & North Africa', KWT:'Middle East & North Africa',
  QAT:'Middle East & North Africa', BHR:'Middle East & North Africa',
  OMN:'Middle East & North Africa', MAR:'Middle East & North Africa',
  DZA:'Middle East & North Africa', TUN:'Middle East & North Africa',
  // East Asia & Pacific
  CHN:'East Asia & Pacific', JPN:'East Asia & Pacific', KOR:'East Asia & Pacific',
  AUS:'East Asia & Pacific', IDN:'East Asia & Pacific', PHL:'East Asia & Pacific',
  THA:'East Asia & Pacific', VNM:'East Asia & Pacific', MYS:'East Asia & Pacific',
  SGP:'East Asia & Pacific', NZL:'East Asia & Pacific', TWN:'East Asia & Pacific',
  HKG:'East Asia & Pacific', MNG:'East Asia & Pacific', MMR:'East Asia & Pacific',
  LKA:'East Asia & Pacific', PNG:'East Asia & Pacific', FJI:'East Asia & Pacific',
  // South Asia
  IND:'South Asia', PAK:'South Asia', BGD:'South Asia', NPL:'South Asia',
  AFG:'South Asia', MDV:'South Asia', BTN:'South Asia',
  // Europe & Central Asia
  DEU:'Europe & Central Asia', GBR:'Europe & Central Asia', FRA:'Europe & Central Asia',
  RUS:'Europe & Central Asia', TUR:'Europe & Central Asia', POL:'Europe & Central Asia',
  NLD:'Europe & Central Asia', BEL:'Europe & Central Asia', CHE:'Europe & Central Asia',
  AUT:'Europe & Central Asia', ESP:'Europe & Central Asia', ITA:'Europe & Central Asia',
  SWE:'Europe & Central Asia', NOR:'Europe & Central Asia', DNK:'Europe & Central Asia',
  FIN:'Europe & Central Asia', GRC:'Europe & Central Asia', PRT:'Europe & Central Asia',
  CZE:'Europe & Central Asia', ROU:'Europe & Central Asia', SRB:'Europe & Central Asia',
  UKR:'Europe & Central Asia', BLR:'Europe & Central Asia', AZE:'Europe & Central Asia',
  ARM:'Europe & Central Asia', GEO:'Europe & Central Asia', KAZ:'Europe & Central Asia',
  UZB:'Europe & Central Asia', TKM:'Europe & Central Asia',
  // North America
  USA:'North America', CAN:'North America',
  // PRK — no region data available; will use global median
};

// Clamp helper
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Normalize raw Gini (any number) to 0–100 risk scale.
// Returns integer.
function normalize(gini) {
  if (gini == null || isNaN(gini)) return Math.round(normalize(GLOBAL_MEDIAN));
  var raw = ((gini - GINI_MIN) / (GINI_MAX - GINI_MIN)) * 100;
  return Math.round(clamp(raw, 0, 100));
}

// Return the regional median Gini for an ISO3 code.
// Falls back to global median.
function getRegionalMedian(iso3) {
  var region = ISO3_TO_REGION[iso3];
  return region ? (REGIONAL_MEDIANS[region] || GLOBAL_MEDIAN) : GLOBAL_MEDIAN;
}

// Resolve the best available Gini for an ISO3 from a giniData dict.
// Returns { gini: number, source: 'country'|'regional'|'global' }
function resolve(iso3, giniData) {
  if (giniData && giniData[iso3] != null) {
    return { gini: giniData[iso3], source: 'country' };
  }
  var regional = getRegionalMedian(iso3);
  var source   = ISO3_TO_REGION[iso3] ? 'regional' : 'global';
  return { gini: regional, source: source };
}

// Compute inequality score 0–100 for a given ISO3.
// Combines normalize() with resolve(), returning the full diagnostic object.
function compute(iso3, giniData) {
  var r = resolve(iso3, giniData);
  return {
    rawGini:  r.gini,
    source:   r.source,
    score:    normalize(r.gini),
  };
}

module.exports = {
  normalize:         normalize,
  getRegionalMedian: getRegionalMedian,
  resolve:           resolve,
  compute:           compute,
  GINI_MIN:          GINI_MIN,
  GINI_MAX:          GINI_MAX,
  GLOBAL_MEDIAN:     GLOBAL_MEDIAN,
};
