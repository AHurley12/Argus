'use strict';
// netlify/functions/fetch-eonet.js
// NASA EONET (Earth Observatory Natural Event Tracker) ingestion function.
//
// Pipeline:
//   EONET v3 API → fetch → normalize → Supabase cache → frontend
//
// Response shape:
//   { events: [...normalized], source: 'eonet', cacheSource, ts, count }
//
// Env vars:
//   SUPABASE_URL         — required
//   SUPABASE_SERVICE_KEY — required
//   ENABLE_EONET         — 'false' to disable (default: true)
//
// EONET is free, no API key required.
// API endpoint: https://eonet.gsfc.nasa.gov/api/v3/events

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ENABLE_EONET = (process.env.ENABLE_EONET || 'true').toLowerCase() !== 'false';

const CACHE_KEY   = 'eonet_events_v1';
const CACHE_TABLE = 'argus_cache';
const CACHE_TTL   = 15 * 60 * 1000;  // 15 minutes — matches NOAA cadence
const STALE_TTL   = 4  * 60 * 60 * 1000;  // 4h stale fallback (EONET rarely goes down)
const FETCH_TIMEOUT_MS = 12000;
const EONET_URL   = 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=200&days=7';
const PREFIX      = '[fetch-eonet]';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type':                'application/json',
  'Cache-Control':               'public, max-age=900, stale-while-revalidate=180',
};

// ── Category mapping ─────────────────────────────────────────────────────────
// Maps EONET v3 category IDs to ARGUS internal category strings.
// Aligns with GDACS category keys so the correlation engine can match them.
const CATEGORY_MAP = {
  'wildfires':           'wildfire',
  'severeStorms':        'tropical_cyclone',
  'volcanoes':           'volcano',
  'seaAndLakeIce':       'sea_ice',
  'earthquakes':         'earthquake',
  'drought':             'drought',
  'dustAndHaze':         'dust_haze',
  'floods':              'flood',
  'landslides':          'landslide',
  'manmade':             'manmade',
  'snow':                'snow',
  'temperatureExtremes': 'temperature',
  'waterColor':          'water_color',
};

// ── Severity derivation ───────────────────────────────────────────────────────
// EONET does not carry an explicit severity field.
// Earthquakes: derive from magnitudeValue (Richter scale).
// All others: default to 'moderate' (open events are considered noteworthy).
function _deriveSeverity(category, geometryArray) {
  var geom = Array.isArray(geometryArray) ? geometryArray[0] : null;
  var mag  = geom && geom.magnitudeValue != null ? parseFloat(geom.magnitudeValue) : null;

  if (category === 'earthquake' && mag != null) {
    if (mag >= 7.0) return 'extreme';
    if (mag >= 5.5) return 'severe';
    if (mag >= 3.5) return 'moderate';
    return 'minor';
  }

  if (category === 'volcano') return 'severe';  // active eruptions are high-priority
  return 'moderate';
}

