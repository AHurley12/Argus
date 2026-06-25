// netlify/functions/calculate-risk.js
// Three-pillar risk scoring engine.
//
// Pillars (weighted composite):
//   Economic     (40%): baseline + GDELT sanction/trade/financial event signal
//   Humanitarian (30%): baseline + GDELT civilian/displacement/protest signal
//   Security     (30%): baseline + GDELT conflict/military event signal + volatility
//
// Severity adjustment: pulls composite toward the highest-scoring pillar.
// Escalation rules: any pillar ≥ 85 → Orange floor; ≥ 95 → Red floor.
// Results cached in Supabase global_events (key: "risk_scores"), TTL 5 minutes.

const { createClient } = require('@supabase/supabase-js');
const baseline      = require('../../data/baseline.json');
const riskEngine    = require('../../core/risk/riskEngine');
const normalizeGini = require('../../core/risk/normalizeGini');
const giniData      = require('../../data/gini.json');

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── GDELT sourcecountry name → ISO3 ─────────────────────────────────────────
const NAME_TO_ISO3 = {
  'united states': 'USA', 'russia': 'RUS', 'china': 'CHN', 'germany': 'DEU',
  'japan': 'JPN', 'india': 'IND', 'brazil': 'BRA', 'saudi arabia': 'SAU',
  'south korea': 'KOR', 'australia': 'AUS', 'nigeria': 'NGA', 'iran': 'IRN',
  'united kingdom': 'GBR', 'france': 'FRA', 'canada': 'CAN', 'mexico': 'MEX',
  'south africa': 'ZAF', 'turkey': 'TUR', 'argentina': 'ARG', 'indonesia': 'IDN',
  'pakistan': 'PAK', 'bangladesh': 'BGD', 'ethiopia': 'ETH', 'egypt': 'EGY',
  'united arab emirates': 'ARE', 'israel': 'ISR', 'ukraine': 'UKR', 'syria': 'SYR',
  'yemen': 'YEM', 'libya': 'LBY', 'sudan': 'SDN', 'mali': 'MLI', 'somalia': 'SOM',
  'afghanistan': 'AFG', 'north korea': 'PRK', 'venezuela': 'VEN', 'cuba': 'CUB',
  'myanmar': 'MMR', 'iraq': 'IRQ', 'belarus': 'BLR', 'poland': 'POL',
  'philippines': 'PHL', 'thailand': 'THA', 'vietnam': 'VNM', 'malaysia': 'MYS',
  'singapore': 'SGP', 'taiwan': 'TWN', 'hong kong': 'HKG', 'mongolia': 'MNG',
  'colombia': 'COL', 'peru': 'PER', 'chile': 'CHL', 'ecuador': 'ECU',
  'morocco': 'MAR', 'algeria': 'DZA', 'kenya': 'KEN', 'ghana': 'GHA',
  'lebanon': 'LBN', 'jordan': 'JOR', 'qatar': 'QAT', 'kuwait': 'KWT',
  'netherlands': 'NLD', 'belgium': 'BEL', 'spain': 'ESP', 'italy': 'ITA',
  'sweden': 'SWE', 'norway': 'NOR', 'switzerland': 'CHE', 'austria': 'AUT',
  'new zealand': 'NZL', 'democratic republic of the congo': 'COD', 'haiti': 'HTI',
  'nepal': 'NPL', 'sri lanka': 'LKA', 'azerbaijan': 'AZE', 'armenia': 'ARM',
  'georgia': 'GEO', 'kazakhstan': 'KAZ', 'angola': 'AGO', 'mozambique': 'MOZ',
  'zimbabwe': 'ZWE', 'rwanda': 'RWA', 'uganda': 'UGA', 'tanzania': 'TZA',
};

// ── Exponential time decay — half-life 48 h ───────────────────────────────────
function decay(seendate) {
  try {
    var hours = (Date.now() - new Date(seendate).getTime()) / 3600000;
    return Math.exp(-hours / 48);
  } catch(e) { return 0.5; }
}

// ── Normalise raw signal to 0–100 with soft cap ───────────────────────────────
function norm(raw, maxExpected) {
  return Math.min(100, (raw / maxExpected) * 100);
}

