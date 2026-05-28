/**
 * opensky-proxy v2.1.0 — Cloudflare Worker (ES Module format)
 *
 * Chain: browser → this Worker (CORS: *) → opensky-network.org/api
 *
 * Secrets (set via: wrangler secret put <NAME>):
 *   OPENSKY_USERNAME — OpenSky account email
 *   OPENSKY_PASSWORD — OpenSky account password
 *
 * Endpoints:
 *   GET /?lamin=&lamax=&lomin=&lomax=   — live aircraft for bounding box
 *   GET /?mode=health                    — secret presence check (no upstream call)
 *   GET /?mode=probe                     — IP-block isolation test (calls OpenSky, low-cost)
 *
 * Response schema (aircraft endpoint — always HTTP 200):
 *   {
 *     aircraft: ArgusAircraftRecord[],
 *     source:   'opensky',
 *     ts:       number,        // epoch ms of OpenSky snapshot
 *     count:    number,
 *     workerV:  string,        // Worker version string
 *     error?:   string,        // typed error code, only on upstream failure
 *     cached?:  true,          // CF Cache API hit
 *   }
 *
 * Error codes surfaced in response.error:
 *   opensky_auth_failed_401     — bad credentials (check OPENSKY_USERNAME / OPENSKY_PASSWORD)
 *   opensky_ip_blocked_403      — CF IP rejected by OpenSky (use adsb.lol fallback)
 *   opensky_rate_limited_429    — quota exhausted; Retry-After header set
 *   opensky_timeout             — OpenSky did not respond within TIMEOUT_MS
 *   opensky_json_parse_error    — OpenSky returned non-JSON (body snippet in logs)
 *   opensky_upstream_NNN        — other upstream HTTP error
 *   opensky_fetch_error: MSG    — network-level failure
 *   opensky_invalid_schema      — response.states missing
 *   bbox_required               — missing bbox query params
 *
 * CORS: Access-Control-Allow-Origin: * on EVERY response path, including errors.
 * Cache: CF Cache API, CACHE_TTL_S (15s) per unique bbox.
 * Logging: structured JSON lines → visible in Cloudflare Dashboard > Worker > Logs.
 */

// ── Version ───────────────────────────────────────────────────────────────────
const WORKER_VERSION = '2.1.0';

// ── Constants ─────────────────────────────────────────────────────────────────
const OPENSKY_BASE = 'https://opensky-network.org/api/states/all';
const TIMEOUT_MS   = 9000;   // 9s headroom before CF's 30s wall clock
const CACHE_TTL_S  = 15;     // safe for authenticated 5 req/10s limit
const MAX_AIRCRAFT = 750;    // match Argus renderer ceiling

// Bbox hard caps (server-side clamp — belt+suspenders over client validation)
const MAX_LAT_SPAN = 50;     // degrees — OpenSky undocumented limit; stay conservative
const MAX_LON_SPAN = 90;     // degrees

// Probe bbox — tiny area over equatorial Atlantic, almost always empty, low cost
const PROBE_BBOX = { lamin: 0, lamax: 1, lomin: -20, lomax: -19 };

// ── CORS headers — on every response path ────────────────────────────────────
// DO NOT REMOVE OR MODIFY. Browser compatibility is mission-critical.
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Vary':                         'Origin',
};

// ── Shared response header baseline ──────────────────────────────────────────
// Applied to every outbound response so clients can always read the Worker version.
function baseHeaders(extra) {
  return Object.assign(
    { 'Content-Type': 'application/json', 'X-Worker-Version': WORKER_VERSION },
    CORS,
    extra || {}
  );
}

// ── Unified response helper ───────────────────────────────────────────────────
function respond(payload, status, extra) {
  return new Response(JSON.stringify(payload), {
    status:  status || 200,
    headers: baseHeaders(extra),
  });
}

