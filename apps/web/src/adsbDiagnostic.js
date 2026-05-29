// adsbDiagnostic.js
// ADS-B data acquisition diagnostic harness.
//
// Phase 1: direct browser fetch to opendata.adsb.fi
// Phase 2: if CORS failure detected, retry via Vite dev proxy at /adsb
//
// Returns a result object — never throws. All errors are captured and returned.

const DIRECT_URL = 'https://opendata.adsb.fi/api/v2/lat/38/lon/-77/dist/250';
const PROXY_URL  = '/adsb/api/v2/lat/38/lon/-77/dist/250';

// Attempt a single fetch and return a structured result.
async function attemptFetch(url, label) {
  console.log(`[adsbDiagnostic] ${label} — fetching: ${url}`);
  const t0 = performance.now();

  let resp;
  try {
    resp = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
  } catch (err) {
    const durationMs = Math.round(performance.now() - t0);
    const isCors = err instanceof TypeError && err.message.toLowerCase().includes('failed to fetch');
    console.error(`[adsbDiagnostic] ${label} — network error after ${durationMs}ms:`, err);
    return {
      url,
      label,
      ok:          false,
      status:      null,
      durationMs,
      error:       err.message || String(err),
      errorType:   isCors ? 'CORS_OR_NETWORK' : 'NETWORK',
      aircraft:    null,
      ts:          Date.now(),
    };
  }

  const durationMs = Math.round(performance.now() - t0);
  console.log(`[adsbDiagnostic] ${label} — HTTP ${resp.status} in ${durationMs}ms`);

  if (!resp.ok) {
    console.error(`[adsbDiagnostic] ${label} — non-OK status: ${resp.status} ${resp.statusText}`);
    return {
      url,
      label,
      ok:        false,
      status:    resp.status,
      durationMs,
      error:     `HTTP ${resp.status} ${resp.statusText}`,
      errorType: 'HTTP_ERROR',
      aircraft:  null,
      ts:        Date.now(),
    };
  }

  let raw;
  try {
    raw = await resp.json();
  } catch (err) {
    console.error(`[adsbDiagnostic] ${label} — JSON parse failed:`, err);
    return {
      url,
      label,
      ok:        false,
      status:    resp.status,
      durationMs,
      error:     'JSON parse error: ' + (err.message || String(err)),
      errorType: 'JSON_PARSE',
      aircraft:  null,
      ts:        Date.now(),
    };
  }

  // ── Full raw response dump ────────────────────────────────────────────────
  console.log(`[adsbDiagnostic] ${label} — RAW RESPONSE:`, raw);
  console.log(`[adsbDiagnostic] ${label} — response keys:`, Object.keys(raw || {}));

  // adsb.fi response shape: { ac: [...], msg: string, now: epoch, total: N, ctime: N, ptime: N }
  const aircraft = Array.isArray(raw.ac) ? raw.ac : null;

  console.log(`[adsbDiagnostic] ${label} — aircraft array exists:`, aircraft !== null);
  console.log(`[adsbDiagnostic] ${label} — aircraft count:`, aircraft ? aircraft.length : 'N/A');

  if (!aircraft) {
    console.warn(`[adsbDiagnostic] ${label} — no .ac array in response. Keys:`, Object.keys(raw || {}));
    return {
      url,
      label,
      ok:        true,
      status:    resp.status,
      durationMs,
      error:     'Response has no .ac aircraft array',
      errorType: 'EMPTY_SCHEMA',
      aircraft:  null,
      rawKeys:   Object.keys(raw || {}),
      ts:        Date.now(),
    };
  }

  if (aircraft.length === 0) {
    console.warn(`[adsbDiagnostic] ${label} — aircraft array is empty (0 aircraft in bbox)`);
  } else {
    console.log(`[adsbDiagnostic] ${label} — first 3 aircraft:`);
    aircraft.slice(0, 3).forEach((ac, i) => {
      console.log(`  [${i}]`, ac);
    });
  }

  return {
    url,
    label,
    ok:          true,
    status:      resp.status,
    durationMs,
    error:       null,
    errorType:   null,
    aircraft,
    count:       aircraft.length,
    firstIcao:   aircraft[0] ? (aircraft[0].hex || aircraft[0].icao24 || null) : null,
    ts:          Date.now(),
  };
}

// ── Public entry point ────────────────────────────────────────────────────────
// Phase 1: direct. Phase 2: proxy fallback only on CORS/network failure.
export async function runAdsbDiagnostic() {
  console.log('[adsbDiagnostic] ══ START DIAGNOSTIC ══');
  console.log('[adsbDiagnostic] Phase 1: direct browser fetch to opendata.adsb.fi');

  const direct = await attemptFetch(DIRECT_URL, 'DIRECT');

  // Phase 2 only if direct failed with a CORS or network error
  // (HTTP errors from the server mean we reached it — no proxy needed)
  const needsProxy = !direct.ok && (direct.errorType === 'CORS_OR_NETWORK' || direct.errorType === 'NETWORK');

  if (!needsProxy) {
    console.log('[adsbDiagnostic] Phase 2 not required — direct fetch', direct.ok ? 'SUCCEEDED' : 'failed with non-CORS error');
    console.log('[adsbDiagnostic] ══ END DIAGNOSTIC ══', direct);
    return { direct, proxy: null, usedProxy: false, final: direct };
  }

  console.log('[adsbDiagnostic] Phase 1 CORS/network failure detected — falling back to Vite proxy');
  console.log('[adsbDiagnostic] Phase 2: proxy fetch via /adsb (vite.config.js server.proxy)');

  const proxy = await attemptFetch(PROXY_URL, 'PROXY');

  console.log('[adsbDiagnostic] ══ END DIAGNOSTIC ══', { direct, proxy });
  return { direct, proxy, usedProxy: true, final: proxy };
}
