'use strict';
// netlify/lib/gdacs-health.js
// Source health monitor for GDACS ingestion.
//
// Contract:
//   createHealthRecord()                      → initial health state object
//   deriveHealthState(rec)                    → health state string
//   updateHealthOnSuccess(existing, metrics)  → updated record
//   updateHealthOnFailure(existing, err)      → updated record
//   updateHealthOnStaleCacheFallback(existing)→ updated record
//   updateHealthOnCacheHit(existing)          → updated record
//   updateHealthOnCacheMiss(existing)         → updated record
//
// Design principles:
//   - Stateless functions — health record is the only mutable artifact (persisted externally)
//   - Deterministic state machine — each transition has explicit entry/exit conditions
//   - Never throws — all functions return updated records, never propagate exceptions
//   - Isolated from fetch and normalization logic — pure health accounting
//   - All records are plain serializable objects — safe for JSON round-trips via Supabase
//
// Health states:
//   healthy            — normal operation; consecutive failures = 0
//   degraded           — 2–4 consecutive failures; serving live data where possible
//   stale_cache        — serving expired cache due to upstream failure
//   retrying           — actively retrying after transient failure (within-invocation)
//   offline            — ≥5 consecutive failures; upstream appears unreachable
//   validation_failure — >30% of recent events fail validation; possible schema change

// ── State constants ───────────────────────────────────────────────────────────────

var STATES = {
  HEALTHY:            'healthy',
  DEGRADED:           'degraded',
  STALE_CACHE:        'stale_cache',
  RETRYING:           'retrying',
  OFFLINE:            'offline',
  VALIDATION_FAILURE: 'validation_failure',
};

// ── Transition thresholds ─────────────────────────────────────────────────────────

var DEGRADED_FAILURE_THRESHOLD    = 2;    // consecutive failures before degraded
var OFFLINE_FAILURE_THRESHOLD     = 5;    // consecutive failures before offline
var VALIDATION_FAILURE_RATE_LIMIT = 0.30; // >30% per-cycle validation failures → flag

// ── Baseline record factory ───────────────────────────────────────────────────────

/**
 * Create a fresh health record. Used when no persisted health record exists in Supabase
 * (first deployment, or after a manual health reset).
 */
function createHealthRecord() {
  return {
    healthState:              STATES.HEALTHY,

    // Fetch outcomes
    lastFetchTimestamp:       null,
    lastFetchLatencyMs:       null,
    lastFetchSuccess:         null,
    consecutiveFailures:      0,
    totalFetches:             0,
    totalSuccesses:           0,
    totalFailures:            0,
    totalRetries:             0,

    // Validation and normalization
    totalValidationFailures:      0,
    totalNormalizationFailures:   0,
    lastCycleValidationFailures:  0,
    lastCycleValidationFailureRate: 0,
    validationFailureRateLifetime: 0,

    // Cache behavior
    cacheHits:            0,
    cacheMisses:          0,
    totalStaleCacheServes: 0,
    staleSinceTimestamp:  null,

    // Ingestion throughput
    lastEventCount:           0,
    lastIngestionThroughput:  0,
    peakEventCount:           0,

    // Error tracking
    lastErrorMessage:    null,
    lastErrorTimestamp:  null,

    updatedAt: new Date().toISOString(),
  };
}

// ── State derivation ──────────────────────────────────────────────────────────────

/**
 * Derive the canonical health state from a health record.
 * State is a deterministic function of the record — never set directly.
 */
function deriveHealthState(rec) {
  if (rec.consecutiveFailures >= OFFLINE_FAILURE_THRESHOLD)   return STATES.OFFLINE;
  if (rec.consecutiveFailures >= DEGRADED_FAILURE_THRESHOLD)  return STATES.DEGRADED;
  if (rec.staleSinceTimestamp !== null)                       return STATES.STALE_CACHE;
  if (rec.lastCycleValidationFailureRate > VALIDATION_FAILURE_RATE_LIMIT) {
    return STATES.VALIDATION_FAILURE;
  }
  return STATES.HEALTHY;
}

// ── Transition functions ──────────────────────────────────────────────────────────

/**
 * Update health record after a successful fetch + ingestion cycle.
 *
 * @param {object} existing — current persisted health record (or null)
 * @param {object} metrics  — { latencyMs, eventCount, validationFailures, normalizationFailures, retries }
 * @returns {object} updated health record
 */
