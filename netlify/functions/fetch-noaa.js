// netlify/functions/fetch-noaa.js
// NOAA environmental and weather intelligence proxy.
//
// Data sources:
//   1. api.weather.gov/alerts — US National Weather Service active alerts
//      (Extreme + Severe severity, active only)
//   2. nhc.noaa.gov/CurrentStorms.json — NHC global tropical cyclones
//      (active Atlantic, Eastern/Central Pacific, Western Pacific storms)
//
// Caching strategy:
//   - Fresh (< TTL_MS)  → serve immediately, no upstream contact
//   - Stale (< STALE_MS) on upstream error → serve degraded with stale flag
//   - Cross-instance coalescing: if cache written within COALESCE_WINDOW_MS,
//     serve as fresh (another Lambda already fetched)
//   - In-memory coalescing: deduplicates within same warm Lambda instance
//
// Env: NOAA_BASE_URL, NOAA_POLL_INTERVAL_MS, ENABLE_NOAA,
//      SUPABASE_URL, SUPABASE_SERVICE_KEY

const { createClient } = require('@supabase/supabase-js');
const Cache = require('../lib/argus-cache');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const ENABLE_NOAA   = (process.env.ENABLE_NOAA   || 'true').toLowerCase() !== 'false';
const NOAA_BASE_URL = (process.env.NOAA_BASE_URL  || 'https://api.weather.gov').replace(/\/$/, '');

// TTL and stale window — imported from shared constants, overridable via env
const TTL_MS   = parseInt(process.env.NOAA_POLL_INTERVAL_MS || '') || Cache.TTL.NOAA;
const STALE_MS = Cache.STALE.NOAA;

const CACHE_KEY  = 'noaa_alerts_v2';
const MAX_ALERTS = 200;

const NHC_STORMS_URL = 'https://www.nhc.noaa.gov/CurrentStorms.json';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── NWS alert normalization ────────────────────────────────────────────────────
function nwsCentroid(geo) {
  if (!geo) return null;

  let ring = null;
  if (geo.type === 'Polygon' && geo.coordinates && geo.coordinates[0]) {
    ring = geo.coordinates[0];
  } else if (geo.type === 'MultiPolygon' && geo.coordinates && geo.coordinates[0] && geo.coordinates[0][0]) {
    ring = geo.coordinates[0][0];
  }
  if (!ring || !ring.length) return null;

  let sumLat = 0, sumLon = 0;
  for (let i = 0; i < ring.length; i++) {
    sumLon += ring[i][0];
    sumLat += ring[i][1];
  }
  const lat = sumLat / ring.length;
  const lon = sumLon / ring.length;
  if (!isFinite(lat) || !isFinite(lon)) return null;
  return { lat, lon };
}

function normalizeNWSAlert(feature) {
  const props = feature.properties || {};
  const id    = props.id || feature.id || null;
  if (!id) return null;

  const centroid = nwsCentroid(feature.geometry);
  if (!centroid) return null;

  return {
    id:        id,
    lat:       centroid.lat,
    lon:       centroid.lon,
    eventType: props.event     || 'Weather Alert',
    severity:  props.severity  || 'Unknown',
    urgency:   props.urgency   || 'Unknown',
    headline:  (props.headline || '').slice(0, 200),
    areaDesc:  (props.areaDesc || '').slice(0, 150),
    onset:     props.onset     || null,
    expires:   props.expires   || null,
    url:       props.id        || null,   // NWS alert page URL (same as id for NWS)
    source:    'NOAA/NWS',
  };
}

// ── NHC tropical storm normalization ──────────────────────────────────────────
function parseNHCCoord(latStr, lonStr) {
  if (!latStr || !lonStr) return null;
  const latDir = latStr.slice(-1);
  const lonDir = lonStr.slice(-1);
  let lat = parseFloat(latStr);
  let lon = parseFloat(lonStr);
  if (!isFinite(lat) || !isFinite(lon)) return null;
  if (latDir === 'S') lat = -lat;
  if (lonDir === 'W') lon = -lon;
  return { lat, lon };
}

const NHC_CLASS = {
  TD: 'Tropical Depression',
  TS: 'Tropical Storm',
  HU: 'Hurricane',
  TY: 'Typhoon',
  ST: 'Super Typhoon',
  TC: 'Tropical Cyclone',
  SD: 'Subtropical Depression',
  SS: 'Subtropical Storm',
  EX: 'Extratropical Cyclone',
  LO: 'Low',
  DB: 'Disturbance',
};

function normalizeNHCStorm(storm) {
  const coord = parseNHCCoord(storm.latitude, storm.longitude);
  if (!coord) return null;

  const classification = storm.classification || storm.type || 'TC';
  const name           = storm.name || storm.id || 'Unnamed';
  const intensity      = parseInt(storm.intensity) || 0;

  let severity = 'Moderate';
  if (intensity >= 96) severity = 'Extreme';
  else if (intensity >= 64) severity = 'Severe';
  else if (intensity >= 34) severity = 'Moderate';

  const stableKey = storm.id ||
    (name + '_' + (storm.basin || 'XX')).replace(/\s+/g, '');

  return {
    id:        'nhc_' + stableKey,
    lat:       coord.lat,
    lon:       coord.lon,
    eventType: NHC_CLASS[classification] || classification,
    severity:  severity,
    urgency:   intensity >= 64 ? 'Immediate' : 'Expected',
    headline:  name + ' — ' + (NHC_CLASS[classification] || classification) +
               (intensity ? ', ' + intensity + ' kt winds' : ''),
    areaDesc:  storm.basin || storm.id || '',
    onset:     null,
    expires:   null,
    url:       storm.id
               ? 'https://www.nhc.noaa.gov/text/refresh/MIATCP' + (storm.basin || '') + '+shtml/' + storm.id + '.shtml'
               : 'https://www.nhc.noaa.gov/',
    source:    'NOAA/NHC',
  };
}

