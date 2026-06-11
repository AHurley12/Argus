// core/risk/classificationEngine.js
// Maps adjusted risk score to a risk band and tier label.
// Applies escalation overrides when any single pillar reaches critical thresholds.
//
// Escalation rules:
//   Any pillar ≥ 85 → score floored to 50 (Orange / WARNING minimum)
//   Any pillar ≥ 95 → score floored to 75 (Red / CRITICAL minimum)
//
// This ensures a country with one dominating risk dimension cannot be classified
// below its most severe pillar warrants.

var config = require('./riskConfig');

// adjustedRisk: number 0–100 (from severityAdjuster)
// pillars:      { economic, humanitarian, security }
// Returns: { band, tier, finalScore }
function classify(adjustedRisk, pillars) {
  var finalScore = adjustedRisk;

  var maxPillar = Math.max(pillars.economic, pillars.humanitarian, pillars.security);

  // Apply escalation floors (highest threshold wins)
  if (maxPillar >= config.ESCALATION.red.pillarThreshold) {
    finalScore = Math.max(finalScore, config.ESCALATION.red.minScore);
  } else if (maxPillar >= config.ESCALATION.orange.pillarThreshold) {
    finalScore = Math.max(finalScore, config.ESCALATION.orange.minScore);
  }

  finalScore = Math.min(100, finalScore);

  // Walk bands from lowest to highest; last match wins (highest qualifying band)
  var band = config.RISK_BANDS[0];
  for (var i = 0; i < config.RISK_BANDS.length; i++) {
    if (finalScore >= config.RISK_BANDS[i].min) {
      band = config.RISK_BANDS[i];
    }
  }

  return {
    band:       band.label,
    tier:       band.tier,
    finalScore: finalScore,
  };
}

module.exports = { classify: classify };