// ── Normalize one EONET event → ARGUS schema ─────────────────────────────────
function _normalize(raw) {
  if (!raw || !raw.id || !raw.title) return null;

  // Extract the most recent Point geometry
  // GeoJSON order: coordinates = [lon, lat]
  var geomArray = Array.isArray(raw.geometry) ? raw.geometry : [];
  var geom = null;
  for (var i = 0; i < geomArray.length; i++) {
    var g = geomArray[i];
    if (g && g.type === 'Point' &&
        Array.isArray(g.coordinates) &&
        g.coordinates.length >= 2) {
      geom = g;
      break;  // take the most recent (first) point
    }
  }
  if (!geom) return null;  // Polygon geometries (ice extents etc.) skipped — no centroid

  var lon = parseFloat(geom.coordinates[0]);
  var lat = parseFloat(geom.coordinates[1]);
  if (isNaN(lat) || isNaN(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  var rawCat   = (raw.categories && raw.categories[0] && raw.categories[0].id) || 'manmade';
  var category = CATEGORY_MAP[rawCat] || 'manmade';

  return {
    id:            raw.id,
    source:        'EONET',
    sourceId:      raw.id,
    category:      category,
    eonetCategory: rawCat,
    title:         raw.title,
    lat:           lat,
    lon:           lon,
    timestamp:     geom.date || null,
    severity:      _deriveSeverity(category, geomArray),
    magnitude:     (geom.magnitudeValue != null ? parseFloat(geom.magnitudeValue) : null),
    magnitudeUnit: geom.magnitudeUnit || null,
    sources:       Array.isArray(raw.sources) ? raw.sources : [],
    link:          raw.link || null,
    closed:        raw.closed || null,
  };
}

// ── Cache helpers ─────────────────────────────────────────────────────────────
async function _cacheRead(supabase) {
  try {
    var r = await supabase
      .from(CACHE_TABLE)
      .select('payload, updated_at')
      .eq('key', CACHE_KEY)
      .single();
    if (r.error) {
      console.warn(PREFIX, 'cache read error:', r.error.message);
      return null;
    }
    return r.data;
  } catch (e) {
    console.warn(PREFIX, 'cache read exception:', e.message);
    return null;
  }
}

async function _cacheWrite(supabase, payload) {
  try {
    var r = await supabase
      .from(CACHE_TABLE)
      .upsert(
        { key: CACHE_KEY, payload: payload, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
    if (r.error) console.warn(PREFIX, 'cache write error:', r.error.message);
  } catch (e) {
    console.warn(PREFIX, 'cache write exception:', e.message);
  }
}

// ── Response helpers ──────────────────────────────────────────────────────────
function _ok(body) {
  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (!ENABLE_EONET) {
    return _ok({ events: [], source: 'eonet', cacheSource: 'disabled',
      disabled: true, ts: Date.now(), count: 0 });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error(PREFIX, 'Supabase not configured');
    return _ok({ events: [], source: 'eonet', cacheSource: 'empty',
      error: 'Supabase not configured', ts: Date.now(), count: 0 });
  }

  var supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Cache read
  var cached   = await _cacheRead(supabase);
  var cacheAge = cached ? Date.now() - new Date(cached.updated_at).getTime() : Infinity;

  if (cached && cacheAge < CACHE_TTL) {
    console.log(PREFIX, 'cache hit — age=' + Math.round(cacheAge / 1000) + 's,',
      (cached.payload.count || 0) + ' events');
    return _ok(Object.assign({}, cached.payload, { cacheSource: 'cache' }));
  }

  // Fetch from EONET
  var t0 = Date.now();
  var raw;
  try {
    var res = await fetch(EONET_URL, {
      signal:  AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent': 'ArgusIntelligence/1.0 (earth-observatory@argus.app)',
        'Accept':     'application/json',
      },
    });
    if (!res.ok) throw new Error('EONET HTTP ' + res.status);
    var text = await res.text();
    raw = JSON.parse(text);
  } catch (err) {
    console.warn(PREFIX, 'fetch failed:', err.message);
    // Stale fallback — EONET events change slowly, stale data is still valuable
    if (cached && cacheAge < STALE_TTL) {
      console.log(PREFIX, 'serving stale cache — age=' + Math.round(cacheAge / 1000) + 's');
      return _ok(Object.assign({}, cached.payload, { cacheSource: 'stale_cache' }));
    }
    return _ok({ events: [], source: 'eonet', cacheSource: 'empty', ts: Date.now(), count: 0 });
  }

  var latencyMs = Date.now() - t0;

  // Normalize
  var events  = [];
  var skipped = 0;
  var rawEvents = (raw && Array.isArray(raw.events)) ? raw.events : [];

  for (var i = 0; i < rawEvents.length; i++) {
    var normalized = _normalize(rawEvents[i]);
    if (normalized) {
      events.push(normalized);
    } else {
      skipped++;
    }
  }

  console.log(PREFIX,
    'normalized ' + events.length + ' events, ' + skipped + ' skipped — ' + latencyMs + 'ms');

  var payload = {
    events:  events,
    source:  'eonet',
    ts:      Date.now(),
    count:   events.length,
  };

  // Fire-and-forget cache write
  _cacheWrite(supabase, payload).catch(function() {});

  return _ok(Object.assign({}, payload, { cacheSource: 'live' }));
};