// ── Economic keywords: sanctions, trade war, financial crisis ─────────────────
// Returns weight 1–5, or 0 if the article is not economically relevant.
function getEconWeight(title) {
  if (!title) return 0;
  var t = title.toLowerCase();
  if (/sanction|embargo|blockade|seized|seizure/.test(t))                   return 5;
  if (/tariff|trade war|export ban|import ban/.test(t))                      return 4;
  if (/currency crisis|hyperinflation|economic collapse/.test(t))            return 4;
  if (/debt default|sovereign default|bankrupt|debt crisis/.test(t))         return 4;
  if (/economic crisis|financial crisis|market crash/.test(t))               return 3;
  return 0;
}

// ── Humanitarian keywords: civilian casualties, displacement, unrest ──────────
// Returns weight 1–5, or 0 if not relevant.
function getHumanWeight(title) {
  if (!title) return 0;
  var t = title.toLowerCase();
  if (/famine|starvation|genocide|civilian massacre/.test(t))                return 5;
  if (/\bkilled\b|civilian|casualties|displaced|refugee/.test(t))            return 4;
  if (/epidemic|pandemic|cholera|disease outbreak/.test(t))                  return 4;
  if (/protest|riot|unrest|uprising|strike/.test(t))                         return 3;
  if (/humanitarian|aid crisis|relief effort|food insecurity/.test(t))       return 2;
  return 0;
}

