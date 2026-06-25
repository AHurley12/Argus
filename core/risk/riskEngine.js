// core/risk/riskEngine.js
// Pipeline orchestrator for the three-pillar risk model.
// Accepts pre-computed country signals, returns a complete risk assessment.
//
// Pipeline:
//   signals → pillarCalculator → severityAdjuster → classificationEngine → result

var pillarCalculator    = require('./pillarCalculator');
var severityAdjuster    = require('./severityAdjuster');
var classificationEngine = require('./classificationEngine');
var normalizeGini       = require('./normalizeGini');

// signals: {
//   baseline:       number 0–100  (static baseline risk score)
//   econSignal:     number 0–100  (GDELT economic-keyword event score)
//   humanSignal:    number 0–100  (GDELT humanitarian-keyword event score)
//   securitySignal: number 0–100  (GDELT security-keyword event score)
//   volatility:     number 0–100  (24h article density relative to 48h window)
// }
//
// Returns: {
//   pillars:        { economic, humanitarian, security }
//   compositeScore: number
//   maxPillar:      number
//   adjustedRisk:   number
//   finalScore:     number
//   band:           string  ('Green' | 'Yellow' | 'Orange' | 'Red')
//   tier:           string  ('LOW' | 'WATCH' | 'WARNING' | 'CRITICAL')
// }
function assessRisk(signals) {
  var pillars = pillarCalculator.computePillars(signals);

  // ── Gini escalation — additive bonus to economic pillar for extreme inequality ──
  // Applied before severity adjustment so it flows through the full pipeline.
  // Thresholds per spec: ≥50→+5, ≥55→+10, ≥60→+15 (cumulative: only highest applies).
  if (signals.rawGini != null && !isNaN(signals.rawGini)) {
    var giniBonus = 0;
    if      (signals.rawGini >= 60) giniBonus = 15;
    else if (signals.rawGini >= 55) giniBonus = 10;
    else if (signals.rawGini >= 50) giniBonus =  5;
    if (giniBonus > 0) {
      pillars.economic = Math.min(100, pillars.economic + giniBonus);
    }
  }

  var severity       = severityAdjuster.adjustSeverity(pillars);
  var classification = classificationEngine.classify(severity.adjustedRisk, pillars);

  return {
    pillars:        pillars,
    compositeScore: severity.compositeScore,
    maxPillar:      severity.maxPillar,
    adjustedRisk:   severity.adjustedRisk,
    finalScore:     classification.finalScore,
    band:           classification.band,
    tier:           classification.tier,
  };
}

module.exports = { assessRisk: assessRisk };
