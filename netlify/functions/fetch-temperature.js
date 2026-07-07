'use strict';
// netlify/functions/fetch-temperature.js
// Global temperature grid via Open-Meteo forecast API.
//
// Fetches current temperature (temperature_2m, °C) at 648 grid points on a
// 10° lat/lon spacing grid. The result feeds the client-side temperature
// heatmap overlay (modules/argusTemperatureLayer.js).
//
// Grid: 10° spacing, points centered in each 10° cell.
//   Latitudes:  85, 75, ..., -85  (18 rows, north to south)
//   Longitudes: -175, -165, ..., 175  (36 cols, west to east)
//   Total: 18 × 36 = 648 grid points
//
// Batching: 648 points split into 2 requests of 324 each.
//   URL length per batch: ≈ 3,400 chars (well under the 8,000-char proxy limit).
//   A 250ms gap between batches is polite but rarely needed at 2h cache TTL.
//
// Open-Meteo:
//   Free for non-commercial use (CC BY 4.0 — attribution required).
//   Rate limits: 600 calls/min, 5,000/hour, 10,000/day (free tier).
//   With 2h TTL the cache warmer triggers at most 3 calls per 2h = 36/day.
//   COMMERCIAL USE: If Argus is a commercial product, upgrade to a paid plan:
//     https://open-meteo.com/en/pricing
//   Docs: https://open-meteo.com/en/docs
//
// Cache TTL: 2h (Cache.TTL.TEMPERATURE) — global temperature patterns at
//   10° resolution change slowly; stale by 6h before fallback (Cache.STALE.TEMPERATURE).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

const { createClient } = require('@supabase/supabase-js');
const Cache = require('../lib/argus-cache');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const CACHE_KEY   = 'temperature_grid_v1';
const TTL_MS      = Cache.TTL.TEMPERATURE;
const STALE_MS    = Cache.STALE.TEMPERATURE;

// 2 batches of 324 keeps each request URL under 3,500 chars.
// Open-Meteo batch format: ?latitude=L1,L2,...&longitude=O1,O2,...&current=temperature_2m
const BATCH_SIZE     = 324;
const INTER_BATCH_MS = 250; // polite gap between the two Open-Meteo requests

const OPENMETEO_BASE = 'https://api.open-meteo.com/v1/forecast';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── Grid generation ────────────────────────────────────────────────────────────
// Points ordered north-to-south, west-to-east so the client canvas can draw them
// directly: canvas row 0 = lat 85 (north), canvas col 0 = lon -175 (west).
function buildGrid() {
  var points = [];
  for (var lat = 85; lat >= -85; lat -= 10) {
    for (var lon = -175; lon <= 175; lon += 10) {
      points.push({ lat: lat, lon: lon });
    }
  }
  return points; // 18 × 36 = 648 points
}

// ── Single Open-Meteo batch fetch ─────────────────────────────────────────────
// points[i].lat and points[i].lon must pair at the same index.
// Returns [{ lat, lon, t }] where t is temperature_2m in °C (null on missing data).
async function fetchBatch(points) {
  var lats = points.map(function(p) { return p.lat; }).join(',');
  var lons = points.map(function(p) { return p.lon; }).join(',');
  var url  = OPENMETEO_BASE +
    '?latitude='  + lats +
    '&longitude=' + lons +
    '&current=temperature_2m';

  var signal = AbortSignal.timeout ? AbortSignal.timeout(25000) : undefined;
  var res    = await fetch(url, { headers: { 'Accept': 'application/json' }, signal });

  if (res.status === 429) {
    throw Object.assign(new Error('Open-Meteo rate limit exceeded'), { status: 429 });
  }
  if (!res.ok) {
    throw new Error('Open-Meteo HTTP ' + res.status);
  }

  var json = await res.json();
  // Multi-coord requests return an array; single-coord returns a plain object.
  var results = Array.isArray(json) ? json : [json];

  return results.map(function(r, i) {
    var t = (r && r.current && r.current.temperature_2m !== undefined)
      ? r.current.temperature_2m
      : null;
    return { lat: points[i].lat, lon: points[i].lon, t: t };
  });
}

// ── Full 648-point grid fetch ──────────────────────────────────────────────────
async function fetchTemperatureGrid() {
  var allPoints = buildGrid();
  var grid      = [];

  for (var i = 0; i < allPoints.length; i += BATCH_SIZE) {
    var batch = allPoints.slice(i, i + BATCH_SIZE);

    if (i > 0) {
      await new Promise(function(resolve) { setTimeout(resolve, INTER_BATCH_MS); });
    }

    var batchResult = await fetchBatch(batch);
    for (var j = 0; j < batchResult.length; j++) {
      grid.push(batchResult[j]);
    }
  }

  var nullCount = grid.filter(function(p) { return p.t === null; }).length;
  if (nullCount > 0) {
    console.warn('[fetch-temperature] ' + nullCount + ' null readings in grid');
  }

  return { grid: grid, ts: Date.now(), count: grid.length, source: 'open-meteo' };
}

// ── Handler ────────────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // ── Cache read ─────────────────────────────────────────────────────────────
  const cached = await Cache.readCache(supabase, CACHE_KEY, TTL_MS, STALE_MS);

  if (cached.isFresh) {
    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=3600' },
      body: JSON.stringify({ ...cached.payload, cached: true }),
    };
  }

  // Cross-instance coalescing: another Lambda wrote within COALESCE_WINDOW_MS
  if (cached.wasRecentlyWritten && cached.hasData) {
    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=3600' },
      body: JSON.stringify({ ...cached.payload, cached: true }),
    };
  }

  // ── Fetch ──────────────────────────────────────────────────────────────────
  let payload;
  try {
    payload = await Cache.withCoalescing(CACHE_KEY, fetchTemperatureGrid);
  } catch (err) {
    const isRateLimit = err.status === 429;

    if (isRateLimit) {
      console.error('[fetch-temperature] Open-Meteo rate limit hit —',
        cached.hasData
          ? 'serving stale (age=' + Math.round((cached.ageMs || 0) / 60000) + 'min)'
          : 'no cached data available');
    } else {
      console.error('[fetch-temperature] upstream fetch failed:', err.message);
    }

    if (cached.isStale && cached.hasData) {
      return {
        statusCode: 200,
        headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' },
        body: JSON.stringify({
          ...cached.payload,
          cached:     true,
          degraded:   true,
          staleAgeMs: cached.ageMs,
          error:      isRateLimit ? 'upstream_rate_limit' : 'upstream_error',
        }),
      };
    }

    return {
      statusCode: isRateLimit ? 429 : 502,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error:   'Temperature data unavailable',
        message: err.message,
      }),
    };
  }

  // ── Cache write ────────────────────────────────────────────────────────────
  await Cache.writeCache(supabase, CACHE_KEY, payload);

  console.log('[fetch-temperature] cached', payload.count, 'grid points (10° grid, 2h TTL)');

  return {
    statusCode: 200,
    headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=3600' },
    body: JSON.stringify(payload),
  };
};
