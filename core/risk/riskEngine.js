// core/risk/riskEngine.js
// Pipeline orchestrator for the three-pillar risk model.
// Accepts pre-computed country signals, returns a complete risk assessment.
//
// Pipeline:
//   signals → pillarCalculator → severityAdjuster → classificationEngine → result

var pillarCalculator    = require('./pillarCalculator');
var severityAdjuster    = require('./severityAdjuster');
var classificationEngine = require('./classificationEngine');

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
  var pillars        = pillarCalculator.computePillars(signals);
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
