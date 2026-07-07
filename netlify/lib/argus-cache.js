'use strict';
// netlify/lib/argus-cache.js
// Shared SWR cache utility for Argus Netlify Functions.
//
// Implements:
//   1. Shared Supabase-backed SWR cache — TTL + configurable stale windows
//   2. In-memory request coalescing — deduplicates within warm Lambda instances
//   3. Cross-instance coordination via "recently written" window check
//
// Notes on Lambda concurrency:
//   In-memory coalescing (withCoalescing) is effective for sequential warm
//   invocations of the SAME Lambda instance. Truly concurrent requests from
//   different users are typically handled by DIFFERENT Lambda instances and do
//   NOT share in-memory state. The wasRecentlyWritten check in readCache() is
//   the cross-instance mechanism: if another instance wrote to the cache within
//   COALESCE_WINDOW_MS, this instance treats that as a coalesced result and
//   serves it without firing a duplicate external call.
//
// Usage:
//   const Cache = require('../lib/argus-cache');
//   const cached = await Cache.readCache(supabase, key, Cache.TTL.NOAA, Cache.STALE.NOAA);
//   if (cached.isFresh || cached.wasRecentlyWritten) return serveCached(cached.payload);
//   const data = await Cache.withCoalescing(key, fetchFn);
//   await Cache.writeCache(supabase, key, data);

const CACHE_TABLE = 'argus_cache';

// ── TTL constants (authoritative source — functions import these) ─────────────
// These match the polling cadence of frontend modules so the shared Supabase
// cache acts as the effective rate gate for all users combined.
const TTL = {
  NOAA:        15 * 60 * 1000,              // 15 min — NWS/NHC weather alerts
  ACLED:        4 * 60 * 60 * 1000,        // 4h — armed conflict events
  GDACS:       30 * 60 * 1000,              // 30 min — global disaster alerts
  EONET:       15 * 60 * 1000,              // 15 min — NASA Earth events
  COMTRADE:     7 * 24 * 60 * 60 * 1000,  // 7 days — annual trade data
  RELIEFWEB:    1 * 60 * 60 * 1000,        // 1h — relief operations
  UNHCR:       24 * 60 * 60 * 1000,        // 24h — refugee/displacement data
  TEMPERATURE:  2 * 60 * 60 * 1000,        // 2h — global temperature grid (Open-Meteo)
};

// ── Stale window constants ────────────────────────────────────────────────────
// How long past the TTL a cached payload may still be served on upstream
// failure (429, network error, etc.). Chosen relative to source update cadence.
//   NOAA: 2h — major weather systems persist; 15-min-old NWS data is still useful
//   ACLED: 24h — historical conflict records; a 4h cache expiry is conservative
//   GDACS: 4h — disaster events are rarely retracted; stale is better than nothing
//   COMTRADE: 30d — annual trade statistics; year-old data is still accurate
const STALE = {
  NOAA:         2 * 60 * 60 * 1000,        // 2h
  ACLED:       24 * 60 * 60 * 1000,        // 24h
  GDACS:        4 * 60 * 60 * 1000,        // 4h (matches existing staleCachePolicy)
  EONET:        4 * 60 * 60 * 1000,        // 4h
  COMTRADE:    30 * 24 * 60 * 60 * 1000,  // 30 days
  RELIEFWEB:    6 * 60 * 60 * 1000,        // 6h
  UNHCR:       72 * 60 * 60 * 1000,        // 72h
  TEMPERATURE:  6 * 60 * 60 * 1000,        // 6h — temperature heatmap can tolerate a few hours stale
};

// If another instance wrote to the same cache key within this window, treat the
// result as a coalesced hit — no need to fire another external API call.
const COALESCE_WINDOW_MS = 60 * 1000; // 60s

// ── readCache ─────────────────────────────────────────────────────────────────
// Always returns a result object with these guaranteed fields (never throws):
//   payload            — the cached data, or null if absent
//   ageMs              — milliseconds since last write (Infinity if absent)
//   isFresh            — age < ttlMs
//   isStale            — age >= ttlMs AND age < staleTtlMs
//   hasData            — payload is non-null
//   wasRecentlyWritten — another Lambda instance may have just written this key
//                        (age < COALESCE_WINDOW_MS — cross-instance coordination)
async function readCache(supabase, key, ttlMs, staleTtlMs) {
  try {
    var result = await supabase
      .from(CACHE_TABLE)
      .select('payload, updated_at')
      .eq('key', key)
      .single();

    if (result.error || !result.data || !result.data.payload) {
      return _miss();
    }

    var ageMs = Date.now() - new Date(result.data.updated_at).getTime();

    return {
      payload:            result.data.payload,
      ageMs:              ageMs,
      isFresh:            ageMs < ttlMs,
      isStale:            ageMs >= ttlMs && ageMs < (staleTtlMs || 0),
      hasData:            true,
      wasRecentlyWritten: ageMs < COALESCE_WINDOW_MS,
    };
  } catch (err) {
    console.warn('[argus-cache] readCache error key=' + key + ':', err.message);
    return _miss();
  }
}

function _miss() {
  return {
    payload: null, ageMs: Infinity,
    isFresh: false, isStale: false,
    hasData: false, wasRecentlyWritten: false,
  };
}

// ── writeCache ────────────────────────────────────────────────────────────────
// Silent failure — cache write errors never propagate to callers.
async function writeCache(supabase, key, payload) {
  try {
    var result = await supabase
      .from(CACHE_TABLE)
      .upsert(
        { key: key, payload: payload, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
    if (result.error) {
      console.warn('[argus-cache] writeCache error key=' + key + ':', result.error.message);
    }
  } catch (err) {
    console.warn('[argus-cache] writeCache exception key=' + key + ':', err.message);
  }
}

// ── withCoalescing ────────────────────────────────────────────────────────────
// In-memory deduplication for concurrent calls within the same Lambda instance.
// If asyncFn is already in flight for this key, subsequent callers await the
// same promise rather than spawning duplicate external API calls.
// The map is module-level — shared across warm invocations of the same instance.
var _inflight = new Map();

function withCoalescing(key, asyncFn) {
  if (_inflight.has(key)) {
    return _inflight.get(key);
  }
  var promise = asyncFn().finally(function() {
    _inflight.delete(key);
  });
  _inflight.set(key, promise);
  return promise;
}

module.exports = {
  TTL:                TTL,
  STALE:              STALE,
  COALESCE_WINDOW_MS: COALESCE_WINDOW_MS,
  readCache:          readCache,
  writeCache:         writeCache,
  withCoalescing:     withCoalescing,
};
