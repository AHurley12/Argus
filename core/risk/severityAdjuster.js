// core/risk/severityAdjuster.js
// Applies non-linear severity adjustment to the composite pillar score.
//
// Formula:
//   CompositeScore = weighted average of pillar scores
//   MaxPillar      = highest single-pillar score
//   AdjustedRisk   = CompositeScore + SEVERITY_MULTIPLIER × (MaxPillar − CompositeScore)
//
// This pulls the composite toward the most extreme pillar, so a country with one
// severely elevated dimension (e.g. active conflict) is not fully averaged down
// by calmer pillars.

var config = require('./riskConfig');

// pillars: { economic, humanitarian, security }
// Returns: { compositeScore, maxPillar, adjustedRisk }
function adjustSeverity(pillars) {
  var composite = Math.round(
    config.PILLAR_WEIGHTS.economic     * pillars.economic     +
    config.PILLAR_WEIGHTS.humanitarian * pillars.humanitarian +
    config.PILLAR_WEIGHTS.security     * pillars.security
  );

  var maxPillar = Math.max(pillars.economic, pillars.humanitarian, pillars.security);

  var adjusted = composite + config.SEVERITY_MULTIPLIER * (maxPillar - composite);
  adjusted = Math.max(0, Math.min(100, Math.round(adjusted)));

  return {
    compositeScore: composite,
    maxPillar:      maxPillar,
    adjustedRisk:   adjusted,
  };
}

module.exports = { adjustSeverity: adjustSeverity };
