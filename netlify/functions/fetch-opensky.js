// netlify/functions/fetch-opensky.js
// OpenSky Network REST API proxy — aircraft fallback provider.
//
// OpenSky aggregates ADS-B data from volunteer receivers worldwide.
// Used as additive fallback when the primary fetch-traffic function has no data
// for a region (stale cell, receiver gap) or after a complete primary failure.
//
// Response shape (normalized for argusProviderCache.js):
//   { aircraft: [{ icao24, callsign, lat, lon, track, gs, alt, flightType, source }], source: 'opensky', ts: <epoch> }
//
// Setup:
//   No credentials required for anonymous access (rate-limited to ~100 req/day).
//   For higher rate limits, add:
//     Netlify dashboard → Site → Environment variables:
//       OPENSKY_USER = your_opensky_username
//       OPENSKY_PASS = your_opensky_password
//   With credentials: 400 req/day, credentials sent as HTTP Basic Auth.
//
// We cache 120 seconds in Supabase (generous buffer around OpenSky's 10s update cycle).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, OPENSKY_USER (optional), OPENSKY_PASS (optional)

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const OS_USER       = process.env.OPENSKY_USER || '';
const OS_PASS       = process.env.OPENSKY_PASS || '';

const CACHE_KEY     = 'opensky_aircraft_v1';
const CACHE_TTL_MS  = 2 * 60 * 1000;  // 2 min — conservative for anonymous tier

// Hard cap: prevent flooding the render pipeline if OpenSky returns a huge snapshot.
// Primary pipeline already caps at 750; fallback should never exceed the residual gap.
const MAX_AIRCRAFT = 400;

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

// OpenSky returns state vectors as arrays with positional fields.
// Field indices per OpenSky Network API v1 docs:
//   0  icao24 (string)
//   1  callsign (string, space-padded)
//   2  origin_country
//   3  time_position
//   4  last_contact
//   5  longitude (float)
//   6  latitude (float)
//   7  baro_altitude (float, meters)
//   8  on_ground (bool)
//   9  velocity (float, m/s)
//   10 true_track (float, degrees from north)
//   11 vertical_rate
//   12 sensors
//   13 geo_altitude (float, meters)
//   14 squawk
//   15 spi
//   16 position_source
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
  // Altitude: prefer baro, fall back to geo — convert meters → feet
  const altM   = sv[7] != null ? sv[7] : sv[13];
  const altFt  = altM != null ? Math.round(altM * 3.28084) : null;
  // Velocity: m/s → knots
  const velMs  = sv[9];
  const gs     = velMs != null ? Math.round(velMs * 1.94384) : null;
  const track  = sv[10] != null ? sv[10] : null;

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

  // ── OpenSky REST fetch ─────────────────────────────────────────────────────
  // /api/states/all — global snapshot, no bbox
  let osUrl = 'https://opensky-network.org/api/states/all';
  const fetchOpts = {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
  };
  if (OS_USER && OS_PASS) {
    const creds = Buffer.from(`${OS_USER}:${OS_PASS}`).toString('base64');
    fetchOpts.headers['Authorization'] = `Basic ${creds}`;
  }

  let rawJson;
  try {
    const resp = await fetch(osUrl, fetchOpts);
    if (!resp.ok) {
      throw new Error(`OpenSky HTTP ${resp.status}`);
    }
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
  const aircraft = [];
  const seen = new Set();

  for (let i = 0; i < stateVectors.length && aircraft.length < MAX_AIRCRAFT; i++) {
    const norm = normalizeState(stateVectors[i]);
    if (!norm) continue;
    if (seen.has(norm.icao24)) continue;  // dedup within this snapshot
    seen.add(norm.icao24);
    aircraft.push(norm);
  }

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
