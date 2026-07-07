'use strict';
// netlify/functions/cache-warmer.js
// Scheduled cache pre-warming function.
//
// Runs hourly (see netlify.toml schedule). Calls Argus's own Netlify Functions
// via HTTP so each function's full caching logic applies — if the cache is still
// fresh, the function returns immediately (0 external API calls). Only stale or
// absent cache entries trigger real upstream requests.
//
// Coverage:
//   - NOAA        — every run (15-min TTL, short stale window)
//   - ACLED       — every run (4h TTL; most runs are cache hits)
//   - GDACS       — every run (30-min TTL)
//   - Temperature — every run (2h TTL; alternating cache hit/miss — 3 Open-Meteo calls every 2h)
//   - Comtrade    — top 30 bilateral pairs × 2 years (7-day TTL; ~9 real calls/day)
//
// Temperature quota math:
//   2h TTL → 12 real fetches/day max. Each fetch = 2 Open-Meteo requests.
//   12 × 2 = 24 requests/day → well within the 10,000/day free tier limit.
//
// Comtrade quota math:
//   30 pairs × 2 years = 60 potential calls.
//   7-day TTL → each pair needs warming ~1×/week → ~60/7 ≈ 9 real calls/day.
//   Well within the 500 calls/day data-endpoint limit.
//
// Env: URL (set automatically by Netlify — base URL of the deployed site)

const SITE_URL = (process.env.URL || '').replace(/\/$/, '');

// Fetch timeout for warming calls (each warming call is to our own functions,
// which have their own upstream timeouts — this is a safety net).
const WARM_TIMEOUT_MS = 28000;

// ── Top bilateral trade pairs to pre-warm ─────────────────────────────────────
// Covers G7 intra-trade, major China bilateral, key Asia-Pacific, and EU core.
// Ordered roughly by global trade volume. Both directions are covered by
// Comtrade's flowCode=M,X, so reporter/partner ordering doesn't double the calls.
const TOP_PAIRS = [
  // USA bilateral
  ['USA', 'CHN'], ['USA', 'MEX'], ['USA', 'CAN'], ['USA', 'DEU'],
  ['USA', 'JPN'], ['USA', 'GBR'], ['USA', 'KOR'], ['USA', 'IND'],
  ['USA', 'FRA'], ['USA', 'ITA'],
  // China bilateral
  ['CHN', 'DEU'], ['CHN', 'JPN'], ['CHN', 'KOR'], ['CHN', 'AUS'],
  ['CHN', 'RUS'], ['CHN', 'BRA'], ['CHN', 'IND'], ['CHN', 'SGP'],
  // European core
  ['DEU', 'FRA'], ['DEU', 'GBR'], ['DEU', 'ITA'], ['DEU', 'NLD'],
  ['FRA', 'GBR'], ['FRA', 'ITA'],
  // Asia-Pacific
  ['JPN', 'KOR'], ['JPN', 'AUS'], ['IND', 'ARE'],
  // Russia
  ['RUS', 'DEU'], ['RUS', 'CHN'],
  // Middle East
  ['SAU', 'USA'],
];

// Two most recent years with complete Comtrade data
const TRADE_YEARS = ['2023', '2022'];

const CORS_HEADERS = {
  'Content-Type': 'application/json',
};

// ── Warm a single endpoint ────────────────────────────────────────────────────
async function warmEndpoint(path, label) {
  if (!SITE_URL) {
    console.warn('[cache-warmer] SITE_URL not set — cannot warm ' + label);
    return { label, status: 'skipped', reason: 'no SITE_URL' };
  }

  const url = SITE_URL + '/.netlify/functions/' + path;
  const t0  = Date.now();

  try {
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, WARM_TIMEOUT_MS);

    var res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal:  controller.signal,
    });
    clearTimeout(timer);

    var body = await res.json().catch(function() { return {}; });
    var latency = Date.now() - t0;
    var fromCache = body.cached === true;
    var degraded  = body.degraded === true;

    console.log('[cache-warmer]', label,
      '— HTTP ' + res.status,
      fromCache ? '(cache hit)' : '(cache miss — refreshed)',
      degraded ? '[DEGRADED]' : '',
      latency + 'ms'
    );

    return { label, status: res.status, fromCache, degraded, latencyMs: latency };
  } catch (err) {
    var elapsed = Date.now() - t0;
    console.error('[cache-warmer] failed to warm ' + label + ':', err.message, elapsed + 'ms');
    return { label, status: 'error', error: err.message, latencyMs: elapsed };
  }
}

// ── Handler (scheduled function) ─────────────────────────────────────────────
exports.handler = async function(event) {
  // Netlify scheduled functions pass { schedule: '...' } in the event body.
  // Also accept manual HTTP invocation for testing.
  var startMs = Date.now();
  console.log('[cache-warmer] starting pre-warm run at', new Date().toISOString());

  var results = [];

  // ── Phase 1: Single-key endpoints (NOAA, ACLED, GDACS, Temperature) ─────────
  // Run in parallel — these are independent and have their own caching.
  var phase1 = await Promise.allSettled([
    warmEndpoint('fetch-noaa',        'NOAA'),
    warmEndpoint('fetch-acled',       'ACLED'),
    warmEndpoint('fetch-gdacs',       'GDACS'),
    warmEndpoint('fetch-temperature', 'TEMPERATURE'),
  ]);

  for (var r of phase1) {
    results.push(r.status === 'fulfilled' ? r.value : { status: 'error', error: r.reason });
  }

  // ── Phase 2: Comtrade bilateral pairs ─────────────────────────────────────
  // Sequential with short gaps to respect Comtrade's rate limits.
  // Each call hits our own function — cache hits return immediately (no API call).
  // Only stale pairs actually call Comtrade. With 7-day TTL, most will be hits.
  var comtradeMissCount = 0;
  var COMTRADE_GAP_MS = 500; // gap between real API calls (only non-cache-hit calls matter)

  for (var pi = 0; pi < TOP_PAIRS.length; pi++) {
    var pair = TOP_PAIRS[pi];
    var reporter = pair[0];
    var partner  = pair[1];

    for (var yi = 0; yi < TRADE_YEARS.length; yi++) {
      var year = TRADE_YEARS[yi];
      var path = 'fetch-comtrade?reporter=' + reporter + '&partner=' + partner + '&year=' + year;
      var label = reporter + '→' + partner + '/' + year;

      var result = await warmEndpoint(path, label);
      results.push(result);

      // If this was a real Comtrade API call (cache miss), add a gap before the next
      if (!result.fromCache) {
        comtradeMissCount++;
        if (comtradeMissCount < TOP_PAIRS.length * TRADE_YEARS.length) {
          await new Promise(function(resolve) { setTimeout(resolve, COMTRADE_GAP_MS); });
        }
      }
    }
  }

  var totalMs = Date.now() - startMs;
  var cacheHits   = results.filter(function(r) { return r.fromCache; }).length;
  var cacheMisses = results.filter(function(r) { return r.fromCache === false; }).length;
  var errors      = results.filter(function(r) { return r.status === 'error'; }).length;

  console.log('[cache-warmer] run complete —',
    'total=' + results.length,
    'hits=' + cacheHits,
    'misses=' + cacheMisses,
    'errors=' + errors,
    'elapsed=' + totalMs + 'ms'
  );

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      ts:         Date.now(),
      elapsedMs:  totalMs,
      cacheHits:  cacheHits,
      cacheMisses: cacheMisses,
      errors:     errors,
      results:    results,
    }),
  };
};
