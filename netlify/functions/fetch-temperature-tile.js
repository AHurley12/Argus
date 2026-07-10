'use strict';
// netlify/functions/fetch-temperature-tile.js
// Variable-resolution temperature tile proxy for the Argus LOD weather system.
//
// The global 10° base layer is still served by fetch-temperature.js (unchanged).
// This function handles finer viewport tiles requested by argusTemperatureLayer.js
// when the camera zooms into a region.
//
// Query params:
//   latMin  — southern bound (clamped to −85..85)
//   latMax  — northern bound (clamped to −85..85)
//   lonMin  — western bound  (clamped to −180..180)
//   lonMax  — eastern bound  (clamped to −180..180)
//   res     — degrees per sample: 1, 2, or 5 (default 5)
//             (10° is handled by fetch-temperature.js)
//
// Cache TTL by resolution (shorter for finer — data changes more meaningfully):
//   5°: 1h   — continental view; temperature patterns shift slowly
//   2°: 30min — regional view; local fronts / diurnal changes visible
//   1°: 15min — city view; highest practical fidelity, fastest refresh
//
// Max points per resolution (prevents runaway Open-Meteo calls):
//   5°: 2,500 pts  (~79°×79° bbox at 5° spacing)
//   2°: 1,600 pts  (~40°×40° bbox at 2° spacing)
//   1°: 1,600 pts  (~40°×40° bbox at 1° spacing)
//
// Batching: split into groups of 300 to keep Open-Meteo URL length
//   under ~3,200 chars. 200ms gap between batches respects rate limits.
//
// Cache key: temp_tile_v2_{res}_{latMin}_{latMax}_{lonMin}_{lonMax}
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

const { createClient } = require('@supabase/supabase-js');
const Cache = require('../lib/argus-cache');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const OPENMETEO_BASE = 'https://api.open-meteo.com/v1/forecast';
const BATCH_SIZE     = 300;   // points per Open-Meteo request
const INTER_BATCH_MS = 200;   // polite gap between batches (ms)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

// Per-resolution config: cache TTL, stale window, and max allowed point count.
var RES_CONFIG = {
  5: { ttlMs: 60 * 60 * 1000,   staleMs: 3 * 60 * 60 * 1000, maxPts: 2500 },
  2: { ttlMs: 30 * 60 * 1000,   staleMs: 2 * 60 * 60 * 1000, maxPts: 1600 },
  1: { ttlMs: 15 * 60 * 1000,   staleMs:     60 * 60 * 1000,  maxPts: 1600 },
};

// ── Grid builder ───────────────────────────────────────────────────────────────
// Samples at every `res` degrees within the bbox. Steps north-to-south,
// west-to-east — matches the client canvas draw direction.
// toFixed(6) prevents floating-point drift on repeated addition.
function buildGrid(latMin, latMax, lonMin, lonMax, res) {
  var pts      = [];
  var latStart = Math.ceil(latMax  / res) * res;   // first sample ≤ latMax
  var lonStart = Math.ceil(lonMin  / res) * res;   // first sample ≥ lonMin
  for (var lat = latStart; lat >= latMin; lat = +((lat - res).toFixed(6))) {
    for (var lon = lonStart; lon <= lonMax; lon = +((lon + res).toFixed(6))) {
      pts.push({ lat: +lat.toFixed(6), lon: +lon.toFixed(6) });
    }
  }
  return pts;
}

// ── Single Open-Meteo batch ────────────────────────────────────────────────────
async function fetchBatch(points) {
  var lats   = points.map(function(p) { return p.lat; }).join(',');
  var lons   = points.map(function(p) { return p.lon; }).join(',');
  var url    = OPENMETEO_BASE +
    '?latitude='  + lats +
    '&longitude=' + lons +
    '&current=temperature_2m';
  var signal = AbortSignal.timeout ? AbortSignal.timeout(25000) : undefined;
  var res    = await fetch(url, { headers: { 'Accept': 'application/json' }, signal });

  if (res.status === 429) throw Object.assign(new Error('rate_limit'), { status: 429 });
  if (!res.ok)            throw new Error('Open-Meteo HTTP ' + res.status);

  var json    = await res.json();
  var results = Array.isArray(json) ? json : [json];

  return results.map(function(r, i) {
    var t = (r && r.current && r.current.temperature_2m !== undefined)
      ? r.current.temperature_2m : null;
    return { lat: points[i].lat, lon: points[i].lon, t: t };
  });
}

