// core/risk/pillarCalculator.js
// Computes the three pillar scores (Economic, Humanitarian, Security)
// from a set of pre-computed signal values.
//
// Each pillar is a weighted average of its indicators, normalized to [0, 100].
// Missing indicators have their weight redistributed to present ones.

var config = require('./riskConfig');

// Normalize a raw value to [0, 1] using fixed min/max bounds.
function normalizeIndicator(raw, min, max, inverted) {
  if (max === min) return 0;
  var clamped = Math.max(min, Math.min(max, raw));
  var norm = (clamped - min) / (max - min);
  return inverted ? (1 - norm) : norm;
}

// Compute one pillar score from its indicator definitions and current signal values.
// indicatorDefs: array of { key, weight, min, max, inverted }
// values:        object mapping key → raw numeric value
// Returns integer 0–100.
function computePillar(indicatorDefs, values) {
  var totalWeight  = 0;
  var weightedSum  = 0;

  for (var i = 0; i < indicatorDefs.length; i++) {
    var def = indicatorDefs[i];
    var raw = values[def.key];
    // Missing or non-numeric indicator: skip (weight redistributed to present indicators)
    if (raw === undefined || raw === null || isNaN(raw)) continue;
    var norm = normalizeIndicator(raw, def.min, def.max, def.inverted);
    weightedSum += norm * def.weight;
    totalWeight += def.weight;
  }

  // All indicators missing: return midpoint (no signal = moderate uncertainty)
  if (totalWeight === 0) return 50;

  // Divide by totalWeight to redistribute any missing-indicator weight
  return Math.round((weightedSum / totalWeight) * 100);
}

// Compute all three pillar scores.
// values: { baseline, econSignal, humanSignal, securitySignal, volatility }
// Returns: { economic, humanitarian, security }
function computePillars(values) {
  return {
    economic:     computePillar(config.INDICATORS.economic,     values),
    humanitarian: computePillar(config.INDICATORS.humanitarian, values),
    security:     computePillar(config.INDICATORS.security,     values),
  };
}

module.exports = { computePillars: computePillars };