// Returns HTTP 200 with empty aircraft array and typed error code.
// ALL upstream failures go through here — browser always gets CORS-safe 200.
function empty(errorCode, upstreamStatus, extra) {
  return respond(
    {
      aircraft: [],
      source:   'opensky',
      ts:       Date.now(),
      count:    0,
      workerV:  WORKER_VERSION,
      error:    errorCode,
      ...(upstreamStatus != null ? { upstreamStatus } : {}),
    },
    200,
    extra
  );
}

// ── Structured logger ─────────────────────────────────────────────────────────
// Emits JSON lines visible in Cloudflare Dashboard → Workers → Logs (Realtime).
// Format is compatible with CF Logpush → Datadog / Splunk / S3 pipelines.
function log(level, event, fields) {
  const line = JSON.stringify(
    Object.assign({ ts: Date.now(), level, event, workerV: WORKER_VERSION }, fields || {})
  );
  if (level === 'error') console.error(line);
  else if (level === 'warn')  console.warn(line);
  else console.log(line);
}

// ── Bbox validation + clamp ───────────────────────────────────────────────────
function parseBbox(params) {
  let lamin = parseFloat(params.get('lamin'));
  let lamax = parseFloat(params.get('lamax'));
  let lomin = parseFloat(params.get('lomin'));
  let lomax = parseFloat(params.get('lomax'));

  if (!isFinite(lamin) || !isFinite(lamax) || !isFinite(lomin) || !isFinite(lomax)) return null;

  // Clamp to valid global ranges
  lamin = Math.max(-90,  lamin);
  lamax = Math.min( 90,  lamax);
  lomin = Math.max(-180, lomin);
  lomax = Math.min( 180, lomax);

  if (lamin >= lamax || lomin >= lomax) return null;

  // Server-side span cap
  const latSpan = lamax - lamin;
  const lonSpan = lomax - lomin;

  if (latSpan > MAX_LAT_SPAN) {
    const center = (lamin + lamax) / 2;
    lamin = center - MAX_LAT_SPAN / 2;
    lamax = center + MAX_LAT_SPAN / 2;
  }
  if (lonSpan > MAX_LON_SPAN) {
    const center = (lomin + lomax) / 2;
    lomin = center - MAX_LON_SPAN / 2;
    lomax = center + MAX_LON_SPAN / 2;
  }

  return {
    lamin: parseFloat(lamin.toFixed(4)),
    lamax: parseFloat(lamax.toFixed(4)),
    lomin: parseFloat(lomin.toFixed(4)),
    lomax: parseFloat(lomax.toFixed(4)),
  };
}

// ── Basic Auth builder ────────────────────────────────────────────────────────
function buildAuthHeader(username, password) {
  if (!username || !password) return null;
  return 'Basic ' + btoa(`${username}:${password}`);
}

