// adsbDiagnostic.js
// ADS-B proxy diagnostic — proxy path only.
//
// Phase 1 (direct browser fetch) has been intentionally removed.
// opendata.adsb.fi sends no Access-Control-Allow-Origin header, so a direct
// fetch always fails with a CORS error. More importantly, the browser still
// sends the request to the server before blocking the response — meaning Phase 1
// consumed a request against adsb.fi's rate limit every page load with zero
// diagnostic value. Proxy-only is the correct and only viable path.

const PROXY_URL = '/adsb/api/v2/lat/38/lon/-77/dist/249';

export async function runAdsbDiagnostic() {
  console.log('[adsbDiagnostic] ══ START ══  proxy path only');
  console.log('[adsbDiagnostic] fetching:', PROXY_URL);

  const t0 = performance.now();

  let resp;
  try {
    resp = await fetch(PROXY_URL, {
      method:  'GET',
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    const durationMs = Math.round(performance.now() - t0);
    console.error('[adsbDiagnostic] fetch threw:', err);
    const result = {
      ok:        false,
      status:    null,
      durationMs,
      error:     err.message || String(err),
      errorType: 'NETWORK',
      aircraft:  null,
      ts:        Date.now(),
    };
    return { proxy: result, usedProxy: true, final: result };
  }

  const durationMs = Math.round(performance.now() - t0);
  console.log('[adsbDiagnostic] HTTP', resp.status, 'in', durationMs, 'ms');

  const ct = resp.headers.get('content-type') || '';
  console.log('[adsbDiagnostic] content-type:', ct || '(none)');

  if (!ct.includes('application/json')) {
    const text = await resp.text();
    console.error('[adsbDiagnostic] INVALID RESPONSE — not JSON:', text.slice(0, 300));
    const result = {
      ok:        false,
      status:    resp.status,
      durationMs,
      error:     'Non-JSON response: ' + text.slice(0, 120),
      errorType: resp.status === 429 ? 'RATE_LIMITED' : 'INVALID_CONTENT_TYPE',
      aircraft:  null,
      ts:        Date.now(),
    };
    return { proxy: result, usedProxy: true, final: result };
  }

  if (!resp.ok) {
    console.error('[adsbDiagnostic] non-OK status:', resp.status);
    const result = {
      ok:        false,
      status:    resp.status,
      durationMs,
      error:     'HTTP ' + resp.status,
      errorType: 'HTTP_ERROR',
      aircraft:  null,
      ts:        Date.now(),
    };
    return { proxy: result, usedProxy: true, final: result };
  }

  let raw;
  try {
    raw = await resp.json();
  } catch (err) {
    console.error('[adsbDiagnostic] JSON parse failed:', err);
    const result = {
      ok:        false,
      status:    resp.status,
      durationMs,
      error:     'JSON parse error: ' + err.message,
      errorType: 'JSON_PARSE',
      aircraft:  null,
      ts:        Date.now(),
    };
    return { proxy: result, usedProxy: true, final: result };
  }

  console.log('[adsbDiagnostic] response keys:', Object.keys(raw || {}));

  const aircraft = Array.isArray(raw.aircraft) ? raw.aircraft : null;

  if (!aircraft) {
    console.warn('[adsbDiagnostic] no .aircraft array. Keys:', Object.keys(raw || {}));
    const result = {
      ok:        false,
      status:    resp.status,
      durationMs,
      error:     'No .aircraft array in response',
      errorType: 'EMPTY_SCHEMA',
      aircraft:  null,
      rawKeys:   Object.keys(raw || {}),
      ts:        Date.now(),
    };
    return { proxy: result, usedProxy: true, final: result };
  }

  console.log('[adsbDiagnostic] aircraft count:', aircraft.length);
  console.log('[adsbDiagnostic] ══ OK ══');

  const result = {
    ok:        true,
    status:    resp.status,
    durationMs,
    error:     null,
    errorType: null,
    aircraft,
    count:     aircraft.length,
    firstIcao: aircraft[0] ? (aircraft[0].hex || null) : null,
    ts:        Date.now(),
  };
  return { proxy: result, usedProxy: true, final: result };
}
