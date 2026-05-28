/**
 * opensky-proxy — Cloudflare Worker (ES Module format)
 *
 * Chain: browser → this Worker (CORS: *) → opensky-network.org/api
 *
 * Secrets (set via: wrangler secret put <NAME>):
 *   OPENSKY_USERNAME — OpenSky account email
 *   OPENSKY_PASSWORD — OpenSky account password
 *
 * Query params accepted:
 *   lamin, lamax, lomin, lomax — bounding box (decimal degrees, required)
 *
 * Response schema (always HTTP 200, aircraft may be empty):
 *   {
 *     aircraft: Array<ArgusAircraftRecord>,
 *     source:   'opensky',
 *     ts:       number,          // epoch ms of OpenSky snapshot
 *     count:    number,
 *     error?:   string,          // present only on upstream failure
 *     cached?:  true,            // present on CF cache hit
 *   }
 *
 * ArgusAircraftRecord:
 *   { icao24, cs, lat, lon, track, gs, alt, phase, flightType, region, stale, source }
 *
 * CORS: Access-Control-Allow-Origin: * on every response path.
 * Cache: Cloudflare Cache API, 15 s TTL (safe for 5 req/10s authenticated limit).
 */

// ── Constants ────────────────────────────────────────────────────────────────────
const OPENSKY_BASE  = 'https://opensky-network.org/api/states/all';
const TIMEOUT_MS    = 9000;   // 9s — leaves headroom before CF's 30s CPU limit
const CACHE_TTL_S   = 15;     // 15s — OpenSky snapshot cadence for authenticated users
const MAX_AIRCRAFT  = 750;    // match Argus renderer ceiling

// ── CORS headers — applied to every response ──────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Vary':                         'Origin',
};

// ── Unified response helper — CORS on every path ─────────────────────────────
function respond(payload, status, extra) {
  return new Response(JSON.stringify(payload), {
    status:  status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS, extra || {}),
  });
}

function empty(errorMsg, extra) {
  return respond(
    { aircraft: [], source: 'opensky', ts: Date.now(), count: 0, error: errorMsg },
    200,
    extra
  );
}

// ── OpenSky state-vector → Argus aircraft record ──────────────────────────────
// OpenSky state vector (array, index-addressed):
//   0  icao24         string
//   1  callsign       string | null
//   2  origin_country string
//   3  time_position  int (unix s) | null
//   4  last_contact   int (unix s)
//   5  longitude      float | null   (decimal degrees)
//   6  latitude       float | null   (decimal degrees)
//   7  baro_altitude  float | null   (meters)
//   8  on_ground      bool
//   9  velocity       float | null   (m/s)
//  10  true_track     float | null   (degrees CW from north)
//  11  vertical_rate  float | null   (m/s, positive = climb)
//  12  sensors        int[] | null
//  13  geo_altitude   float | null   (meters)
//  14  squawk         string | null
//  15  spi            bool
//  16  position_source int (0=ADS-B, 1=ASTERIX, 2=MLAT, 3=FLARM)
function normalizeState(sv) {
  if (!Array.isArray(sv) || sv.length < 17) return null;

  const icao24   = typeof sv[0] === 'string' ? sv[0].trim().toLowerCase() : null;
  const lon      = sv[5];
  const lat      = sv[6];
  const onGround = sv[8];

  if (!icao24)                                               return null;
  if (lat == null || lon == null)                            return null;
  if (!isFinite(lat) || !isFinite(lon))                      return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180)     return null;
  if (onGround)                                              return null; // skip ground traffic

  const cs = typeof sv[1] === 'string' ? sv[1].trim() || null : null;

  // Altitude: baro preferred, geo fallback. Convert meters → feet.
  const baroM = (sv[7] != null && isFinite(sv[7]))  ? sv[7]  : null;
  const geoM  = (sv[13] != null && isFinite(sv[13])) ? sv[13] : null;
  const altM  = baroM ?? geoM;
  const altFt = altM != null ? Math.round(altM * 3.28084) : null;

  // Velocity: m/s → knots
  const velMs = (sv[9] != null && isFinite(sv[9])) ? sv[9] : null;
  const gs    = velMs != null ? Math.round(velMs * 1.94384) : null;

  const track = (sv[10] != null && isFinite(sv[10])) ? sv[10] : null;

  // Vertical rate: m/s → ft/min for phase classification
  const vrMs    = (sv[11] != null && isFinite(sv[11])) ? sv[11] : null;
  const vrFtMin = vrMs != null ? vrMs * 196.85 : null;
  let phase = 'cruise';
  if (vrFtMin != null) {
    if (vrFtMin >  500) phase = 'climb';
    else if (vrFtMin < -500) phase = 'descent';
  }

  // Flight type by callsign prefix
  const pfx = (cs || '').slice(0, 3).toUpperCase();
  const MILITARY   = ['RCH', 'BAF', 'RAF', 'AMC', 'NAV', 'DUKE', 'EXEC', 'JAKE', 'REACH'];
  const CARGO      = ['FDX', 'UPS', 'CLX', 'GTI', 'ABX', 'PAC', 'ATN', 'DHL'];
  const COMMERCIAL = ['DAL', 'UAL', 'AAL', 'SWA', 'BAW', 'AFR', 'KLM', 'DLH', 'UAE',
                      'SIA', 'QFA', 'IBE', 'TAP', 'TUI', 'THY', 'ETD', 'EZY', 'RYR'];
  let flightType = 'unknown';
  if (MILITARY.some(m => pfx.startsWith(m)))   flightType = 'military';
  else if (CARGO.includes(pfx))                flightType = 'cargo';
  else if (COMMERCIAL.includes(pfx))           flightType = 'commercial';
  else if (altFt != null && altFt > 20000)     flightType = 'commercial';

  return {
    icao24,
    cs,
    lat,
    lon,
    track,
    gs,
    alt:        altFt,
    phase,
    flightType,
    region:     null,
    stale:      false,
    source:     'opensky',
  };
}

