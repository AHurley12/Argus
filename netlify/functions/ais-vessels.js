// netlify/functions/ais-vessels.js
// Regional AIS vessel supplement — fetches ~1,800 vessels across 10 strategic
// maritime zones using AISHub (free tier) and returns a deduplicated, filtered list.
//
// Setup:
//   1. Register free at https://www.aishub.net/join-us
//   2. Netlify → Site → Environment variables → Add:
//        AISHUB_USERNAME = your_username_here
//   3. Deploy
//
// Called by the frontend every 5 minutes to supplement the live AISstream WebSocket.
// The WebSocket handles real-time updates; this function fills coverage gaps in
// strategic regions where WebSocket density is lower.

'use strict';

// ── Strategic maritime regions — ordered by geopolitical priority ─────────────
const MARITIME_REGIONS = [
  { name: 'North Sea & Baltic',        minLat:  50, maxLat:  70, minLon: -10, maxLon:  30, limit: 300 },
  { name: 'Mediterranean',             minLat:  30, maxLat:  46, minLon:  -6, maxLon:  36, limit: 250 },
  { name: 'Suez Canal & Red Sea',       minLat:  12, maxLat:  32, minLon:  32, maxLon:  50, limit: 200 },
  { name: 'Strait of Malacca',         minLat:  -2, maxLat:   8, minLon:  95, maxLon: 110, limit: 200 },
  { name: 'Panama Canal & Caribbean',  minLat:   5, maxLat:  25, minLon: -85, maxLon: -60, limit: 150 },
  { name: 'Persian Gulf',              minLat:  23, maxLat:  30, minLon:  48, maxLon:  60, limit: 150 },
  { name: 'South China Sea',           minLat:   0, maxLat:  25, minLon: 105, maxLon: 125, limit: 150 },
  { name: 'East Africa & Horn',        minLat: -12, maxLat:  15, minLon:  35, maxLon:  55, limit: 100 },
  { name: 'North Atlantic',            minLat:  30, maxLat:  60, minLon: -60, maxLon: -10, limit: 150 },
  { name: 'US West Coast & Pacific',   minLat:  20, maxLat:  50, minLon:-135, maxLon:-115, limit: 150 },
];

// ── Vessel type filter ────────────────────────────────────────────────────────
// AISHub TYPE field uses AIS numeric codes OR text strings depending on format.
// We check both numeric and text representations.
const SKIP_TYPES_NUM  = new Set([36, 37, 50, 51, 53, 54]); // pleasure craft, pilot, SAR, port tender
const SKIP_TYPES_TEXT = new Set(['pleasure craft', 'sailing vessel', 'pilot', 'sar', 'port tender']);

function shouldSkip(vessel) {
  const typeNum  = parseInt(vessel.TYPE || vessel.shipType || vessel.type, 10);
  const typeText = (vessel.TYPENAME || vessel.typeText || '').toLowerCase();

  if (!isNaN(typeNum) && SKIP_TYPES_NUM.has(typeNum)) return true;
  for (const t of SKIP_TYPES_TEXT) {
    if (typeText.includes(t)) return true;
  }

  // Skip obviously stationary / anchored only if speed data is present and reliable
  const sog = parseFloat(vessel.SOG || vessel.sog || vessel.speed || -1);
  if (sog >= 0 && sog > 35) return true; // GPS error / unrealistic speed

  return false;
}

// ── Normalise AISHub response to Argus vessel schema ─────────────────────────
function normalise(v, region) {
  const lat = parseFloat(v.LATITUDE  || v.lat || 0);
  const lon = parseFloat(v.LONGITUDE || v.lon || 0);
  if (!lat && !lon) return null;

  const heading = parseFloat(v.HEADING || v.heading || v.COG || 0) || null;
  const sog     = parseFloat(v.SOG     || v.sog     || 0)          || null;
  const name    = (v.NAME || v.name || '').trim();
  const mmsi    = String(v.MMSI || v.mmsi || '').trim();
  if (!mmsi) return null;

  return {
    mmsi,
    name:      name  || null,
    lat,
    lon,
    heading,
    velocity:  sog,
    shipType:  v.TYPE || v.type || null,
    navStatus: v.NAVSTAT != null ? String(v.NAVSTAT) : null,
    source:    'aishub',
    region:    region.name,
    timestamp: Date.now(),
  };
}

// ── Fetch one region from AISHub ──────────────────────────────────────────────
async function fetchRegion(region, username) {
  const url = `https://data.aishub.net/ws.php` +
    `?username=${encodeURIComponent(username)}` +
    `&format=1&output=json&compress=0` +
    `&latmin=${region.minLat}&latmax=${region.maxLat}` +
    `&lonmin=${region.minLon}&lonmax=${region.maxLon}`;

  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const payload = await res.json();
  // AISHub wraps in array: [{ERROR, DATA: [...vessels]}]
  const root = Array.isArray(payload) ? payload[0] : payload;
  if (root.ERROR) throw new Error(`AISHub error: ${root.LAST_ERROR}`);

  return Array.isArray(root.DATA) ? root.DATA : [];
}

// ── Delay helper ──────────────────────────────────────────────────────────────
const delay = ms => new Promise(r => setTimeout(r, ms));

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=240', // 4-min browser cache — matches 5-min poll
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const username = process.env.AISHUB_USERNAME || '';
  if (!username) {
    return {
      statusCode: 503,
      headers,
      body: JSON.stringify({ error: 'AISHUB_USERNAME not configured', vessels: [] }),
    };
  }

  const allVessels = [];
  const seenMMSI   = new Set();
  const regionLog  = [];

  for (const region of MARITIME_REGIONS) {
    try {
      const raw      = await fetchRegion(region, username);
      const filtered = [];

      for (const v of raw) {
        const mmsi = String(v.MMSI || v.mmsi || '').trim();
        if (!mmsi || seenMMSI.has(mmsi)) continue;
        if (shouldSkip(v)) continue;

        const vessel = normalise(v, region);
        if (!vessel) continue;

        seenMMSI.add(mmsi);
        filtered.push(vessel);
        if (filtered.length >= region.limit) break;
      }

      allVessels.push(...filtered);
      regionLog.push({ region: region.name, fetched: raw.length, kept: filtered.length });

      // 200ms between calls — AISHub free tier rate limit protection
      await delay(200);

    } catch (err) {
      console.warn(`[ais-vessels] ${region.name} failed:`, err.message);
      regionLog.push({ region: region.name, error: err.message });
    }
  }

  console.log(`[ais-vessels] total=${allVessels.length} unique_mmsi=${seenMMSI.size}`);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      vessels:   allVessels,
      count:     allVessels.length,
      timestamp: Date.now(),
      regions:   regionLog,
    }),
  };
};