// ── OpenSky state-vector → Argus aircraft record ──────────────────────────────
// OpenSky state vector (index-addressed array):
//   0  icao24         string
//   1  callsign       string|null
//   2  origin_country string
//   3  time_position  int (unix s) | null
//   4  last_contact   int (unix s)
//   5  longitude      float|null  (decimal degrees WGS84)
//   6  latitude       float|null  (decimal degrees WGS84)
//   7  baro_altitude  float|null  (meters)
//   8  on_ground      bool
//   9  velocity       float|null  (m/s ground speed)
//  10  true_track     float|null  (degrees CW from north)
//  11  vertical_rate  float|null  (m/s — positive=climb)
//  12  sensors        int[]|null
//  13  geo_altitude   float|null  (meters)
//  14  squawk         string|null
//  15  spi            bool
//  16  position_source int        (0=ADS-B, 1=ASTERIX, 2=MLAT, 3=FLARM)
function normalizeState(sv) {
  if (!Array.isArray(sv) || sv.length < 17) return null;

  const icao24   = typeof sv[0] === 'string' ? sv[0].trim().toLowerCase() : null;
  const lon      = sv[5];
  const lat      = sv[6];
  const onGround = sv[8];

  if (!icao24)                                           return null;
  if (lat == null || lon == null)                        return null;
  if (!isFinite(lat) || !isFinite(lon))                  return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  if (onGround)                                          return null; // skip ground traffic

  const cs = typeof sv[1] === 'string' ? sv[1].trim() || null : null;

  // Altitude: baro preferred, geo fallback. Convert meters → feet.
  const baroM = (sv[7]  != null && isFinite(sv[7]))  ? sv[7]  : null;
  const geoM  = (sv[13] != null && isFinite(sv[13])) ? sv[13] : null;
  const altM  = baroM ?? geoM;
  const altFt = altM != null ? Math.round(altM * 3.28084) : null;

  // Velocity m/s → knots
  const velMs = (sv[9]  != null && isFinite(sv[9]))  ? sv[9]  : null;
  const gs    = velMs != null ? Math.round(velMs * 1.94384) : null;

  const track = (sv[10] != null && isFinite(sv[10])) ? sv[10] : null;

  // Vertical rate m/s → ft/min for phase
  const vrMs    = (sv[11] != null && isFinite(sv[11])) ? sv[11] : null;
  const vrFtMin = vrMs != null ? vrMs * 196.85 : null;
  let phase = 'cruise';
  if (vrFtMin != null) {
    if (vrFtMin >  500) phase = 'climb';
    else if (vrFtMin < -500) phase = 'descent';
  }

  // Flight type by callsign prefix (3-letter ICAO airline code)
  const pfx = (cs || '').slice(0, 3).toUpperCase();
  const MILITARY   = ['RCH', 'BAF', 'RAF', 'AMC', 'NAV', 'DUKE', 'EXEC', 'JAKE'];
  const CARGO      = ['FDX', 'UPS', 'CLX', 'GTI', 'ABX', 'PAC', 'ATN', 'DHL'];
  const COMMERCIAL = ['DAL', 'UAL', 'AAL', 'SWA', 'BAW', 'AFR', 'KLM', 'DLH',
                      'UAE', 'SIA', 'QFA', 'IBE', 'TAP', 'TUI', 'THY', 'ETD', 'EZY', 'RYR'];
  let flightType = 'unknown';
  if (MILITARY.includes(pfx))                  flightType = 'military';
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

// ── Core fetch: calls OpenSky, returns { ok, status, body?, error? } ──────────
// Encapsulated so health/probe/live paths share the same fetch logic.
async function fetchOpenSky(url, authHeader) {
  const headers = {
    'Accept':     'application/json',
    'User-Agent': 'ArgusIntel/1.0 (contact: ops@argusintel.live)',
  };
  if (authHeader) headers['Authorization'] = authHeader;

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);

    if (!resp.ok) {
      // Read a snippet of the error body — critical for diagnosis
      const bodySnippet = await resp.text().catch(() => '').then(t => t.slice(0, 400));
      return { ok: false, status: resp.status, bodySnippet };
    }

    const text = await resp.text();
    clearTimeout(timer);
    return { ok: true, status: resp.status, text };

  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err && err.name === 'AbortError';
    return { ok: false, status: null, error: isTimeout ? 'timeout' : (err.message || String(err)) };
  }
}

