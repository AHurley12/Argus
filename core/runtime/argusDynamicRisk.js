// ── ArgusDataAge — dynamic risk scoring overlay ───────────────────────────────
// Fetches dynamic country risk scores from calculate-risk Netlify function.
// Overlays scores onto COUNTRIES_DATA and globe marker colors.
// Only escalates risk (never silently downgrades static baselines).
// Extracted from index.html inline script — no closure dependencies.

(function() {
'use strict';

// score → risk tier (mirrors calculate-risk.js scoreToTier)
function scoreToTier(s) {
  if (s >= 75) return 'CRITICAL';
  if (s >= 54) return 'WARNING';
  if (s >= 33) return 'WATCH';
  return 'LOW';
}

var RISK_TIER_RANK  = { LOW: 0, WATCH: 1, WARNING: 2, CRITICAL: 3 };
var RISK_TIER_COLOR = { LOW: '#00ff88', WATCH: '#ffcc00', WARNING: '#ff9933', CRITICAL: '#ff0044' };

// Fetch scores from calculate-risk, apply to globe markers and COUNTRIES_DATA.
// Only upgrades risk (never silently downgrades static hand-curated baselines).
async function fetchDynamicRisk() {
  try {
    var res = await fetch('/.netlify/functions/calculate-risk');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var json = await res.json();
    var scores = json.scores;
    if (!scores || !scores.length) return;

    // Build lookup: ISO3 → score object
    var byIso3 = {};
    scores.forEach(function(s) { byIso3[s.iso3] = s; });

    // ── Update COUNTRIES_DATA in place ───────────────────────────────────────
    (window.COUNTRIES_DATA || []).forEach(function(cd) {
      var s = byIso3[cd.code];
      if (!s) return;
      cd._dynamicScore   = s.dynamicScore;
      cd._eventScore     = s.eventScore;
      cd._volatility     = s.volatility;
      cd._articleCount   = s.articleCount;
      cd._pillars        = s.pillars        || null;
      cd._band           = s.band           || null;
      cd._adjustedRisk   = s.adjustedRisk   || null;
      cd._compositeScore = s.compositeScore || null;
    });

    // ── Update globe marker colors ────────────────────────────────────────────
    // Only escalate — if dynamic score pushes to a higher tier, update color.
    (window.countryMarkers || []).forEach(function(mesh) {
      var s = byIso3[mesh.userData.code];
      if (!s) return;

      var staticTier  = mesh.userData.risk || 'LOW';
      var dynamicTier = scoreToTier(s.dynamicScore);

      mesh.userData._dynamicScore   = s.dynamicScore;
      mesh.userData._eventScore     = s.eventScore;
      mesh.userData._volatility     = s.volatility;
      mesh.userData._pillars        = s.pillars        || null;
      mesh.userData._band           = s.band           || null;
      mesh.userData._adjustedRisk   = s.adjustedRisk   || null;
      mesh.userData._compositeScore = s.compositeScore || null;

      if (RISK_TIER_RANK[dynamicTier] > RISK_TIER_RANK[staticTier]) {
        mesh.material.color.set(RISK_TIER_COLOR[dynamicTier]);
        mesh.userData._dynamicTier = dynamicTier;
      }
    });

    // Mirror to hit meshes (invisible but carry userData for detail panel)
    (window.countryHitMeshes || []).forEach(function(mesh) {
      var s = byIso3[mesh.userData.code];
      if (!s) return;
      mesh.userData._dynamicScore   = s.dynamicScore;
      mesh.userData._eventScore     = s.eventScore;
      mesh.userData._volatility     = s.volatility;
      mesh.userData._pillars        = s.pillars        || null;
      mesh.userData._band           = s.band           || null;
      mesh.userData._adjustedRisk   = s.adjustedRisk   || null;
      mesh.userData._compositeScore = s.compositeScore || null;
    });

    // Expose shared store so any module can access scores and freshness timestamp
    window._argusRiskStore = { byIso3: byIso3, fetchedAt: Date.now(), source: json.source };

    console.log('calculate-risk: applied dynamic scores (' + json.source + ', ' + scores.length + ' countries)');

  } catch(err) {
    console.warn('calculate-risk: fetch failed —', err.message);
  }
}

// Run after globe markers are placed (slight defer ensures globe init is done)
window.addEventListener('DOMContentLoaded', function() {
  setTimeout(fetchDynamicRisk, 3000);            // initial load
  setInterval(fetchDynamicRisk, 5 * 60 * 1000); // refresh every 5 min
});

window.fetchDynamicRisk = fetchDynamicRisk; // expose for manual refresh

if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusDynamicRisk');

}());
