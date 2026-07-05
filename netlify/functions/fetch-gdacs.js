'use strict';
// netlify/functions/fetch-gdacs.js
// GDACS global disaster intelligence ingestion function.
//
// Pipeline:
//   GDACSAdapter → FetchLayer → ValidationLayer → NormalizationLayer
//   → CacheLayer (Supabase argus_cache) → SourceHealthMonitor → UnifiedEventStore
//
// Failure isolation contract:
//   - GDACS failures never interrupt other ingestion sources
//   - Stale-cache fallback during upstream outages (up to 4h stale window)
//   - Per-event validation: individual failures skip that event, never collapse the cycle
//   - Response schema failure: returns empty events (no stale cache for schema breakage)
//   - Health state persisted across invocations via Supabase — observable without logs
//   - Always returns 200 (empty events on failure) — never 500 to the frontend
//
// Response shape:
//   {
//     events:      [...normalized ARGUS events],
//     source:      'gdacs',
//     cacheSource: 'live' | 'cache' | 'stale_cache' | 'empty',
//     ts:          epoch ms,
//     count:       number,
//     health:      { healthState, lastFetchLatencyMs, consecutiveFailures, ... }
//   }
//
// Env vars:
//   SUPABASE_URL         — required
//   SUPABASE_SERVICE_KEY — required
//   ENABLE_GDACS         — 'false' to disable (default: true)
//   GDACS_POLL_INTERVAL_MS — override cache TTL (default: 30 minutes)

const { createClient } = require('@supabase/supabase-js');
const ADAPTER     = require('../lib/gdacs-adapter');
const VALIDATOR   = require('../lib/gdacs-validator');
const NORMALIZER  = require('../lib/gdacs-normalizer');
const HEALTH      = require('../lib/gdacs-health');
const Cache       = require('../lib/argus-cache');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ENABLE_GDACS = (process.env.ENABLE_GDACS || 'true').toLowerCase() !== 'false';

// Allow TTL override for testing / rate-limit tuning — default from adapter
const CACHE_TTL_MS = parseInt(process.env.GDACS_POLL_INTERVAL_MS || '') || ADAPTER.cacheTTLMs;

const PREFIX = '[fetch-gdacs]';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type':                'application/json',
  'Cache-Control':               'public, max-age=1800, stale-while-revalidate=300',
};

// ── Cache Layer ───────────────────────────────────────────────────────────────────
// All Supabase operations are wrapped with silent failure — cache errors are
// never allowed to interrupt ingestion or produce 500s.

async function _cacheRead(supabase, key) {
  try {
    var result = await supabase
      .from(ADAPTER.cacheTable)
      .select('payload, updated_at')
      .eq('key', key)
      .single();
    if (result.error) {
      console.warn(PREFIX, 'cache read error for key=' + key + ':', result.error.message);
      return null;
    }
    return result.data;  // { payload, updated_at } or null
  } catch (err) {
    console.warn(PREFIX, 'cache read exception for key=' + key + ':', err.message);
    return null;
  }
}

