// core/risk/riskConfig.js
// Three-pillar risk model configuration.
// All normalization bounds are deterministic (fixed), not runtime min/max.

// ── Pillar weights (must sum to 1.0) ─────────────────────────────────────────
var PILLAR_WEIGHTS = {
  economic:     0.40,
  humanitarian: 0.30,
  security:     0.30,
};

// ── Per-pillar indicator definitions ─────────────────────────────────────────
// key:      signal name passed in the values object to pillarCalculator
// weight:   relative weight within this pillar (need not sum to 1; redistributed if indicator missing)
// min/max:  deterministic normalization bounds — values outside are clamped, not discarded
// inverted: true if higher raw value = lower risk (e.g. a prosperity index)
var INDICATORS = {
  economic: [
    { key: 'giniScore',  weight: 0.500, min: 0, max: 100, inverted: false },  // structural inequality (primary)
    { key: 'baseline',   weight: 0.375, min: 0, max: 100, inverted: false },  // structural macro proxy
    { key: 'gdeltScore', weight: 0.125, min: 0, max: 100, inverted: false },  // dampened event signal (secondary)
  ],
  humanitarian: [
    { key: 'baseline',    weight: 0.55, min: 0, max: 100, inverted: false },
    { key: 'humanSignal', weight: 0.45, min: 0, max: 100, inverted: false },
  ],
  security: [
    { key: 'baseline',       weight: 0.55, min: 0, max: 100, inverted: false },
    { key: 'securitySignal', weight: 0.35, min: 0, max: 100, inverted: false },
    { key: 'volatility',     weight: 0.10, min: 0, max: 100, inverted: false },
  ],
};

// ── Severity adjustment ───────────────────────────────────────────────────────
// AdjustedRisk = CompositeScore + SEVERITY_MULTIPLIER × (MaxPillar − CompositeScore)
var SEVERITY_MULTIPLIER = 0.15;

// ── Escalation rules ──────────────────────────────────────────────────────────
// If any single pillar reaches a threshold, the final score is floored to minScore.
// This prevents a dominant risk dimension from being averaged away.
var ESCALATION = {
  orange: { pillarThreshold: 85, minScore: 50 },
  red:    { pillarThreshold: 95, minScore: 75 },
};

// ── Risk band classification ──────────────────────────────────────────────────
// Bands are inclusive on min, exclusive on max (except final band).
var RISK_BANDS = [
  { label: 'Green',  tier: 'LOW',      min: 0,  max: 25  },
  { label: 'Yellow', tier: 'WATCH',    min: 25, max: 50  },
  { label: 'Orange', tier: 'WARNING',  min: 50, max: 75  },
  { label: 'Red',    tier: 'CRITICAL', min: 75, max: 101 },
];

module.exports = {
  PILLAR_WEIGHTS:      PILLAR_WEIGHTS,
  INDICATORS:          INDICATORS,
  SEVERITY_MULTIPLIER: SEVERITY_MULTIPLIER,
  ESCALATION:          ESCALATION,
  RISK_BANDS:          RISK_BANDS,
};
