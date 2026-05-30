// netlify/functions/fetch-maritime-supplement.js
// Server-side proxy for supplemental maritime AIS data — Digitraffic.fi (Väylävirasto).
//
// GET /.netlify/functions/fetch-maritime-supplement
//   → { vessels: ArgusVessel[], source: string, ts: number, diagnostics: object }
//
// GET /.netlify/functions/fetch-maritime-supplement?probe=1
//   → { probes: { digitraffic: { ok, count? | error? } } }
//
// Filters applied server-side:
//   - lat/lon must be valid
//   - sog > 0.3 kt  (skip anchored/moored vessels that clutter the view)
//   - shipType not in SKIP_TYPES  (skip recreational + local harbor craft)
//
// Output is sorted by SOG descending (moving vessels first).
// CDN cache: 2 min (matches Digitraffic's ~2-min update cadence).

'use strict';

const DIGITRAFFIC_POS  = 'https://meri.digitraffic.fi/api/v1/locations/latest';
const DIGITRAFFIC_META = 'https://meri.digitraffic.fi/api/v1/metadata/vessels';

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
  'Cache-Control':                'public, max-age=120, stale-while-revalidate=60',
};

// Recreational (36, 37) + local harbor craft (50=pilot, 51=SAR, 53=port tender, 54=anti-pollution)
const SKIP_TYPES = new Set([36, 37, 50, 51, 53, 54]);

// ── Vessel type classification (mirrors normalizeVessel.js classifyType) ───────
function classifyType(shipType) {
  const num = parseInt(shipType, 10);
  if (isNaN(num) || num <= 0)                    return 'unknown';
  if (num === 35)                                return 'military';
  if (num === 30)                                return 'fishing';
  if (num === 31 || num === 32 || num === 52)    return 'tug';
  if (num === 36 || num === 37)                  return 'recreational';
  if (num >= 50 && num <= 59)                    return 'port_service';
  if (num >= 60 && num <= 69)                    return 'passenger';
  if (num >= 70 && num <= 79)                    return 'cargo';
  if (num >= 80 && num <= 89)                    return 'tanker';
  return 'unknown';
}

// ── Field sanitizers ──────────────────────────────────────────────────────────
function _lat(v) { const n = parseFloat(v); return (!isNaN(n) && n >= -90  && n <= 90)  ? +n.toFixed(4) : null; }
function _lon(v) { const n = parseFloat(v); return (!isNaN(n) && n >= -180 && n <= 180) ? +n.toFixed(4) : null; }
function _sog(v) { const n = parseFloat(v); return (!isNaN(n) && n >= 0 && n <= 102.2)  ? +n.toFixed(2) : null; }
function _cog(v) { const n = parseFloat(v); return (!isNaN(n) && n >= 0 && n <= 360)    ? +n.toFixed(1) : null; }
function _head(v) { const n = parseInt(v, 10); return (!isNaN(n) && n !== 511 && n >= 0 && n <= 359) ? n : null; }
function _mmsi(v) { const s = v != null ? String(v).replace(/\D/g, '') : ''; return s.length ? s.padStart(9, '0') : null; }
function _str(v)  { return v != null ? String(v).trim() || null : null; }

// ── Digitraffic GeoJSON feature → canonical vessel ────────────────────────────
// feature: { mmsi, geometry:{coordinates:[lon,lat]}, properties:{sog,cog,heading,navStat,shipType,updateTime} }
// meta:    { mmsi, name, callSign, imo, destination, eta }  (may be null)
function normalizeDigitraffic(feature, meta) {
  const m      = meta || {};
  const p      = feature.properties || {};
  const coords = (feature.geometry && feature.geometry.coordinates) || [];

  const mmsiStr  = _mmsi(feature.mmsi || p.mmsi);
  const lat      = _lat(coords.length >= 2 ? coords[1] : null);
  const lon      = _lon(coords.length >= 2 ? coords[0] : null);
  if (!mmsiStr || lat === null || lon === null) return null;

  const sog      = _sog(p.sog);
  const shipType = p.shipType != null ? parseInt(p.shipType, 10) : null;

  // Filter: skip anchored/moored/stationary
  if (sog !== null && sog <= 0.3) return null;
  // Filter: skip recreational + local harbor craft
  if (shipType !== null && SKIP_TYPES.has(shipType)) return null;

  return {
    id:           'digitraffic:' + mmsiStr,
    mmsi:         mmsiStr,
    imo:          _str(m.imo),
    name:         _str(m.name || p.name) || 'VESSEL',
    callsign:     _str(m.callSign || m.callsign),
    lat,
    lon,
    sog,
    cog:          _cog(p.cog),
    heading:      _head(p.heading),
    navStatus:    p.navStat != null ? parseInt(p.navStat, 10) : null,
    vesselType:   shipType,
    typeCategory: classifyType(shipType),
    destination:  _str(m.destination),
    eta:          _str(m.eta),
    length:       null,
    width:        null,
    flag:         null,
    source:       'digitraffic',
    lastUpdate:   p.updateTime ? new Date(p.updateTime).getTime() : Date.now(),
  };
}