// ── Security keywords: armed conflict, terrorism, military action ─────────────
// Returns weight 1–5, or 0 if not relevant.
function getSecurityWeight(title) {
  if (!title) return 0;
  var t = title.toLowerCase();
  if (/war|invasion|airstrike|bombing|missile|offensive|coup|massacre/.test(t)) return 5;
  if (/\battack\b|explosion|fighting|assault|military strike/.test(t))           return 4;
  if (/terrorist|terrorism|nuclear weapon|armed conflict/.test(t))               return 4;
  if (/\bconflict\b|military operation|clash|battle/.test(t))                    return 3;
  if (/tension|threat|crisis|warning|disputed/.test(t))                          return 2;
  return 0;
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=300',
  };

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    // ── Check risk_scores cache (5 min TTL) ─────────────────────────────────
    const { data: cached } = await sb
      .from('global_events')
      .select('payload, updated_at')
      .eq('key', 'risk_scores')
      .single();

    if (cached && Date.now() - new Date(cached.updated_at).getTime() < CACHE_TTL_MS) {
      return { statusCode: 200, headers, body: JSON.stringify({ source: 'cache', scores: cached.payload }) };
    }

    // ── Read GDELT article cache ─────────────────────────────────────────────
    const { data: gdeltRow } = await sb
      .from('global_events')
      .select('payload')
      .eq('key', 'gdelt_feed')
      .single();

    const articles = (gdeltRow && gdeltRow.payload) || [];

    // ── Group articles by ISO3 country ───────────────────────────────────────
    const byCountry = {};
    articles.forEach(function(a) {
      var raw  = (a.sourcecountry || '').trim().toLowerCase();
      var iso3 = NAME_TO_ISO3[raw];
      if (!iso3) return;
      if (!byCountry[iso3]) byCountry[iso3] = [];
      byCountry[iso3].push(a);
    });

    const now = Date.now();

    // ── Compute per-country scores ────────────────────────────────────────────
    const scores = Object.keys(baseline).map(function(iso3) {
      var countryArticles = byCountry[iso3] || [];
      var base = baseline[iso3] || 30;

      // ── Three pillar GDELT signals ─────────────────────────────────────────
      // Each article contributes to zero or more pillar signals independently.
      var rawEcon     = 0;
      var rawHuman    = 0;
      var rawSecurity = 0;

      countryArticles.forEach(function(a) {
        var d = decay(a.seendate);
        rawEcon     += getEconWeight(a.title)     * d;
        rawHuman    += getHumanWeight(a.title)    * d;
        rawSecurity += getSecurityWeight(a.title) * d;
      });

      // Normalise GDELT signals 0–100
      var econSignalRaw  = norm(rawEcon,     6);
      var humanSignal    = norm(rawHuman,   10);
      var securitySignal = norm(rawSecurity, 8);

      // ── Economic Pillar sub-components ────────────────────────────────────────
      // giniScore:  structural inequality (Gini → 0–100)    [50.0% pillar weight]
      // baseline:   structural macro proxy                   [37.5% pillar weight, via values dict]
      // gdeltScore: square-dampened GDELT event signal       [12.5% pillar weight]
      //   Square dampening (x²/100): convex curve — raw=90→81, raw=50→25, raw=10→1.
      //   Punishes spikes; low chronic signals remain proportionally low.
      var giniResult = normalizeGini.compute(iso3, giniData);
      var giniScore  = giniResult.score;
      var gdeltScore = Math.round(Math.pow(econSignalRaw / 100, 2) * 100);

      // ── Volatility: 24h article density relative to 48h window ─────────────
      var recent24h = countryArticles.filter(function(a) {
        try { return now - new Date(a.seendate).getTime() < 86400000; } catch(e) { return false; }
      });
      var volatility = countryArticles.length > 0
        ? norm(recent24h.length, 5)
        : 0;

      // ── Run three-pillar risk engine ────────────────────────────────────────
      var result = riskEngine.assessRisk({
        giniScore:      giniScore,        // economic pillar: inequality indicator
        gdeltScore:     gdeltScore,       // economic pillar: dampened event signal
        rawGini:        giniResult.rawGini,  // escalation threshold in riskEngine
        baseline:       base,             // economic (macro proxy) + humanitarian + security
        humanSignal:    humanSignal,
        securitySignal: securitySignal,
        volatility:     volatility,
      });

      return {
        iso3:         iso3,
        // Legacy fields — kept for backwards-compatible client consumption
        dynamicScore: result.finalScore,
        baseline:     base,
        eventScore:   Math.round((econSignalRaw + humanSignal + securitySignal) / 3),
        volatility:   Math.round(volatility),
        articleCount: countryArticles.length,
        tier:         result.tier,
        // Pillar breakdown
        pillars: {
          economic:     result.pillars.economic,
          humanitarian: result.pillars.humanitarian,
          security:     result.pillars.security,
        },
        compositeScore: result.compositeScore,
        adjustedRisk:   result.adjustedRisk,
        band:           result.band,
        economicBreakdown: {
          inequalityScore: giniScore,
          gdeltScore:      gdeltScore,
          rawGini:         giniResult.rawGini,
          giniSource:      giniResult.source,
          regionalMedian:  normalizeGini.getRegionalMedian(iso3),
        },
      };
    });

    // ── Cache results ────────────────────────────────────────────────────────
    await sb.from('global_events').upsert({
      key:        'risk_scores',
      payload:    scores,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });

    return { statusCode: 200, headers, body: JSON.stringify({ source: 'live', scores }) };

  } catch(err) {
    console.error('calculate-risk error:', err.message);
    // Baseline-only fallback — never hard fail
    const fallback = Object.keys(baseline).map(function(iso3) {
      var base       = baseline[iso3];
      var giniResult = normalizeGini.compute(iso3, giniData);
      var result     = riskEngine.assessRisk({
        giniScore:  giniResult.score, gdeltScore: 0,
        rawGini:    giniResult.rawGini,
        baseline:   base, humanSignal: 0, securitySignal: 0, volatility: 0,
      });
      return {
        iso3:         iso3,
        dynamicScore: result.finalScore,
        baseline:     base,
        eventScore:   0,
        volatility:   0,
        articleCount: 0,
        tier:         result.tier,
        pillars:      result.pillars,
        compositeScore: result.compositeScore,
        adjustedRisk:   result.adjustedRisk,
        band:           result.band,
        economicBreakdown: {
          inequalityScore: giniResult.score,
          gdeltScore:      0,
          rawGini:         giniResult.rawGini,
          giniSource:      giniResult.source,
          regionalMedian:  normalizeGini.getRegionalMedian(iso3),
        },
      };
    });
    return { statusCode: 200, headers, body: JSON.stringify({ source: 'fallback', scores: fallback }) };
  }
};
