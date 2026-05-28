// netlify/functions/fetch-noaa.js
// NOAA environmental and weather intelligence proxy.
//
// Data sources:
//   1. api.weather.gov/alerts — US National Weather Service active alerts
//      (Extreme + Severe severity, active only)
//   2. nhc.noaa.gov/CurrentStorms.json — NHC global tropical cyclones
//      (active Atlantic, Eastern/Central Pacific, Western Pacific storms)
//
// This is a sparse environmental intelligence overlay — NOT a realtime weather feed.
// It surfaces macro weather systems that affect security, operations, and logistics.
//
// Cache TTL: 15 minutes default (configurable via NOAA_POLL_INTERVAL_MS).
//
// Response shape:
//   { alerts: [...normalizedAlerts], source: 'noaa', ts: epoch, count: N }
//
// Alert schema:
//   { id, lat, lon, eventType, severity, urgency, headline, areaDesc, onset, expires }
//
// Env: NOAA_BASE_URL, NOAA_POLL_INTERVAL_MS, ENABLE_NOAA,
//      SUPABASE_URL, SUPABASE_SERVICE_KEY

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const ENABLE_NOAA   = (process.env.ENABLE_NOAA   || 'true').toLowerCase() !== 'false';
const NOAA_BASE_URL = (process.env.NOAA_BASE_URL  || 'https://api.weather.gov').replace(/\/$/, '');

const POLL_MS      = parseInt(process.env.NOAA_POLL_INTERVAL_MS || String(15 * 60 * 1000));
const CACHE_KEY    = 'noaa_alerts_v1';
const CACHE_TTL_MS = POLL_MS;

const MAX_ALERTS = 200;

// NHC storms endpoint (global tropical cyclones — no auth required)
const NHC_STORMS_URL = 'https://www.nhc.noaa.gov/CurrentStorms.json';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── NWS alert normalization ────────────────────────────────────────────────────
// Extracts representative lat/lon from polygon geometry (centroid approximation).
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
    source:    'NOAA/NWS',
  };
}

// ── NHC tropical storm normalization ──────────────────────────────────────────
// NHC lat/lon are formatted as e.g. "25.1N", "76.7W"
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

// NHC classification codes → readable names
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
  const intensity      = parseInt(storm.intensity) || 0;  // max sustained wind, kt

  // Map intensity to NWS-compatible severity for consistent frontend coloring
  let severity = 'Moderate';
  if (intensity >= 96) severity = 'Extreme';    // Cat 3+
  else if (intensity >= 64) severity = 'Severe'; // Cat 1-2 / TS
  else if (intensity >= 34) severity = 'Moderate'; // TD

  return {
    id:        'nhc_' + (storm.id || name + '_' + Date.now()),
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
    source:    'NOAA/NHC',
  };
}

// ── Parallel fetch: NWS alerts + NHC storms ───────────────────────────────────
async function fetchAllAlerts() {
  const fetchOpts = {
    signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
  };

  const [nwsResult, nhcResult] = await Promise.allSettled([
    fetch(NOAA_BASE_URL + '/alerts/active?message_type=alert,update&severity=Extreme,Severe&urgency=Immediate,Expected', {
      ...fetchOpts,
      headers: {
        'Accept':     'application/geo+json',
        'User-Agent': 'ArgusIntelligence/1.0',
      },
    }).then(r => r.ok ? r.json() : Promise.reject(new Error('NWS HTTP ' + r.status))),

    fetch(NHC_STORMS_URL, {
      ...fetchOpts,
      headers: { 'Accept': 'application/json' },
    }).then(r => r.ok ? r.json() : Promise.reject(new Error('NHC HTTP ' + r.status))),
  ]);

  const alerts = [];
  const seen   = new Set();

  // NWS alerts
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

  // NHC tropical storms
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

  // ── Supabase cache read ────────────────────────────────────────────────────
  try {
    const { data: row } = await supabase
      .from('argus_cache')
      .select('payload, updated_at')
      .eq('key', CACHE_KEY)
      .single();

    if (row && row.payload) {
      const age = Date.now() - new Date(row.updated_at).getTime();
      if (age < CACHE_TTL_MS) {
        return {
          statusCode: 200,
          headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=600' },
          body: JSON.stringify({ ...row.payload, cached: true }),
        };
      }
    }
  } catch (_) { /* cache miss — proceed */ }

  // ── Fetch NWS + NHC in parallel ───────────────────────────────────────────
  let alerts;
  try {
    alerts = await fetchAllAlerts();
  } catch (err) {
    console.error('[fetch-noaa] fetch failed:', err.message);
    return {
      statusCode: 502,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'NOAA upstream unavailable', alerts: [] }),
    };
  }

  const payload = { alerts, source: 'noaa', ts: Date.now(), count: alerts.length };

  // ── Supabase cache write ───────────────────────────────────────────────────
  try {
    await supabase
      .from('argus_cache')
      .upsert(
        { key: CACHE_KEY, payload, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
  } catch (err) {
    console.warn('[fetch-noaa] cache write failed:', err.message);
  }

  console.log('[fetch-noaa] returned', alerts.length, 'alerts (NWS + NHC)');

  return {
    statusCode: 200,
    headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=600' },
    body: JSON.stringify(payload),
  };
};
