// netlify/functions/fetch-aishub.js
// AISHub REST API proxy — vessel fallback provider.
//
// AISHub aggregates AIS data from volunteer receivers worldwide.
// Used as additive fallback when AISstream WebSocket coverage is absent or stale.
//
// Response shape (normalized for argusProviderCache.js):
//   { vessels: [{ mmsi, name, lat, lon, heading, velocity, shipType, source }], source: 'aishub', ts: <epoch> }
//
// Setup:
//   Netlify dashboard → Site → Environment variables → Add:
//     AISHUB_USERNAME = your_aishub_username
//
// AISHub free tier: 5-minute poll interval, ~1,000 vessels/request, global bbox.
// Rate limit: one request per 60 seconds per username. We cache 5 min in Supabase.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, AISHUB_USERNAME

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const AISHUB_USER   = process.env.AISHUB_USERNAME || '';

// AISHub returns vessels in a proprietary array format: [header, v1, v2, ...]
// Header object describes field positions; each vessel is an object keyed by field name.
const CACHE_KEY     = 'aishub_vessels_v1';
const CACHE_TTL_MS  = 5 * 60 * 1000;   // 5 min — respects AISHub free-tier poll interval

// Classify raw AIS numeric ship-type into our canonical category strings.
// Mirrors classifyAISType() in argusAIS.js.
function classifyType(rawType) {
  const n = parseInt(rawType, 10);
  if (isNaN(n) || n <= 0) return 'other';
  if (n === 35)                 return 'military';
  if (n === 30)                 return 'fishing';
  if (n === 31 || n === 32 || n === 52) return 'tug';
  if (n === 36 || n === 37)     return 'recreational';
  if (n >= 50 && n <= 59)       return 'port_service';
  if (n >= 60 && n <= 69)       return 'passenger';
  if (n >= 70 && n <= 79)       return 'cargo';
  if (n >= 80 && n <= 89)       return 'tanker';
  return 'unknown';
}

// Normalize one raw AISHub vessel record into the canonical telemetry shape.
function normalizeVessel(v) {
  const lat = parseFloat(v.LATITUDE);
  const lon = parseFloat(v.LONGITUDE);
  if (!isFinite(lat) || !isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const mmsi = String(v.MMSI || '').trim();
  if (!mmsi) return null;

  return {
    mmsi:     mmsi,
    name:     (v.NAME || '').trim() || null,
    lat:      lat,
    lon:      lon,
    heading:  isFinite(parseFloat(v.HEADING))  ? parseFloat(v.HEADING)  : null,
    velocity: isFinite(parseFloat(v.SPEED))    ? parseFloat(v.SPEED)    : null,
    shipType: classifyType(v.SHIPTYPE),
    navStatus: isFinite(parseInt(v.STATUS, 10)) ? parseInt(v.STATUS, 10) : null,
    source:   'aishub',
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

  if (!AISHUB_USER) {
    return {
      statusCode: 503,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'AISHUB_USERNAME not configured', vessels: [] }),
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
          headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=240' },
          body: JSON.stringify({ ...row.payload, cached: true }),
        };
      }
    }
  } catch (_) { /* cache miss — proceed to fetch */ }

  // ── AISHub REST fetch ──────────────────────────────────────────────────────
  // Format=1 returns JSON. Bbox covers global coverage (no bbox param = global).
  const aishubUrl =
    `https://data.aishub.net/ws.php?username=${encodeURIComponent(AISHUB_USER)}&format=1&output=json&compress=0`;

  let rawJson;
  try {
    const resp = await fetch(aishubUrl, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined,
    });
    if (!resp.ok) {
      throw new Error(`AISHub HTTP ${resp.status}`);
    }
    rawJson = await resp.json();
  } catch (err) {
    console.error('[fetch-aishub] upstream fetch failed:', err.message);
    return {
      statusCode: 502,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'AISHub upstream unavailable', vessels: [] }),
    };
  }

  // AISHub response: array where [0] is a header descriptor object, [1..N] are vessel objects.
  // Validate shape before processing.
  if (!Array.isArray(rawJson) || rawJson.length < 2) {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'AISHub: empty or malformed response', vessels: [], source: 'aishub', ts: Date.now() }),
    };
  }

  // Skip index 0 (header descriptor) — vessel data starts at index 1.
  // AISHub free tier wraps vessels inside the array directly, not nested.
  const rawVessels = rawJson.slice(1);
  const vessels = [];
  for (let i = 0; i < rawVessels.length; i++) {
    const v = rawVessels[i];
    // AISHub sometimes nests vessels under an array inside the array element
    const target = Array.isArray(v) ? v[0] : v;
    if (!target || typeof target !== 'object') continue;
    const norm = normalizeVessel(target);
    if (norm) vessels.push(norm);
  }

  const payload = { vessels, source: 'aishub', ts: Date.now() };

  // ── Supabase cache write ───────────────────────────────────────────────────
  try {
    await supabase
      .from('argus_cache')
      .upsert({ key: CACHE_KEY, payload, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  } catch (err) {
    console.warn('[fetch-aishub] cache write failed:', err.message);
  }

  return {
    statusCode: 200,
    headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=240' },
    body: JSON.stringify(payload),
  };
};