// ── Bbox validation ───────────────────────────────────────────────────────────
function parseBbox(params) {
  const lamin = parseFloat(params.get('lamin'));
  const lamax = parseFloat(params.get('lamax'));
  const lomin = parseFloat(params.get('lomin'));
  const lomax = parseFloat(params.get('lomax'));

  if (!isFinite(lamin) || !isFinite(lamax) || !isFinite(lomin) || !isFinite(lomax)) return null;
  if (lamin < -90  || lamax > 90  || lamin >= lamax) return null;
  if (lomin < -180 || lomax > 180 || lomin >= lomax) return null;

  return { lamin, lamax, lomin, lomax };
}

// ── Worker entry point ────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    // ── 1. CORS preflight — always first, never fails ─────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method !== 'GET') {
      return empty('method_not_allowed');
    }

    // ── 2. Parse and validate bbox ────────────────────────────────────────
    const url   = new URL(request.url);
    const bbox  = parseBbox(url.searchParams);

    if (!bbox) {
      return empty('bbox_required: provide lamin, lamax, lomin, lomax');
    }

    // ── 3. CF Cache check ─────────────────────────────────────────────────
    const cache    = caches.default;
    const cacheKey = new Request(
      `${OPENSKY_BASE}?lamin=${bbox.lamin}&lamax=${bbox.lamax}&lomin=${bbox.lomin}&lomax=${bbox.lomax}`,
      { method: 'GET' }
    );

    const hit = await cache.match(cacheKey);
    if (hit) {
      const body = await hit.json();
      return respond(Object.assign({}, body, { cached: true }), 200, {
        'X-Cache': 'HIT',
        'Cache-Control': `public, max-age=${CACHE_TTL_S}`,
      });
    }

    // ── 4. Build OpenSky request ──────────────────────────────────────────
    const openskyUrl = `${OPENSKY_BASE}?lamin=${bbox.lamin.toFixed(4)}&lamax=${bbox.lamax.toFixed(4)}&lomin=${bbox.lomin.toFixed(4)}&lomax=${bbox.lomax.toFixed(4)}`;

    const headers = {
      'Accept':     'application/json',
      'User-Agent': 'ArgusIntel/1.0 (contact: ops@argusintel.live)',
    };

    // Basic Auth from Worker secrets
    const username = env.OPENSKY_USERNAME;
    const password = env.OPENSKY_PASSWORD;
    if (username && password) {
      headers['Authorization'] = 'Basic ' + btoa(`${username}:${password}`);
    }

    // ── 5. Fetch from OpenSky ─────────────────────────────────────────────
    let raw;
    try {
      const controller = new AbortController();
      const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const resp = await fetch(openskyUrl, { headers, signal: controller.signal });
      clearTimeout(timer);

      // Surface typed errors so frontend fallback logic can act
      if (resp.status === 401) return empty('opensky_auth_failed_401');
      if (resp.status === 403) return empty('opensky_ip_blocked_403');
      if (resp.status === 429) {
        return empty('opensky_rate_limited_429', { 'Retry-After': '10' });
      }
      if (!resp.ok) {
        return empty(`opensky_upstream_${resp.status}`);
      }

      const text = await resp.text();
      try {
        raw = JSON.parse(text);
      } catch (_) {
        console.error('[opensky-proxy] JSON parse failure, body len:', text.length);
        return empty('opensky_json_parse_error');
      }
    } catch (err) {
      const msg = err && err.name === 'AbortError' ? 'opensky_timeout' : ('opensky_fetch_error: ' + (err.message || String(err)));
      console.error('[opensky-proxy]', msg);
      return empty(msg);
    }

    // ── 6. Validate response schema ───────────────────────────────────────
    if (!raw || typeof raw !== 'object') return empty('opensky_invalid_response_schema');
    // `states` is null when the bbox has no aircraft, which is valid
    const stateVectors = Array.isArray(raw.states) ? raw.states : [];

    // ── 7. Normalize state vectors → Argus schema ─────────────────────────
    const aircraft = [];
    const seen     = new Set();

    for (const sv of stateVectors) {
      if (aircraft.length >= MAX_AIRCRAFT) break;
      const norm = normalizeState(sv);
      if (!norm || seen.has(norm.icao24)) continue;
      seen.add(norm.icao24);
      aircraft.push(norm);
    }

    console.log(
      `[opensky-proxy] bbox=(${bbox.lamin},${bbox.lomin})→(${bbox.lamax},${bbox.lomax})`,
      `| raw=${stateVectors.length} normalised=${aircraft.length}`
    );

    // ── 8. Build payload ──────────────────────────────────────────────────
    const ts      = raw.time ? raw.time * 1000 : Date.now();
    const payload = { aircraft, source: 'opensky', ts, count: aircraft.length };

    // ── 9. Store in CF Cache ──────────────────────────────────────────────
    const toCache = new Response(JSON.stringify(payload), {
      status:  200,
      headers: Object.assign(
        { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_TTL_S}` },
        CORS
      ),
    });
    ctx.waitUntil(cache.put(cacheKey, toCache));

    // ── 10. Return to browser ─────────────────────────────────────────────
    return respond(payload, 200, {
      'X-Cache':       'MISS',
      'Cache-Control': `public, max-age=${CACHE_TTL_S}`,
    });
  },
};