// ── Parallel fetch: NWS + NHC ─────────────────────────────────────────────────
// Returns normalized alerts array. Throws on total failure.
// Partial failures (one source down) are tolerated — we return whatever succeeded.
async function fetchAllAlerts() {
  const fetchOpts = {
    signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
  };

  const [nwsResult, nhcResult] = await Promise.allSettled([
    fetch(NOAA_BASE_URL + '/alerts/active?message_type=alert,update&severity=Extreme,Severe&urgency=Immediate,Expected', {
      ...fetchOpts,
      headers: { 'Accept': 'application/geo+json', 'User-Agent': 'ArgusIntelligence/1.0' },
    }).then(r => {
      if (r.status === 429) throw Object.assign(new Error('NWS rate limit'), { status: 429 });
      return r.ok ? r.json() : Promise.reject(new Error('NWS HTTP ' + r.status));
    }),

    fetch(NHC_STORMS_URL, {
      ...fetchOpts,
      headers: { 'Accept': 'application/json' },
    }).then(r => {
      if (r.status === 429) throw Object.assign(new Error('NHC rate limit'), { status: 429 });
      return r.ok ? r.json() : Promise.reject(new Error('NHC HTTP ' + r.status));
    }),
  ]);

  // If both sources hit rate limits, propagate the 429
  const nwsIs429 = nwsResult.status === 'rejected' && nwsResult.reason && nwsResult.reason.status === 429;
  const nhcIs429 = nhcResult.status === 'rejected' && nhcResult.reason && nhcResult.reason.status === 429;
  if (nwsIs429 && nhcIs429) {
    throw Object.assign(new Error('NOAA rate limit on both sources'), { status: 429 });
  }

  const alerts = [];
  const seen   = new Set();

  if (nwsResult.status === 'fulfilled' && nwsResult.value) {
    const features = Array.isArray(nwsResult.value.features) ? nwsResult.value.features : [];
    for (let i = 0; i < features.length && alerts.length < MAX_ALERTS; i++) {
      const norm = normalizeNWSAlert(features[i]);
      if (!norm || seen.has(norm.id)) continue;
      seen.add(norm.id);
      alerts.push(norm);
    }
  } else if (nwsResult.status === 'rejected') {
    console.warn('[fetch-noaa] NWS fetch failed:', nwsResult.reason && nwsResult.reason.message);
  }

  if (nhcResult.status === 'fulfilled' && nhcResult.value) {
    const storms = Array.isArray(nhcResult.value.activeStorms) ? nhcResult.value.activeStorms : [];
    for (let i = 0; i < storms.length; i++) {
      const norm = normalizeNHCStorm(storms[i]);
      if (!norm || seen.has(norm.id)) continue;
      seen.add(norm.id);
      alerts.push(norm);
    }
  } else if (nhcResult.status === 'rejected') {
    console.warn('[fetch-noaa] NHC fetch failed:', nhcResult.reason && nhcResult.reason.message);
  }

  return alerts;
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (!ENABLE_NOAA) {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ alerts: [], source: 'noaa', ts: Date.now(), disabled: true }),
    };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // ── Cache read ─────────────────────────────────────────────────────────────
  const cached = await Cache.readCache(supabase, CACHE_KEY, TTL_MS, STALE_MS);

  if (cached.isFresh) {
    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=600' },
      body: JSON.stringify({ ...cached.payload, cached: true }),
    };
  }

  // Cross-instance coalescing: another Lambda wrote within COALESCE_WINDOW_MS
  if (cached.wasRecentlyWritten && cached.hasData) {
    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=600' },
      body: JSON.stringify({ ...cached.payload, cached: true }),
    };
  }

  // ── Fetch (in-memory coalescing within same Lambda instance) ───────────────
  let alerts;
  try {
    alerts = await Cache.withCoalescing(CACHE_KEY, fetchAllAlerts);
  } catch (err) {
    // ── Graceful degradation on rate limit or upstream failure ─────────────
    if (err.status === 429) {
      console.error('[QUOTA_EXHAUSTED][fetch-noaa] NOAA rate limit hit —',
        cached.hasData ? 'serving stale cache (age=' + Math.round(cached.ageMs / 60000) + 'min)' : 'no cache available');
    } else {
      console.error('[fetch-noaa] fetch failed:', err.message);
    }

    if (cached.isStale && cached.hasData) {
      return {
        statusCode: 200,
        headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' },
        body: JSON.stringify({
          ...cached.payload,
          cached:    true,
          degraded:  true,
          staleAgeMs: cached.ageMs,
          error:     err.status === 429 ? 'upstream_rate_limit' : 'upstream_error',
        }),
      };
    }

    return {
      statusCode: err.status === 429 ? 429 : 502,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error:   err.status === 429 ? 'NOAA rate limit. Try again shortly.' : 'NOAA upstream unavailable',
        alerts:  [],
      }),
    };
  }

  const payload = { alerts, source: 'noaa', ts: Date.now(), count: alerts.length };

  // ── Cache write ────────────────────────────────────────────────────────────
  await Cache.writeCache(supabase, CACHE_KEY, payload);

  console.log('[fetch-noaa] returned', alerts.length, 'alerts (NWS + NHC)');

  return {
    statusCode: 200,
    headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=600' },
    body: JSON.stringify(payload),
  };
};