// ── Fetch with timeout ────────────────────────────────────────────────────────
async function fetchJSON(url, timeoutMs) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal:  controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'ArgusIntel/1.0' },
    });
    clearTimeout(timer);
    if (!res.ok) {
      const e = new Error(`HTTP ${res.status}`);
      e.httpStatus = res.status;
      throw e;
    }
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS, body: '' };
  }

  const params = event.queryStringParameters || {};

  // ── Probe mode: verify provider reachability ──────────────────────────────
  if (params.probe === '1') {
    let probeResult;
    try {
      const data  = await fetchJSON(DIGITRAFFIC_POS, 8000);
      const count = data && Array.isArray(data.features) ? data.features.length : 0;
      probeResult = { ok: true, count };
    } catch (err) {
      probeResult = { ok: false, error: err.message };
    }
    return {
      statusCode: 200,
      headers:    HEADERS,
      body: JSON.stringify({ probes: { digitraffic: probeResult } }),
    };
  }

  // ── Normal mode: fetch + normalize + return ───────────────────────────────
  const t0   = Date.now();
  const diag = { digitraffic: {} };

  try {
    // Fetch positions and metadata in parallel — metadata failure is non-fatal
    const [posResult, metaResult] = await Promise.allSettled([
      fetchJSON(DIGITRAFFIC_POS,  14000),
      fetchJSON(DIGITRAFFIC_META, 14000),
    ]);

    // Build metadata lookup (MMSI → metadata object)
    const metaMap = new Map();
    if (metaResult.status === 'fulfilled' && Array.isArray(metaResult.value)) {
      metaResult.value.forEach(m => {
        const mmsi = _mmsi(m.mmsi);
        if (mmsi) metaMap.set(mmsi, m);
      });
      diag.digitraffic.metaCount = metaMap.size;
    } else if (metaResult.status === 'rejected') {
      diag.digitraffic.metaError = metaResult.reason ? metaResult.reason.message : 'unknown';
    }

    // Normalize position features
    const vessels = [];
    if (posResult.status === 'fulfilled') {
      const features = (posResult.value && Array.isArray(posResult.value.features))
        ? posResult.value.features : [];
      diag.digitraffic.rawCount = features.length;

      features.forEach(feature => {
        const mmsiStr = _mmsi(feature.mmsi);
        const meta    = mmsiStr ? metaMap.get(mmsiStr) : null;
        const vessel  = normalizeDigitraffic(feature, meta);
        if (vessel) vessels.push(vessel);
      });
    } else {
      const err = posResult.reason;
      diag.digitraffic.posError = err ? err.message : 'unknown';
      console.error('[fetch-maritime-supplement] Digitraffic positions failed:', diag.digitraffic.posError);
    }

    // Sort by SOG descending — moving vessels take priority on cap
    vessels.sort((a, b) => (b.sog || 0) - (a.sog || 0));

    diag.digitraffic.outputCount = vessels.length;
    diag.durationMs              = Date.now() - t0;

    console.log(
      `[fetch-maritime-supplement] ${vessels.length} vessels (${diag.durationMs}ms)` +
      ` | raw=${diag.digitraffic.rawCount || 0} meta=${diag.digitraffic.metaCount || 0}`
    );

    return {
      statusCode: 200,
      headers:    HEADERS,
      body: JSON.stringify({
        vessels,
        source:      'digitraffic',
        ts:          Date.now(),
        diagnostics: diag,
      }),
    };

  } catch (err) {
    console.error('[fetch-maritime-supplement] fatal:', err.message);
    return {
      statusCode: 502,
      headers:    HEADERS,
      body: JSON.stringify({
        error:       err.message,
        vessels:     [],
        source:      'digitraffic',
        ts:          Date.now(),
        diagnostics: diag,
      }),
    };
  }
};