// ── Worker entry point ────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {

    // ── 1. CORS preflight ─────────────────────────────────────────────────
    // MUST be first. Never add logic above this block.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: baseHeaders() });
    }

    if (request.method !== 'GET') {
      return empty('method_not_allowed', null);
    }

    const url    = new URL(request.url);
    const mode   = url.searchParams.get('mode');
    const hasUsername = !!(env.OPENSKY_USERNAME && env.OPENSKY_USERNAME.length > 0);
    const hasPassword = !!(env.OPENSKY_PASSWORD && env.OPENSKY_PASSWORD.length > 0);
    const authHeader  = buildAuthHeader(env.OPENSKY_USERNAME, env.OPENSKY_PASSWORD);

    // ── 2. Health endpoint ────────────────────────────────────────────────
    // No upstream call. Returns secret presence and config.
    // Usage: fetch('https://opensky-proxy.aidanhurley12.workers.dev/?mode=health')
    if (mode === 'health') {
      log('info', 'health_check', { hasUsername, hasPassword, hasAuth: !!(authHeader) });
      return respond({
        status:        'ok',
        workerV:       WORKER_VERSION,
        openskyBase:   OPENSKY_BASE,
        hasUsername,
        hasPassword,
        hasAuth:       !!(authHeader),
        cacheTtlS:     CACHE_TTL_S,
        maxAircraft:   MAX_AIRCRAFT,
        maxLatSpan:    MAX_LAT_SPAN,
        maxLonSpan:    MAX_LON_SPAN,
        ts:            Date.now(),
        note:          !authHeader
          ? 'WARNING: secrets missing — bbox queries require authentication'
          : 'secrets present — authenticated requests will be sent',
      }, 200);
    }

    // ── 3. Probe endpoint — IP-block isolation test ───────────────────────
    // Calls OpenSky with a tiny 1°×1° bbox twice: once with auth, once without.
    // Conclusively distinguishes IP block from credential failure.
    //
    // Usage: fetch('https://opensky-proxy.aidanhurley12.workers.dev/?mode=probe')
    //
    // Interpretation:
    //   authStatus=200, anonStatus=200 → Working. Auth is valid.
    //   authStatus=403, anonStatus=403 → CF IP is blocked by OpenSky.
    //   authStatus=401, anonStatus=200 → IP ok. Credentials wrong.
    //   authStatus=200, anonStatus=403 → Auth works (unblocked). Anon blocked.
    //   authStatus=403, anonStatus=200 → Credentials triggering block (unlikely).
    if (mode === 'probe') {
      const probeUrl = `${OPENSKY_BASE}?lamin=${PROBE_BBOX.lamin}&lamax=${PROBE_BBOX.lamax}&lomin=${PROBE_BBOX.lomin}&lomax=${PROBE_BBOX.lomax}`;

      const [authResult, anonResult] = await Promise.allSettled([
        fetchOpenSky(probeUrl, authHeader),
        fetchOpenSky(probeUrl, null),         // anonymous — no auth
      ]);

      const authR = authResult.status === 'fulfilled' ? authResult.value : { error: authResult.reason };
      const anonR = anonResult.status === 'fulfilled' ? anonResult.value : { error: anonResult.reason };

      let inference = 'unknown';
      if (authR.status === 200)                                   inference = 'working';
      else if (authR.status === 403 && anonR.status === 403)      inference = 'ip_blocked';
      else if (authR.status === 401 && anonR.status === 200)      inference = 'credentials_invalid';
      else if (authR.status === 401 && anonR.status === 403)      inference = 'ip_blocked_and_no_credentials';
      else if (authR.error === 'timeout' || anonR.error === 'timeout') inference = 'opensky_unreachable';
      else if (authR.status === 403 && anonR.status === 200)      inference = 'auth_credentials_blocked';

      log('info', 'probe_complete', {
        authStatus: authR.status, authError: authR.error,
        anonStatus: anonR.status, anonError: anonR.error,
        inference, hasAuth: !!(authHeader),
      });

      return respond({
        workerV:     WORKER_VERSION,
        probeUrl,
        hasAuth:     !!(authHeader),
        hasUsername, hasPassword,
        auth: {
          status:      authR.status,
          ok:          authR.ok,
          error:       authR.error || null,
          bodySnippet: authR.bodySnippet || null,
        },
        anon: {
          status:      anonR.status,
          ok:          anonR.ok,
          error:       anonR.error || null,
          bodySnippet: anonR.bodySnippet || null,
        },
        inference,
        ts: Date.now(),
      }, 200);
    }

    // ── 4. Live aircraft endpoint ─────────────────────────────────────────

    // Parse + clamp bbox
    const bbox = parseBbox(url.searchParams);
    if (!bbox) {
      log('warn', 'missing_bbox', { url: request.url });
      return empty('bbox_required: provide lamin, lamax, lomin, lomax', null);
    }

    log('info', 'request', {
      bbox,
      hasAuth: !!(authHeader),
      requestId: request.headers.get('cf-ray') || null,
    });

    // ── 5. CF Cache check ─────────────────────────────────────────────────
    const cache    = caches.default;
    const cacheKey = new Request(
      `${OPENSKY_BASE}?lamin=${bbox.lamin}&lamax=${bbox.lamax}&lomin=${bbox.lomin}&lomax=${bbox.lomax}`,
      { method: 'GET' }
    );

    const cacheHit = await cache.match(cacheKey);
    if (cacheHit) {
      const body = await cacheHit.json();
      log('info', 'cache_hit', { bbox, count: body.count });
      return respond(
        Object.assign({}, body, { cached: true, workerV: WORKER_VERSION }),
        200,
        { 'X-Cache': 'HIT', 'Cache-Control': `public, max-age=${CACHE_TTL_S}` }
      );
    }

    // ── 6. Fetch from OpenSky ─────────────────────────────────────────────
    const openskyUrl = `${OPENSKY_BASE}?lamin=${bbox.lamin}&lamax=${bbox.lamax}&lomin=${bbox.lomin}&lomax=${bbox.lomax}`;
    const result     = await fetchOpenSky(openskyUrl, authHeader);

    if (!result.ok) {
      // result.status is null on network-level failure; number on HTTP error
      const code = result.error === 'timeout'    ? 'opensky_timeout'
                 : result.status === 401         ? 'opensky_auth_failed_401'
                 : result.status === 403         ? 'opensky_ip_blocked_403'
                 : result.status === 429         ? 'opensky_rate_limited_429'
                 : result.error                  ? `opensky_fetch_error: ${result.error}`
                 :                                 `opensky_upstream_${result.status}`;

      log('warn', 'upstream_failure', {
        code,
        upstreamStatus:      result.status,
        upstreamBodySnippet: result.bodySnippet || null,
        hasAuth:             !!(authHeader),
        bbox,
      });

      const extra = result.status === 429 ? { 'Retry-After': '10' } : undefined;
      return empty(code, result.status, extra);
    }

    // ── 7. Parse JSON ──────────────────────────────────────────────────────
    let raw;
    try {
      raw = JSON.parse(result.text);
    } catch (_) {
      log('error', 'json_parse_error', {
        bodyLen:    result.text.length,
        bodyPrefix: result.text.slice(0, 100),
        bbox,
      });
      return empty('opensky_json_parse_error', 200);
    }

    // ── 8. Validate schema ─────────────────────────────────────────────────
    if (!raw || typeof raw !== 'object') {
      log('error', 'invalid_schema', { type: typeof raw, bbox });
      return empty('opensky_invalid_schema', 200);
    }

    // `states` is null (not missing) when bbox contains no aircraft — that is valid.
    const stateVectors = Array.isArray(raw.states) ? raw.states : [];

    // ── 9. Normalize state vectors ─────────────────────────────────────────
    const aircraft = [];
    const seen     = new Set();

    for (const sv of stateVectors) {
      if (aircraft.length >= MAX_AIRCRAFT) break;
      const norm = normalizeState(sv);
      if (!norm || seen.has(norm.icao24)) continue;
      seen.add(norm.icao24);
      aircraft.push(norm);
    }

    const ts = raw.time ? raw.time * 1000 : Date.now();

    log('info', 'success', {
      bbox,
      rawStates:  stateVectors.length,
      normalised: aircraft.length,
      openskyTs:  ts,
      hasAuth:    !!(authHeader),
    });

    // ── 10. Build payload ──────────────────────────────────────────────────
    const payload = {
      aircraft,
      source:  'opensky',
      ts,
      count:   aircraft.length,
      workerV: WORKER_VERSION,
    };

    // ── 11. Store in CF Cache ──────────────────────────────────────────────
    const toCache = new Response(JSON.stringify(payload), {
      status:  200,
      headers: Object.assign(
        { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_TTL_S}` },
        CORS
      ),
    });
    ctx.waitUntil(cache.put(cacheKey, toCache));

    // ── 12. Return to browser ──────────────────────────────────────────────
    return respond(payload, 200, {
      'X-Cache':       'MISS',
      'Cache-Control': `public, max-age=${CACHE_TTL_S}`,
    });
  },
};
