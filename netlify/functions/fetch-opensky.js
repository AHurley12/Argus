// netlify/functions/fetch-opensky.js
// OpenSky Network REST API proxy — aircraft fallback provider.
//
// OpenSky aggregates ADS-B data from volunteer receivers worldwide.
// Used as additive fallback when the primary fetch-traffic function has no data
// for a region (stale cell, receiver gap) or after a complete primary failure.
//
// Auth: OAuth2 client credentials flow. Basic Auth (username/password) is no
// longer accepted by OpenSky. Credentials are exchanged for a 30-min Bearer
// token which is cached in-memory across warm function invocations.
//
// Response shape (normalized for argusProviderCache.js):
//   { aircraft: [{ icao24, callsign, lat, lon, track, gs, alt, flightType, source }], source: 'opensky', ts: <epoch> }
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY,
//      OPENSKY_ID     (OAuth2 client_id),
//      OPENSKY_SECRET (OAuth2 client_secret),
//      OPENSKY_BASE_URL (optional), OPENSKY_POLL_INTERVAL_MS (optional),
//      ENABLE_OPENSKY (optional, default true)

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_KEY;
const OS_CLIENT_ID    = process.env.OPENSKY_ID     || '';
const OS_CLIENT_SEC   = process.env.OPENSKY_SECRET || '';
const ENABLE_OPENSKY  = (process.env.ENABLE_OPENSKY || 'false').toLowerCase() !== 'false';
const OS_BASE_URL     = (process.env.OPENSKY_BASE_URL || 'https://opensky-network.org/api').replace(/\/$/, '');
const OS_TOKEN_URL    = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

const CACHE_KEY    = 'opensky_aircraft_v1';
const CACHE_TTL_MS = parseInt(process.env.OPENSKY_POLL_INTERVAL_MS || String(2 * 60 * 1000));
const MAX_AIRCRAFT = 400;

// ── In-memory token cache (survives warm Netlify function instances) ───────────
// Tokens last 30 min — we refresh 2 min early to avoid expiry mid-request.
let _tokenCache = null; // { token: string, expiresAt: number }

