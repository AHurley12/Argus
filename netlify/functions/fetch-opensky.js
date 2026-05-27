// netlify/functions/fetch-opensky.js
// OpenSky Network REST API proxy — aircraft supplemental provider.
//
// Auth: HTTP Basic Auth (username:password) sent directly on the /states/all
// request. Eliminates the two-hop OAuth2 token exchange against auth.opensky-
// network.org which was timing out from Netlify's IP range. Basic Auth is
// still accepted by OpenSky's REST API for authenticated account access.
//
// Response shape:
//   { aircraft: [...normalised records], source: 'opensky', ts: <epoch> }
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY,
//      OPENSKY_ID     — OpenSky username
//      OPENSKY_SECRET — OpenSky password
//      ENABLE_OPENSKY — set to 'true' to enable (default: disabled)
//      OPENSKY_BASE_URL (optional)
//      OPENSKY_POLL_INTERVAL_MS (optional, default: 2 min)

'use strict';

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY;
const OS_USER        = process.env.OPENSKY_ID     || '';
const OS_PASS        = process.env.OPENSKY_SECRET || '';
const ENABLE_OPENSKY = (process.env.ENABLE_OPENSKY || 'false').toLowerCase() !== 'false';
const OS_BASE_URL    = (process.env.OPENSKY_BASE_URL || 'https://opensky-network.org/api').replace(/\/$/, '');

const CACHE_KEY    = 'opensky_aircraft_v1';
const CACHE_TTL_MS = parseInt(process.env.OPENSKY_POLL_INTERVAL_MS || String(2 * 60 * 1000));
const MAX_AIRCRAFT = 400;
const FETCH_TIMEOUT_MS = 8000; // 8s — leaves headroom within Netlify's 10s limit

// ── Flight classification ─────────────────────────────────────────────────────
const CARGO_PREFIXES      = ['FDX', 'UPS', 'CLX', 'GTI', 'ABX'];
const MILITARY_PREFIXES   = ['RCH', 'BAF', 'RAF', 'AMC', 'NAV'];
const COMMERCIAL_PREFIXES = ['DAL', 'UAL', 'AAL', 'SWA', 'BAW', 'AFR', 'KLM'];

function classifyFlight(callsign, alt) {
  const prefix = (callsign || '').trim().slice(0, 3).toUpperCase();
  if (MILITARY_PREFIXES.includes(prefix))   return 'military';
  if (CARGO_PREFIXES.includes(prefix))      return 'cargo';
  if (COMMERCIAL_PREFIXES.includes(prefix)) return 'commercial';
  if (alt != null && alt > 20000)           return 'commercial';
  return 'unknown';
}

// ── State vector normalizer ───────────────────────────────────────────────────
// Field indices per OpenSky Network API v1 docs:
//   0  icao24   1  callsign   2  origin_country
//   5  longitude  6  latitude  7  baro_altitude(m)  8  on_ground
//   9  velocity(m/s)  10  true_track(deg)  13  geo_altitude(m)
function normalizeState(sv) {
  if (!Array.isArray(sv) || sv.length < 11) return null;
  const icao24 = String(sv[0] || '').trim();
  if (!icao24) return null;
  if (sv[8] === true) return null; // on ground — skip
  const lon = sv[5];
  const lat = sv[6];
  if (lat == null || lon == null || !isFinite(lat) || !isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const callsign = (sv[1] || '').trim();
  const altM     = sv[7] != null ? sv[7] : sv[13];
  const altFt    = altM  != null ? Math.round(altM  * 3.28084) : null;
  const velMs    = sv[9];
  const gs       = velMs != null ? Math.round(velMs * 1.94384) : null;
  const track    = sv[10] != null ? sv[10] : null;
  return {
    icao24:     icao24,
    callsign:   callsign || null,
    lat, lon, track, gs,
    alt:        altFt,
    flightType: classifyFlight(callsign, altFt),
    stale:      false,
    source:     'opensky',
  };
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function json(statusCode, payload, extra) {
  return {
    statusCode,
    headers: Object.assign({}, CORS_HEADERS, extra || {}),
    body: JSON.stringify(payload),
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (!ENABLE_OPENSKY) {
    console.log('[fetch-opensky] disabled via ENABLE_OPENSKY env var');
    return json(200, { aircraft: [], source: 'opensky', ts: Date.now(), disabled: true });
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
        console.log('[fetch-opensky] serving Supabase cache, age', Math.round(age / 1000) + 's');
        return json(200, Object.assign({}, row.payload, { cached: true }),
          { 'Cache-Control': 'public, max-age=90' });
      }
    }
  } catch (cacheErr) {
    console.warn('[fetch-opensky] cache read failed:', cacheErr.message);
  }

  // ── OpenSky REST fetch (Basic Auth) ───────────────────────────────────────
  // Direct Basic Auth on the API endpoint — no separate token exchange server.
  // AbortSignal.timeout available in Node 17.3+; guarded for older runtimes.
  const headers = { 'Accept': 'application/json' };
  if (OS_USER && OS_PASS) {
    const cred = Buffer.from(OS_USER + ':' + OS_PASS).toString('base64');
    headers['Authorization'] = 'Basic ' + cred;
    console.log('[fetch-opensky] using Basic Auth for user:', OS_USER);
  } else {
    console.log('[fetch-opensky] no credentials — anonymous request');
  }

  const signal = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
    ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
    : undefined;

  let rawJson;
  try {
    const resp = await fetch(OS_BASE_URL + '/states/all', { headers, signal });
    console.log('[fetch-opensky] OpenSky HTTP', resp.status);
    if (resp.status === 401) {
      const body = await resp.text().catch(() => '');
      console.error('[fetch-opensky] 401 Unauthorized — check OPENSKY_ID/OPENSKY_SECRET. Body:', body.slice(0, 200));
      return json(502, { error: 'OpenSky 401 — invalid credentials', aircraft: [] });
    }
    if (resp.status === 429) {
      console.warn('[fetch-opensky] 429 rate limited');
      return json(429, { error: 'OpenSky rate limited', aircraft: [] });
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error('[fetch-opensky] HTTP', resp.status, '—', body.slice(0, 200));
      return json(502, { error: 'OpenSky HTTP ' + resp.status, aircraft: [] });
    }
    rawJson = await resp.json();
  } catch (err) {
    console.error('[fetch-opensky] fetch error:', err.message);
    return json(502, { error: 'OpenSky fetch failed: ' + err.message, aircraft: [] });
  }

  const stateVectors = (rawJson && Array.isArray(rawJson.states)) ? rawJson.states : [];
  console.log('[fetch-opensky] raw states:', stateVectors.length);

  const aircraft = [];
  const seen     = new Set();
  for (let i = 0; i < stateVectors.length && aircraft.length < MAX_AIRCRAFT; i++) {
    const norm = normalizeState(stateVectors[i]);
    if (!norm || seen.has(norm.icao24)) continue;
    seen.add(norm.icao24);
    aircraft.push(norm);
  }
  console.log('[fetch-opensky] normalised:', aircraft.length);

  const payload = { aircraft, source: 'opensky', ts: Date.now() };

  // ── Supabase cache write ───────────────────────────────────────────────────
  try {
    await supabase
      .from('argus_cache')
      .upsert({ key: CACHE_KEY, payload, updated_at: new Date().toISOString() },
               { onConflict: 'key' });
  } catch (err) {
    console.warn('[fetch-opensky] cache write failed:', err.message);
  }

  return json(200, payload, { 'Cache-Control': 'public, max-age=90' });
};