// ── Full tile fetch (batched) ──────────────────────────────────────────────────
async function fetchTile(points) {
  var grid = [];
  for (var i = 0; i < points.length; i += BATCH_SIZE) {
    if (i > 0) await new Promise(function(r) { setTimeout(r, INTER_BATCH_MS); });
    var batch  = points.slice(i, i + BATCH_SIZE);
    var result = await fetchBatch(batch);
    for (var j = 0; j < result.length; j++) grid.push(result[j]);
  }
  return grid;
}

// ── Cache key ──────────────────────────────────────────────────────────────────
function makeCacheKey(res, latMin, latMax, lonMin, lonMax) {
  return 'temp_tile_v2_' + res + '_' + latMin + '_' + latMax + '_' + lonMin + '_' + lonMax;
}

// ── Handler ────────────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  var q      = event.queryStringParameters || {};
  var latMin = parseFloat(q.latMin);
  var latMax = parseFloat(q.latMax);
  var lonMin = parseFloat(q.lonMin);
  var lonMax = parseFloat(q.lonMax);
  var res    = parseInt(q.res, 10) || 5;

  // ── Param validation ───────────────────────────────────────────────────────
  if (isNaN(latMin) || isNaN(latMax) || isNaN(lonMin) || isNaN(lonMax)) {
    return { statusCode: 400, headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'latMin, latMax, lonMin, lonMax are required' }) };
  }
  if (!RES_CONFIG[res]) {
    return { statusCode: 400, headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'res must be 1, 2, or 5' }) };
  }

  // Clamp to valid geographic range (avoid exact poles — Open-Meteo quirky there)
  latMin = Math.max(-85, Math.min(85,   latMin));
  latMax = Math.max(-85, Math.min(85,   latMax));
  lonMin = Math.max(-180, Math.min(180, lonMin));
  lonMax = Math.max(-180, Math.min(180, lonMax));

  if (latMin >= latMax || lonMin >= lonMax) {
    return { statusCode: 400, headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Invalid bounding box' }) };
  }

  var cfg    = RES_CONFIG[res];
  var points = buildGrid(latMin, latMax, lonMin, lonMax, res);

  // Guard against runaway requests (large bbox at fine resolution)
  if (points.length > cfg.maxPts) {
    return { statusCode: 400, headers: CORS_HEADERS,
      body: JSON.stringify({
        error:     'Bounding box too large for this resolution — reduce bbox or increase res',
        requested: points.length,
        max:       cfg.maxPts,
      }) };
  }

  var key      = makeCacheKey(res, latMin, latMax, lonMin, lonMax);
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // ── Cache read ─────────────────────────────────────────────────────────────
  const cached = await Cache.readCache(supabase, key, cfg.ttlMs, cfg.staleMs);

  if (cached.isFresh || cached.wasRecentlyWritten) {
    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=900' },
      body: JSON.stringify({ ...cached.payload, cached: true }),
    };
  }

  // ── Fetch ──────────────────────────────────────────────────────────────────
  var grid;
  try {
    grid = await Cache.withCoalescing(key, function() { return fetchTile(points); });
  } catch (err) {
    // Serve stale on upstream failure rather than a hard error
    if (cached.isStale && cached.hasData) {
      return {
        statusCode: 200,
        headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' },
        body: JSON.stringify({ ...cached.payload, cached: true, degraded: true }),
      };
    }
    console.error('[fetch-temperature-tile] fetch failed:', err.message);
    return {
      statusCode: err.status === 429 ? 429 : 502,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Temperature tile unavailable', message: err.message }),
    };
  }

  var payload = {
    grid:       grid,
    bbox:       { latMin: latMin, latMax: latMax, lonMin: lonMin, lonMax: lonMax },
    resolution: res,
    count:      grid.length,
    ts:         Date.now(),
    source:     'open-meteo',
  };

  await Cache.writeCache(supabase, key, payload);

  console.log('[fetch-temperature-tile]', grid.length, 'pts at', res + '° —',
    latMin + '–' + latMax + 'N', lonMin + '–' + lonMax + 'E');

  return {
    statusCode: 200,
    headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=900' },
    body: JSON.stringify(payload),
  };
};
