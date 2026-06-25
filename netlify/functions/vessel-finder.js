// netlify/functions/vessel-finder.js
// Server-side proxy for the VesselFinder Vessels API (AIS + Voyage + Master + PortCalls).
//
// Setup:
//   Netlify → Site → Environment variables → VESSELFINDER_API_KEY = your_userkey
//
// Actions (query param ?action=):
//
//   positions  — AIS vessel positions within a bounding box (Tier 1 — must have)
//     ?action=positions&minLat=&maxLat=&minLon=&maxLon=
//     → { vessels: AISObject[], count, action, ts }
//     → Cache: public, max-age=60
//
//   details    — Full vessel record for one MMSI, with optional extradata enrichment
//     ?action=details&mmsi=&extradata=voyage|master
//     → { vessel: AISObject, action, ts }
//     → Cache: no-store
//
//   portcalls  — Port call history for one MMSI (via extradata=portcalls)
//     ?action=portcalls&mmsi=
//     → { calls: PortCallObject[], mmsi, action, ts }
//     → Cache: no-store
//
// VesselFinder Vessels API base: https://api.vesselfinder.com
// Auth: userkey passed as query param (not header, not path)
// Response: [[{"AIS":{...}}], ...] — array of single-item arrays, each wrapping an AIS object
//
// Server-side filters (positions action):
//   skip vessel types 36, 37, 50, 51, 53, 54 (recreational + local harbor craft)
//   skip vessels with invalid or missing lat/lon
//   sort by SPEED descending (most active vessels first)
//
// The browser-side module (vesselFinderProvider.js) handles:
//   viewport-aware bbox queries, adaptive polling intervals, normalization

'use strict';

const VF_BASE = process.env.VESSELFINDER_BASE_URL || 'https://api.vesselfinder.com';

const SKIP_TYPES = new Set([36, 37, 50, 51, 53, 54]);

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

// ── Unpack VesselFinder's nested array-of-arrays format ───────────────────────
// Response shape: [[{"AIS":{...}}], [{"AIS":{...}}], ...]
// Extracts and returns the inner AIS objects.
function extractVessels(payload) {
  if (!Array.isArray(payload)) return [];
  const out = [];
  for (const outer of payload) {
    const inner = Array.isArray(outer) ? outer[0] : outer;
    if (inner && inner.AIS && typeof inner.AIS === 'object') {
      out.push(inner.AIS);
    }
  }
  return out;
}

function hasPosition(ais) {
  const lat = parseFloat(ais.LATITUDE);
  const lon = parseFloat(ais.LONGITUDE);
  return !isNaN(lat) && lat >= -90 && lat <= 90 &&
         !isNaN(lon) && lon >= -180 && lon <= 180 &&
         !(lat === 0 && lon === 0);
}

function respond(statusCode, body, cache) {
  const headers = { ...CORS };
  if (cache) headers['Cache-Control'] = cache;
  return { statusCode, headers, body: JSON.stringify(body) };
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const apiKey = process.env.VESSELFINDER_API_KEY;
  if (!apiKey) {
    console.error('[vessel-finder] VESSELFINDER_API_KEY not configured');
    return respond(503, { error: 'VESSELFINDER_API_KEY not configured' });
  }

  const p      = event.queryStringParameters || {};
  const action = p.action || 'positions';
  const ts     = Date.now();

  // ── Action: positions ──────────────────────────────────────────────────────
  if (action === 'positions') {
    const minLat = parseFloat(p.minLat);
    const maxLat = parseFloat(p.maxLat);
    const minLon = parseFloat(p.minLon);
    const maxLon = parseFloat(p.maxLon);

    if ([minLat, maxLat, minLon, maxLon].some(isNaN)) {
      return respond(400, { error: 'positions requires minLat, maxLat, minLon, maxLon' });
    }

    const url = `${VF_BASE}/vessels?userkey=${encodeURIComponent(apiKey)}&format=json` +
                `&lat_min=${Math.max(-90, minLat)}&lat_max=${Math.min(90, maxLat)}` +
                `&lon_min=${Math.max(-180, minLon)}&lon_max=${Math.min(180, maxLon)}`;

    let raw;
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error('[vessel-finder] positions upstream HTTP', res.status, body.slice(0, 200));
        return respond(res.status, { error: 'VesselFinder upstream error', httpStatus: res.status });
      }
      raw = await res.json();
    } catch (err) {
      console.error('[vessel-finder] positions fetch error:', err.message);
      return respond(502, { error: 'Upstream fetch failed', detail: err.message });
    }

    const vessels = extractVessels(raw)
      .filter(v => {
        if (!hasPosition(v)) return false;
        const t = parseInt(v.TYPE, 10);
        return isNaN(t) || !SKIP_TYPES.has(t);
      })
      .sort((a, b) => (parseFloat(b.SPEED) || 0) - (parseFloat(a.SPEED) || 0));

    console.log(`[vessel-finder] positions: ${vessels.length} vessels bbox ${minLat}/${maxLat}/${minLon}/${maxLon}`);
    return respond(200, { vessels, count: vessels.length, action, ts }, 'public, max-age=60, stale-while-revalidate=30');
  }

  // ── Action: details ────────────────────────────────────────────────────────
  if (action === 'details') {
    const mmsi      = (p.mmsi || '').replace(/\D/g, '');
    const extradata = p.extradata || '';  // 'voyage' | 'master' | ''

    if (!mmsi) return respond(400, { error: 'details requires mmsi' });

    let url = `${VF_BASE}/vessels?userkey=${encodeURIComponent(apiKey)}&format=json&mmsi=${mmsi}`;
    if (extradata === 'voyage' || extradata === 'master') {
      url += `&extradata=${extradata}`;
    }

    let raw;
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) return respond(res.status, { error: 'VesselFinder upstream error', httpStatus: res.status });
      raw = await res.json();
    } catch (err) {
      return respond(502, { error: 'Upstream fetch failed', detail: err.message });
    }

    const vessels = extractVessels(raw);
    const vessel  = vessels.length ? vessels[0] : null;

    if (!vessel) return respond(404, { error: 'Vessel not found', mmsi, action, ts });
    return respond(200, { vessel, action, ts }, 'no-store');
  }

  // ── Action: portcalls ──────────────────────────────────────────────────────
  if (action === 'portcalls') {
    const mmsi = (p.mmsi || '').replace(/\D/g, '');
    if (!mmsi) return respond(400, { error: 'portcalls requires mmsi' });

    // VesselFinder port calls via extradata param on the Vessels endpoint
    const url = `${VF_BASE}/vessels?userkey=${encodeURIComponent(apiKey)}&format=json&mmsi=${mmsi}&extradata=portcalls`;

    let raw;
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) return respond(res.status, { error: 'VesselFinder upstream error', httpStatus: res.status });
      raw = await res.json();
    } catch (err) {
      return respond(502, { error: 'Upstream fetch failed', detail: err.message });
    }

    // Port calls may come back nested in AIS object or as a separate array
    const vessels = extractVessels(raw);
    const calls   = (vessels.length && vessels[0].PORTCALLS)
      ? vessels[0].PORTCALLS
      : (Array.isArray(raw) ? raw : []);

    return respond(200, { calls, mmsi, action, ts }, 'no-store');
  }

  return respond(400, {
    error:   `Unknown action: ${action}`,
    actions: ['positions', 'details', 'portcalls'],
  });
};