function updateHealthOnSuccess(existing, metrics) {
  metrics = metrics || {};
  var rec = Object.assign({}, existing || createHealthRecord());

  rec.totalFetches++;
  rec.totalSuccesses++;
  rec.consecutiveFailures  = 0;
  rec.lastFetchTimestamp   = new Date().toISOString();
  rec.lastFetchLatencyMs   = typeof metrics.latencyMs === 'number' ? metrics.latencyMs : null;
  rec.lastFetchSuccess     = true;
  rec.lastErrorMessage     = null;
  rec.staleSinceTimestamp  = null;  // successful fetch clears stale state

  // Throughput tracking
  if (typeof metrics.eventCount === 'number') {
    rec.lastEventCount          = metrics.eventCount;
    rec.lastIngestionThroughput = metrics.eventCount;
    if (metrics.eventCount > rec.peakEventCount) rec.peakEventCount = metrics.eventCount;
  }

  // Validation failure accounting
  var failCount = (typeof metrics.validationFailures === 'number') ? metrics.validationFailures : 0;
  var total     = (typeof metrics.eventCount === 'number') ? metrics.eventCount + failCount : failCount;
  rec.totalValidationFailures        += failCount;
  rec.lastCycleValidationFailures     = failCount;
  rec.lastCycleValidationFailureRate  = total > 0 ? failCount / total : 0;
  // Lifetime rate: weighted average (approximate, avoids storing full history)
  if (rec.totalSuccesses > 0) {
    var lifetimeTotal = rec.totalValidationFailures + (rec.lastEventCount || 0);
    rec.validationFailureRateLifetime = rec.totalValidationFailures / Math.max(lifetimeTotal, 1);
  }

  // Normalization failure accounting
  if (typeof metrics.normalizationFailures === 'number') {
    rec.totalNormalizationFailures += metrics.normalizationFailures;
  }

  // Retry accounting
  if (typeof metrics.retries === 'number' && metrics.retries > 0) {
    rec.totalRetries += metrics.retries;
  }

  rec.healthState = deriveHealthState(rec);
  rec.updatedAt   = new Date().toISOString();
  return rec;
}

/**
 * Update health record after a fetch failure (all retries exhausted).
 *
 * @param {object} existing — current persisted health record (or null)
 * @param {Error}  err      — the error that caused the failure
 * @returns {object} updated health record
 */
function updateHealthOnFailure(existing, err) {
  var rec = Object.assign({}, existing || createHealthRecord());

  rec.totalFetches++;
  rec.totalFailures++;
  rec.consecutiveFailures++;
  rec.lastFetchTimestamp = new Date().toISOString();
  rec.lastFetchSuccess   = false;
  rec.lastErrorMessage   = (err && err.message)
    ? String(err.message).slice(0, 512)
    : 'unknown error';
  rec.lastErrorTimestamp = new Date().toISOString();

  // Mark stale-since on first failure (used for stale_cache state)
  if (!rec.staleSinceTimestamp) {
    rec.staleSinceTimestamp = new Date().toISOString();
  }

  rec.healthState = deriveHealthState(rec);
  rec.updatedAt   = new Date().toISOString();
  return rec;
}

/**
 * Update health record when stale cache is served to the caller.
 * Does not increment failure counts — the failure was already recorded separately.
 */
function updateHealthOnStaleCacheFallback(existing) {
  var rec = Object.assign({}, existing || createHealthRecord());
  rec.totalStaleCacheServes++;
  rec.updatedAt = new Date().toISOString();
  // State already set by updateHealthOnFailure — don't re-derive here
  return rec;
}

/**
 * Update health record on a Supabase cache hit (no upstream fetch needed).
 */
function updateHealthOnCacheHit(existing) {
  var rec = Object.assign({}, existing || createHealthRecord());
  rec.cacheHits++;
  rec.updatedAt = new Date().toISOString();
  return rec;
}

/**
 * Update health record on a Supabase cache miss (upstream fetch will follow).
 */
function updateHealthOnCacheMiss(existing) {
  var rec = Object.assign({}, existing || createHealthRecord());
  rec.cacheMisses++;
  rec.updatedAt = new Date().toISOString();
  return rec;
}

module.exports = {
  STATES:                           STATES,
  DEGRADED_FAILURE_THRESHOLD:       DEGRADED_FAILURE_THRESHOLD,
  OFFLINE_FAILURE_THRESHOLD:        OFFLINE_FAILURE_THRESHOLD,
  VALIDATION_FAILURE_RATE_LIMIT:    VALIDATION_FAILURE_RATE_LIMIT,
  createHealthRecord:               createHealthRecord,
  deriveHealthState:                deriveHealthState,
  updateHealthOnSuccess:            updateHealthOnSuccess,
  updateHealthOnFailure:            updateHealthOnFailure,
  updateHealthOnStaleCacheFallback: updateHealthOnStaleCacheFallback,
  updateHealthOnCacheHit:           updateHealthOnCacheHit,
  updateHealthOnCacheMiss:          updateHealthOnCacheMiss,
};