async function _cacheWrite(supabase, key, payload) {
  try {
    var result = await supabase
      .from(ADAPTER.cacheTable)
      .upsert(
        { key: key, payload: payload, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
    if (result.error) {
      console.warn(PREFIX, 'cache write error for key=' + key + ':', result.error.message);
    }
  } catch (err) {
    console.warn(PREFIX, 'cache write exception for key=' + key + ':', err.message);
  }
}

// ── Fetch Layer ───────────────────────────────────────────────────────────────────
// Implements timeout protection, exponential backoff retry, and non-JSON detection.
// Returns { raw, latencyMs, attempts } on success.
// Throws on total exhaustion — caller decides on stale-cache vs empty response.

async function _fetchWithRetry(url) {
  var policy  = ADAPTER.retryPolicy;
  var backoff = policy.initialBackoffMs;
  var lastErr = null;

  for (var attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    var t0 = Date.now();
    try {
      var res = await fetch(url, {
        signal: AbortSignal.timeout(ADAPTER.fetchTimeoutMs),
        headers: {
          'User-Agent': 'ArgusIntelligence/1.0 (disaster-intelligence@argus.app)',
          'Accept':     'application/json',
        },
      });

      var latencyMs = Date.now() - t0;

      // Retry on transient server errors only
      if (!res.ok && policy.retryableStatusCodes.includes(res.status)) {
        lastErr = new Error('GDACS HTTP ' + res.status);
        console.warn(PREFIX, 'attempt', attempt + '/' + policy.maxAttempts,
          'HTTP ' + res.status + ' — retrying in ' + backoff + 'ms');
        if (attempt < policy.maxAttempts) await _sleep(backoff);
        backoff = Math.min(backoff * policy.backoffMultiplier, policy.maxBackoffMs);
        continue;
      }

      // Non-retryable HTTP error
      if (!res.ok) {
        throw new Error('GDACS HTTP ' + res.status + ' (non-retryable)');
      }

      // Read as text first — GDACS occasionally serves HTML error pages with 200 OK
      var text = await res.text();
      var raw;
      try {
        raw = JSON.parse(text);
      } catch (_) {
        throw new Error('GDACS non-JSON response (' + res.status + '): ' + text.slice(0, 160));
      }

      console.log(PREFIX, 'fetch succeeded —', latencyMs + 'ms, attempt ' + attempt);
      return { raw: raw, latencyMs: latencyMs, attempts: attempt };

    } catch (err) {
      lastErr = err;
      var elapsed = Date.now() - t0;
      var isLast  = attempt >= policy.maxAttempts;
      console.warn(PREFIX, 'attempt', attempt + '/' + policy.maxAttempts,
        'failed after ' + elapsed + 'ms:', err.message,
        isLast ? '— retries exhausted' : '— retrying in ' + backoff + 'ms');
      if (!isLast) await _sleep(backoff);
      backoff = Math.min(backoff * policy.backoffMultiplier, policy.maxBackoffMs);
    }
  }

  throw lastErr || new Error('GDACS fetch exhausted after ' + policy.maxAttempts + ' attempts');
}

function _sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// ── Ingestion Pipeline ────────────────────────────────────────────────────────────
// Orchestrates ValidationLayer + NormalizationLayer over the raw GDACS response.
// Returns { events, stats } — never throws; propagates only structural failures.

function _runIngestionPipeline(raw) {
  // ── Response-level validation ───────────────────────────────────────────────
  var responseCheck = VALIDATOR.validateResponse(raw);
  if (!responseCheck.valid) {
    // Structural failure — not a per-event issue. Throw so caller can decide.
    throw new Error('GDACS response validation failed: ' + responseCheck.errors.join('; '));
  }

  var stats = {
    totalFeatures:         responseCheck.featureCount,
    validFeatures:         0,
    validationFailures:    0,
    normalizationFailures: 0,
    duplicatesDropped:     0,
  };

  console.log(PREFIX, 'pipeline start —', stats.totalFeatures, 'features received');

  // ── Per-feature validation + normalization ──────────────────────────────────
  var events  = [];
  var seenIds = Object.create(null);  // eventId deduplication

  for (var i = 0; i < raw.features.length; i++) {
    var feature = raw.features[i];

    // Per-feature validation — errors skip the feature; never collapse the loop
    var check = VALIDATOR.validateFeature(feature);
    if (!check.valid) {
      stats.validationFailures++;
      var failId = (feature && feature.properties && feature.properties.eventid) || '?';
      console.warn(PREFIX, 'validation failed — eventid=' + failId + ':',
        check.errors.join('; '));
      continue;
    }
    stats.validFeatures++;

    // Normalization — returns null on internal error
    var normalized = NORMALIZER.normalizeFeature(feature, ADAPTER);
    if (!normalized) {
      stats.normalizationFailures++;
      continue;
    }

    // Deduplication — last-write-wins for same eventId within one fetch cycle
    if (seenIds[normalized.eventId]) {
      stats.duplicatesDropped++;
      continue;
    }
    seenIds[normalized.eventId] = true;

    events.push(normalized);
  }

  console.log(PREFIX,
    'pipeline complete — ' + events.length + ' events normalized,',
    stats.validationFailures + ' validation failures,',
    stats.normalizationFailures + ' normalization failures,',
    stats.duplicatesDropped + ' duplicates dropped'
  );

  return { events: events, stats: stats };
}

// ── Response builder helpers ──────────────────────────────────────────────────────

function _okResponse(body) {
  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

function _healthSummary(rec) {
  // Expose a minimal health snapshot in every response — supports frontend observability
  // without exposing full internal health record (which may be large).
  return {
    healthState:          rec.healthState,
    lastFetchTimestamp:   rec.lastFetchTimestamp,
    lastFetchLatencyMs:   rec.lastFetchLatencyMs,
    consecutiveFailures:  rec.consecutiveFailures,
    totalStaleCacheServes: rec.totalStaleCacheServes,
  };
}

// ── Main Handler ──────────────────────────────────────────────────────────────────

exports.handler = async function(event) {

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  // ── Feature gate ────────────────────────────────────────────────────────────
  if (!ENABLE_GDACS) {
    return _okResponse({ events: [], source: 'gdacs', cacheSource: 'disabled',
      disabled: true, ts: Date.now(), count: 0 });
  }

  // ── Supabase guard ───────────────────────────────────────────────────────────
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error(PREFIX, 'Supabase not configured — SUPABASE_URL or SUPABASE_SERVICE_KEY missing');
    return _okResponse({ events: [], source: 'gdacs', cacheSource: 'empty',
      error: 'Supabase not configured', ts: Date.now(), count: 0 });
  }

  var supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // ── Parallel cache reads: event data + health record ────────────────────────
  var cacheReads = await Promise.all([
    _cacheRead(supabase, ADAPTER.cacheKey),
    _cacheRead(supabase, ADAPTER.healthKey),
  ]);
  var dataRow    = cacheReads[0];
  var healthRow  = cacheReads[1];

  var healthRec = (healthRow && healthRow.payload)
    ? healthRow.payload
    : HEALTH.createHealthRecord();

  // ── Cache freshness check ────────────────────────────────────────────────────
  var cacheAgeMs = dataRow
    ? Date.now() - new Date(dataRow.updated_at).getTime()
    : Infinity;

  var isCacheFresh = dataRow && cacheAgeMs < CACHE_TTL_MS;

  if (isCacheFresh) {
    // Fresh cache — return immediately, no upstream contact needed
    healthRec = HEALTH.updateHealthOnCacheHit(healthRec);
    // Fire-and-forget health write — don't block the response
    _cacheWrite(supabase, ADAPTER.healthKey, healthRec).catch(function() {});

    console.log(PREFIX, 'cache hit — age=' + Math.round(cacheAgeMs / 1000) + 's,',
      (dataRow.payload.count || 0) + ' events');
    return _okResponse({
      events:      dataRow.payload.events || [],
      source:      'gdacs',
      cacheSource: 'cache',
      ts:          dataRow.payload.ts,
      count:       dataRow.payload.count || 0,
      health:      _healthSummary(healthRec),
    });
  }

  // Cache is stale or absent — proceed to fetch
  healthRec = HEALTH.updateHealthOnCacheMiss(healthRec);

  // ── Fetch Layer ──────────────────────────────────────────────────────────────
  var gdacsUrl    = ADAPTER.buildEndpoint();
  var fetchResult = null;
  var fetchErr    = null;

  console.log(PREFIX, 'cache miss (age=' + Math.round(cacheAgeMs / 60000) + 'min) — fetching GDACS');

  try {
    fetchResult = await Cache.withCoalescing(ADAPTER.cacheKey, function() {
      return _fetchWithRetry(gdacsUrl);
    });
  } catch (err) {
    fetchErr = err;
    // Distinct log format for quota exhaustion vs other failures
    if (err && (err.status === 429 || (err.message && err.message.includes('429')))) {
      console.error(PREFIX, '[QUOTA_EXHAUSTED] GDACS rate limit hit —',
        dataRow ? 'stale fallback available' : 'no cache available');
    } else {
      console.error(PREFIX, 'fetch failed:', err.message);
    }
  }

  // ── Fetch failure path ───────────────────────────────────────────────────────
  if (fetchErr) {
    healthRec = HEALTH.updateHealthOnFailure(healthRec, fetchErr);

    // Stale-cache fallback — serve expired data if within staleCacheTTLMs and non-empty
    var hasStaleEvents = dataRow &&
      dataRow.payload &&
      Array.isArray(dataRow.payload.events) &&
      dataRow.payload.events.length > 0;
    var staleWithinWindow = cacheAgeMs < ADAPTER.staleCachePolicy.maxStaleDurationMs;

    if (ADAPTER.staleCachePolicy.serveOnFetchFailure && hasStaleEvents && staleWithinWindow) {
      healthRec = HEALTH.updateHealthOnStaleCacheFallback(healthRec);
      await _cacheWrite(supabase, ADAPTER.healthKey, healthRec);

      console.warn(PREFIX, 'serving stale cache — age=' + Math.round(cacheAgeMs / 60000) + 'min,',
        dataRow.payload.events.length + ' events, health=' + healthRec.healthState);

      return _okResponse({
        events:      dataRow.payload.events,
        source:      'gdacs',
        cacheSource: 'stale_cache',
        ts:          dataRow.payload.ts,
        count:       dataRow.payload.events.length,
        staleAgeMs:  cacheAgeMs,
        error:       fetchErr.message,
        health:      _healthSummary(healthRec),
      });
    }

    // No usable stale cache — return empty (never 500)
    await _cacheWrite(supabase, ADAPTER.healthKey, healthRec);
    console.warn(PREFIX, 'no usable stale cache — returning empty,',
      'health=' + healthRec.healthState);

    return _okResponse({
      events:      [],
      source:      'gdacs',
      cacheSource: 'empty',
      ts:          Date.now(),
      count:       0,
      error:       fetchErr.message,
      health:      _healthSummary(healthRec),
    });
  }

  // ── Ingestion Pipeline ───────────────────────────────────────────────────────
  var pipelineResult = null;
  var pipelineErr    = null;

  try {
    pipelineResult = _runIngestionPipeline(fetchResult.raw);
  } catch (err) {
    pipelineErr = err;
    console.error(PREFIX, 'ingestion pipeline failed:', err.message);
  }

  // Pipeline failure = structural schema breakage.
  // Per staleCachePolicy: do NOT serve stale on schema failures (schema may be dangerously wrong).
  if (pipelineErr) {
    healthRec = HEALTH.updateHealthOnFailure(healthRec, pipelineErr);
    await _cacheWrite(supabase, ADAPTER.healthKey, healthRec);

    return _okResponse({
      events:      [],
      source:      'gdacs',
      cacheSource: 'empty',
      ts:          Date.now(),
      count:       0,
      error:       pipelineErr.message,
      health:      _healthSummary(healthRec),
    });
  }

  // ── Success path ─────────────────────────────────────────────────────────────

  healthRec = HEALTH.updateHealthOnSuccess(healthRec, {
    latencyMs:             fetchResult.latencyMs,
    eventCount:            pipelineResult.events.length,
    validationFailures:    pipelineResult.stats.validationFailures,
    normalizationFailures: pipelineResult.stats.normalizationFailures,
    retries:               fetchResult.attempts - 1,
  });

  // ── Write to UnifiedEventStore (argus_cache) ─────────────────────────────────
  var cachePayload = {
    events:  pipelineResult.events,
    source:  'gdacs',
    ts:      Date.now(),
    count:   pipelineResult.events.length,
    stats:   pipelineResult.stats,
  };

  // Parallel write — event data + health record in one round-trip
  await Promise.all([
    _cacheWrite(supabase, ADAPTER.cacheKey,  cachePayload),
    _cacheWrite(supabase, ADAPTER.healthKey, healthRec),
  ]);

  console.log(PREFIX,
    'ingestion complete — ' + pipelineResult.events.length + ' events cached,',
    'latency=' + fetchResult.latencyMs + 'ms,',
    'health=' + healthRec.healthState
  );

  return _okResponse({
    events:      pipelineResult.events,
    source:      'gdacs',
    cacheSource: 'live',
    ts:          cachePayload.ts,
    count:       pipelineResult.events.length,
    health:      _healthSummary(healthRec),
  });
};