async function getAccessToken() {
  const now = Date.now();
  if (_tokenCache && _tokenCache.expiresAt > now + 2 * 60 * 1000) {
    return _tokenCache.token;
  }

  // OpenSky standard accounts use Resource Owner Password Credentials grant.
  // client_credentials is only for registered OAuth2 applications.
  // OPENSKY_ID = OpenSky username, OPENSKY_SECRET = OpenSky password.
  // client_id 'opensky-api' is OpenSky's public Keycloak API client.
  const body = new URLSearchParams({
    grant_type: 'password',
    username:   OS_CLIENT_ID,
    password:   OS_CLIENT_SEC,
    client_id:  'opensky-api',
    scope:      'openid',
  });

  const resp = await fetch(OS_TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
    signal:  AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined,
  });

  if (!resp.ok) {
    let detail = '';
    try { detail = await resp.text(); } catch (_) {}
    console.error('[fetch-opensky] token exchange HTTP', resp.status, '— body:', detail.slice(0, 300));
    throw new Error(`OpenSky token exchange failed: HTTP ${resp.status} — ${detail.slice(0, 200)}`);
  }

  const json = await resp.json();
  if (!json.access_token) throw new Error('OpenSky token response missing access_token');

  // expires_in is in seconds; default 1800 (30 min) if not present
  const expiresIn = (json.expires_in || 1800) * 1000;
  _tokenCache = { token: json.access_token, expiresAt: now + expiresIn };
  console.log('[OpenSky TOKEN] acquired, expires in', Math.round(expiresIn / 60000), 'min');
  return _tokenCache.token;
}

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
//   0  icao24 (string)   1  callsign   2  origin_country
//   3  time_position      4  last_contact
//   5  longitude (float)  6  latitude (float)
//   7  baro_altitude (m)  8  on_ground (bool)
//   9  velocity (m/s)    10  true_track (deg)  11  vertical_rate
//  12  sensors           13  geo_altitude (m)  14  squawk
function normalizeState(sv) {
  if (!Array.isArray(sv) || sv.length < 11) return null;
  const icao24 = String(sv[0] || '').trim();
  if (!icao24) return null;
  if (sv[8] === true) return null;  // on ground — skip

  const lon = sv[5];
  const lat = sv[6];
  if (lat == null || lon == null || !isFinite(lat) || !isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  const callsign = (sv[1] || '').trim();
  const altM     = sv[7] != null ? sv[7] : sv[13];
  const altFt    = altM != null ? Math.round(altM * 3.28084) : null;
  const velMs    = sv[9];
  const gs       = velMs != null ? Math.round(velMs * 1.94384) : null;
  const track    = sv[10] != null ? sv[10] : null;

  return {
    icao24:     icao24,
    callsign:   callsign || null,
    lat:        lat,
    lon:        lon,
    track:      track,
    gs:         gs,
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

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (!ENABLE_OPENSKY) {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ aircraft: [], source: 'opensky', ts: Date.now(), disabled: true }),
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
          headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=90' },
          body: JSON.stringify({ ...row.payload, cached: true }),
        };
      }
    }
  } catch (_) { /* cache miss — proceed to fetch */ }

  // ── OAuth2 token exchange ─────────────────────────────────────────────────
  let token = null;
  if (OS_CLIENT_ID && OS_CLIENT_SEC) {
    try {
      token = await getAccessToken();
    } catch (err) {
      console.error('[fetch-opensky] token exchange failed:', err.message);
      return {
        statusCode: 502,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'OpenSky auth failed', aircraft: [] }),
      };
    }
  }

  // ── OpenSky REST fetch ─────────────────────────────────────────────────────
  const fetchOpts = {
    headers: { 'Accept': 'application/json' },
    signal:  AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
  };
  if (token) {
    fetchOpts.headers['Authorization'] = 'Bearer ' + token;
  }

  let rawJson;
  try {
    const resp = await fetch(OS_BASE_URL + '/states/all', fetchOpts);
    if (resp.status === 401) {
      // Token rejected — clear cache and fail cleanly (next invocation will re-exchange)
      _tokenCache = null;
      throw new Error('OpenSky 401 — token invalidated, will retry next poll');
    }
    if (!resp.ok) throw new Error('OpenSky HTTP ' + resp.status);
    console.log('[OpenSky FETCH SUCCESS]', resp.status);
    rawJson = await resp.json();
  } catch (err) {
    console.error('[fetch-opensky] upstream fetch failed:', err.message);
    return {
      statusCode: 502,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'OpenSky upstream unavailable', aircraft: [] }),
    };
  }

  const stateVectors = rawJson && Array.isArray(rawJson.states) ? rawJson.states : [];
  console.log('[OpenSky RAW STATES]', stateVectors.length);

  const aircraft = [];
  const seen     = new Set();
  for (let i = 0; i < stateVectors.length && aircraft.length < MAX_AIRCRAFT; i++) {
    const norm = normalizeState(stateVectors[i]);
    if (!norm) continue;
    if (seen.has(norm.icao24)) continue;
    seen.add(norm.icao24);
    aircraft.push(norm);
  }
  console.log('[OpenSky NORMALIZED COUNT]', aircraft.length);

  const payload = { aircraft, source: 'opensky', ts: Date.now() };

  // ── Supabase cache write ───────────────────────────────────────────────────
  try {
    await supabase
      .from('argus_cache')
      .upsert({ key: CACHE_KEY, payload, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  } catch (err) {
    console.warn('[fetch-opensky] cache write failed:', err.message);
  }

  return {
    statusCode: 200,
    headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=90' },
    body: JSON.stringify(payload),
  };
};
