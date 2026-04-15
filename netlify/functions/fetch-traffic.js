// netlify/functions/fetch-traffic.js
// Fetches live ADS-B aircraft across 4 strategic corridors in parallel.
// Sampling: 10% random, always keeps FDX / UPS / DHL / PAC callsigns.
// Cache: Supabase global_events table, 10-minute TTL.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const CACHE_TTL_MS  = 10 * 60 * 1000;   // 10 minutes
const SAMPLE_RATE   = 0.10;              // keep 10% of non-priority aircraft
const PRIORITY_RE   = /^(FDX|UPS|DHL|PAC)/i; // always keep these callsigns

// Strategic corridors — [lat_min, lon_min, lat_max, lon_max]
const CORRIDORS = {
  US_NE:      [35, -80, 45, -65],
  NORTH_SEA:  [50,  -4, 62,  12],
  HORMUZ:     [22,  53, 28,  60],
  CHINA_SEA:  [10, 100, 25, 125],
};

// OpenSky bounding-box endpoint — no CORS issue server-side
function openskyUrl([lamin, lomin, lamax, lomax]) {
  return `https://opensky-network.org/api/states/all?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;
}

// Build Basic Auth header if credentials are configured
function authHeaders() {
  const user = process.env.OPENSKY_USER;
  const pass = process.env.OPENSKY_PASS;
  console.log("USER EXISTS:", !!user);
  console.log("PASS EXISTS:", !!pass);
  const base = { 'User-Agent': 'ArgusIntel/1.0' };
  if (!user || !pass) return base;
  const token = Buffer.from(`${user}:${pass}`).toString('base64');
  return { ...base, Authorization: `Basic ${token}` };
}

// Fetch one corridor; returns normalised aircraft array
async function fetchCorridor(name, bbox) {
  const res = await fetch(openskyUrl(bbox), {
    headers: authHeaders(),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`OpenSky ${name} HTTP ${res.status}`);

  const json = await res.json();
  const states = Array.isArray(json.states) ? json.states : [];

  // Normalise OpenSky state vector:
  // [0]=icao24 [1]=callsign [2]=country [5]=lon [6]=lat [8]=on_ground [10]=true_track [7]=baro_alt
  const aircraft = states
    .filter(s =>
      s[5] != null && s[6] != null &&   // lon/lat present
      s[8] === false &&                  // airborne
      (s[7] == null || s[7] >= 1000)    // altitude ≥ 1000 m or unreported
    )
    .map(s => ({
      corridor: name,
      cs:       (s[1] || '').trim(),
      country:  s[2] || '',
      lat:      s[6],
      lon:      s[5],
      track:    s[10],
      alt:      s[7],
    }));

  // 10% sampling — always keep priority callsigns
  return aircraft.filter(a =>
    PRIORITY_RE.test(a.cs) || Math.random() < SAMPLE_RATE
  );
}

exports.handler = async () => {
  return {
    statusCode: 200,
    body: "fetch-traffic working"
  };
};
