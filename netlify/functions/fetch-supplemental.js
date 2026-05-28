'use strict';
// netlify/functions/fetch-supplemental.js
// Supplemental aircraft ingestion — viewport-scoped adsb.lol proxy.
//
// Architecture:
//   Browser → this function (CORS: *) → api.adsb.lol (Netlify IPs not blocked)
//   Returns normalized Argus aircraft schema, identical contract to fetch-traffic.
//   Called by ArgusProviderCache every 5 min with viewport center lat/lon/dist.
//
// Normalization is done server-side so the client receives ready-to-render records.
// No Supabase dependency — viewport-scoped queries have unbounded key space.
// Netlify CDN edge caches per unique query string (30 s) to absorb burst traffic.
//
// Output schema per aircraft:
//   { icao24, cs, lat, lon, track, gs, alt, phase, flightType, region, stale, source }
//
// Env: none required.

const ADSB_BASE    = 'https://api.adsb.lol/v2';
const TIMEOUT_MS   = 10000;   // 10 s — leaves 5 s headroom within Netlify's 15 s limit
const MAX_AIRCRAFT = 300;     // supplemental cap — primary pipeline supplies up to 750

// ── Flight classification ──────────────────────────────────────────────────────
const CARGO_PREFIXES      = ['FDX', 'UPS', 'CLX', 'GTI', 'ABX'];
const MILITARY_PREFIXES   = ['RCH', 'BAF', 'RAF', 'AMC', 'NAV'];
const COMMERCIAL_PREFIXES = ['DAL', 'UAL', 'AAL', 'SWA', 'BAW', 'AFR', 'KLM'];

function classifyFlight(cs, altFt) {
  const pfx = (cs || '').trim().slice(0, 3).toUpperCase();
  if (MILITARY_PREFIXES.includes(pfx))   return 'military';
  if (CARGO_PREFIXES.includes(pfx))      return 'cargo';
  if (COMMERCIAL_PREFIXES.includes(pfx)) return 'commercial';
  if (altFt != null && altFt > 20000)    return 'commercial';
  return 'unknown';
}

// ── Flight phase from vertical rate (ft/min) ───────────────────────────────────
function flightPhase(vs) {
  if (vs == null || !isFinite(vs)) return 'cruise';
  if (vs >  500) return 'climb';
  if (vs < -500) return 'descent';
  return 'cruise';
}

// ── ADSBexchange v2 → Argus aircraft record ────────────────────────────────────
// Output field `cs` (not `callsign`) matches what renderAircraft() / placeAircraft()
// and _prevPositions in argusTracking.js expect.
function normalize(ac) {
  if (!ac || typeof ac !== 'object') return null;

  const icao24 = (ac.hex || '').trim().toLowerCase();
  if (!icao24) return null;
  if (ac.on_ground) return null;                             // skip ground traffic

  const lat = ac.lat;
  const lon = ac.lon;
  if (lat == null || lon == null || !isFinite(lat) || !isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180)    return null;

  const cs = (ac.flight || '').trim() || null;

  // alt_baro is feet; fall back to alt_geom. Skip the string sentinel 'ground'.
  let altFt = ac.alt_baro ?? ac.alt_geom ?? null;
  if (typeof altFt === 'string') altFt = null;
  if (altFt != null) altFt = Math.round(altFt);

  const gs    = ac.gs        != null ? Math.round(ac.gs) : null;
  const track = ac.track     != null ? ac.track          : null;
  const vs    = ac.baro_rate != null ? ac.baro_rate      : null;

  return {
    icao24,
    cs,
    lat, lon, track, gs,
    alt:        altFt,
    phase:      flightPhase(vs),
    flightType: classifyFlight(cs, altFt),
    region:     null,    // supplemental — no regional assignment
    stale:      false,
    source:     'adsb.lol',
  };
}

// ── CORS / response helpers ────────────────────────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

function respond(statusCode, payload, extra) {
  return {
    statusCode,
    headers: Object.assign({}, CORS_HEADERS, extra || {}),
    body: JSON.stringify(payload),
  };
}

function empty(note) {
  // Always HTTP 200 so _argusReqCache.fetch() resolves (not rejects).
  // _ingestAircraftArray([]) cleanly expires stale supplemental entries.
  console.warn('[fetch-supplemental]', note);
  return respond(200, { aircraft: [], source: 'adsb.lol', ts: Date.now(), note });
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  // ── Query param validation ─────────────────────────────────────────────────
  const p    = event.queryStringParameters || {};
  const lat  = parseFloat(p.lat);
  const lon  = parseFloat(p.lon);
  const dist = Math.min(250, Math.max(1, parseInt(p.dist) || 250));

  if (!isFinite(lat) || lat < -90 || lat > 90)   return empty('invalid lat — defaulting skipped');
  if (!isFinite(lon) || lon < -180 || lon > 180) return empty('invalid lon — defaulting skipped');

  // ── Upstream fetch ─────────────────────────────────────────────────────────
  const url    = `${ADSB_BASE}/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${dist}`;
  const signal = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
    ? AbortSignal.timeout(TIMEOUT_MS)
    : undefined;

  let raw;
  try {
    const resp = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'ArgusIntel/1.0' },
      signal,
    });

    if (resp.status === 429) return empty('adsb.lol rate limited (429)');
    if (resp.status === 403) return empty('adsb.lol blocked (403) — IP restriction');
    if (!resp.ok)            return empty(`adsb.lol HTTP ${resp.status}`);

    raw = await resp.json();
  } catch (err) {
    return empty(`fetch error: ${err.message}`);
  }

  // ── Normalize ─────────────────────────────────────────────────────────────
  const records  = Array.isArray(raw.ac) ? raw.ac : [];
  const aircraft = [];
  const seen     = new Set();

  for (const rec of records) {
    if (aircraft.length >= MAX_AIRCRAFT) break;
    const norm = normalize(rec);
    if (!norm || seen.has(norm.icao24)) continue;
    seen.add(norm.icao24);
    aircraft.push(norm);
  }

  console.log(
    `[fetch-supplemental] lat=${lat.toFixed(2)} lon=${lon.toFixed(2)} dist=${dist}`,
    `| raw=${records.length} normalised=${aircraft.length}`
  );

  return respond(200, { aircraft, source: 'adsb.lol', ts: Date.now() }, {
    'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=15',
  });
};
