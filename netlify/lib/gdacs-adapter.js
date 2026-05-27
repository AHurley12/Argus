'use strict';
// netlify/lib/gdacs-adapter.js
// GDACS source adapter — defines all operational contracts for GDACS ingestion.
//
// Responsibilities:
//   - endpoint definitions and URL construction
//   - source identity and version metadata
//   - polling interval and cache TTL policy
//   - retry and backoff policy
//   - stale-cache policy
//   - supported event type enumeration and canonical mapping
//   - rate-limit awareness
//   - health state definitions
//
// This module is PURE CONFIGURATION. No fetch, cache, render, or UI logic.
// All ingestion layers consume this adapter — changes here propagate cleanly.

// ── API endpoint ─────────────────────────────────────────────────────────────────
// SEARCH mode provides full feature metadata (severity, population, datemodified, etc.)
// MAP mode provides fewer fields — avoid for ingestion pipelines that need full context.
var GDACS_API_BASE = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH';

// ── Canonical event type mappings ─────────────────────────────────────────────────
// Maps GDACS native event type codes → ARGUS canonical category strings.
// New GDACS event types must be added here — unknown types fall through to 'other'.
var EVENT_TYPE_MAP = {
  EQ: 'earthquake',
  TC: 'tropical_cyclone',
  FL: 'flood',
  VO: 'volcano',
  DR: 'drought',
  WF: 'wildfire',
  TS: 'tsunami',
};

// ── Canonical alert level mappings ────────────────────────────────────────────────
// Maps GDACS native alert levels → ARGUS canonical severity strings.
var ALERT_LEVEL_MAP = {
  Red:    'red',
  Orange: 'orange',
  Green:  'green',
};

// ── Lookback window ───────────────────────────────────────────────────────────────
// How many days back to query for events. GDACS maintains events over weeks;
// 30-day window captures all active incidents without over-fetching history.
var LOOKBACK_DAYS = 30;

// ── Primary adapter contract ─────────────────────────────────────────────────────
var ADAPTER = {

  // ── Source identity ─────────────────────────────────────────────────────────────
  sourceId:       'gdacs',
  sourceName:     'Global Disaster Alert and Coordination System',
  sourceProvider: 'EU Joint Research Centre / United Nations OCHA',
  sourceUrl:      'https://www.gdacs.org',
  schemaVersion:  '1.0.0',

  // ── Cache configuration ──────────────────────────────────────────────────────────
  // GDACS updates active events approximately every 30 minutes.
  // TTL is matched to update cadence to avoid serving stale data on active events.
  cacheTTLMs:      30 * 60 * 1000,   // 30 minutes — matches GDACS update cadence
  staleCacheTTLMs:  4 * 60 * 60 * 1000,  // 4 hours — max stale fallback window

  // ── Polling configuration ────────────────────────────────────────────────────────
  // Polling interval = cache TTL (fetch only when cache is expired).
  // Controlled by the cache freshness check in the handler — no independent timer.
  pollingIntervalMs: 30 * 60 * 1000,

  // ── Fetch configuration ──────────────────────────────────────────────────────────
  // 20s timeout — GDACS API can be slow during high-demand disaster events.
  // Netlify function timeout is 26s — 20s fetch leaves 6s for processing + Supabase.
  fetchTimeoutMs: 20000,

  // ── Retry policy ─────────────────────────────────────────────────────────────────
  // 3 attempts with exponential backoff. Total worst-case: ~1s + ~2s + fetch = ~23s.
  // Only retry on transient server errors (5xx, 429). Client errors (4xx) are not retried.
  retryPolicy: {
    maxAttempts:       3,
    initialBackoffMs:  1000,
    backoffMultiplier: 2,
    maxBackoffMs:      8000,
    retryableStatusCodes: [429, 500, 502, 503, 504],
  },

  // ── Stale-cache policy ────────────────────────────────────────────────────────────
  // On fetch failure: serve expired cache if available (up to staleCacheTTLMs).
  // On validation failure: do NOT serve stale — schema breakage indicates structural change.
  staleCachePolicy: {
    serveOnFetchFailure:       true,   // upstream unreachable → stale is better than empty
    serveOnValidationFailure:  false,  // schema change → stale is dangerous, serve empty
    maxStaleDurationMs:        4 * 60 * 60 * 1000,
  },

  // ── Rate-limit awareness ──────────────────────────────────────────────────────────
  // GDACS is a free public API with no published rate limits.
  // Conservative policy: max 4 requests/minute. The 30m TTL means ~2/hour normally.
  rateLimitPolicy: {
    requestsPerMinute: 4,
    respectRetryAfter: true,
  },

  // ── Supported event types ─────────────────────────────────────────────────────────
  supportedEventTypes: Object.keys(EVENT_TYPE_MAP),

  // ── Event query configuration ─────────────────────────────────────────────────────
  defaultEventTypes:  'EQ,TC,FL,VO,DR,WF',
  defaultAlertLevels: 'Green,Orange,Red',
  defaultLimit:       100,
  lookbackDays:       LOOKBACK_DAYS,

  // ── Supabase storage keys ─────────────────────────────────────────────────────────
  cacheTable:  'argus_cache',
  cacheKey:    'gdacs_events_v1',
  healthKey:   'gdacs_health_v1',

  // ── Health state enumeration ──────────────────────────────────────────────────────
  healthStates: {
    HEALTHY:            'healthy',
    DEGRADED:           'degraded',
    STALE_CACHE:        'stale_cache',
    RETRYING:           'retrying',
    OFFLINE:            'offline',
    VALIDATION_FAILURE: 'validation_failure',
  },

  // ── API endpoint builder ──────────────────────────────────────────────────────────
  // Builds a complete GDACS SEARCH URL with all required parameters.
  // Accepts optional overrides for event types, alert levels, date range, and limit.
  buildEndpoint: function(opts) {
    opts = opts || {};

    var now = new Date();
    var from = new Date(now.getTime() - (opts.lookbackDays || LOOKBACK_DAYS) * 24 * 60 * 60 * 1000);

    var fromDate = from.toISOString().slice(0, 10);  // YYYY-MM-DD
    var toDate   = now.toISOString().slice(0, 10);

    return GDACS_API_BASE
      + '?eventtypes=' + (opts.eventTypes  || ADAPTER.defaultEventTypes)
      + '&alertlevel=' + (opts.alertLevels || ADAPTER.defaultAlertLevels)
      + '&fromdate='   + fromDate
      + '&todate='     + toDate
      + '&limit='      + (opts.limit       || ADAPTER.defaultLimit);
  },

  // ── Canonical lookup helpers ──────────────────────────────────────────────────────

  canonicalCategory: function(eventTypeCode) {
    return EVENT_TYPE_MAP[String(eventTypeCode || '').toUpperCase()] || 'other';
  },

  canonicalSeverity: function(alertLevel) {
    return ALERT_LEVEL_MAP[alertLevel] || 'unknown';
  },
};

module.exports = ADAPTER;
