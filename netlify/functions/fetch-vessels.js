// netlify/functions/fetch-vessels.js
// Fetches live vessel positions from VesselAPI, applies 10% sampling,
// caches 30 min in Supabase (global_events table, key: 'vessel_positions').
// Env: VESSELAPI_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;

const CACHE_TTL_MS  = 30 * 60 * 1000;   // 30 min — tanker at 20 kn barely moves in 30 min
const SAMPLE_RATE   = 0.10;              // 10% sampling — configurable
const MAX_VESSELS   = 500;              // hard cap on returned records
const TIMEOUT_MS    = 8000;             // 8 s — keeps 2 retries safely under Netlify's 26 s limit
const MAX_RETRIES   = 2;                // 1-2 retry max per spec

// VesselAPI bounding box endpoint — max span |dLat|+|dLon| ≤ 4 degrees per call
// Each corridor box is exactly 2°×2° = 4 degrees total
const VESSEL_API_BASE = 'https://api.vesselapi.com/v1/location/vessels/bounding-box';
const CORRIDORS = [
  { name: 'Strait of Hormuz',    latB: 25,    latT: 27,    lonL: 55,     lonR: 57    },
  { name: 'Suez Canal',          latB: 29,    latT: 31,    lonL: 31.5,   lonR: 33.5  },
  { name: 'Strait of Malacca',   latB: 1,     latT: 3,     lonL: 102,    lonR: 104   },
  { name: 'English Channel',     latB: 50,    latT: 52,    lonL: 0,      lonR: 2     },
  { name: 'Strait of Gibraltar', latB: 35,    latT: 37,    lonL: -6.5,   lonR: -4.5  },
  { name: 'Bab el-Mandeb',       latB: 11.5,  latT: 13.5,  lonL: 42.5,   lonR: 44.5  },
  { name: 'Taiwan Strait',       latB: 23,    latT: 25,    lonL: 119,    lonR: 121   },
  { name: 'Panama Canal',        latB: 8,     latT: 10,    lonL: -80.5,  lonR: -78.5 },
  { name: 'Cape of Good Hope',   latB: -35,   latT: -33,   lonL: 17,     lonR: 19    },
  { name: 'South China Sea',     latB: 14,    latT: 16,    lonL: 113,    lonR: 115   },
];

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=1800',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const VESSELAPI_KEY = process.env.VESSELAPI_KEY;
  console.log('VESSELAPI_KEY exists:', !!VESSELAPI_KEY);

  if (!VESSELAPI_KEY) {
    return {
      statusCode: 503,
      headers,
      body: JSON.stringify({ error: 'VESSELAPI_KEY not configured', vessels: [] }),
    };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // ── Check Supabase cache ───────────────────────────────────────────────────
  try {
    const { data: cached } = await supabase
      .from('global_events')
      .select('*')
      .eq('key', 'vessel_positions')
      .single();

    if (cached && Date.now() - new Date(cached.updated_at).getTime() < CACHE_TTL_MS) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ vessels: cached.payload, source: 'cache', ts: cached.updated_at }),
      };
    }
  } catch (_) {
    // Cache miss or Supabase error — fall through to live fetch
  }

  // ── Fetch all corridors in parallel ──────────────────────────────────────
  const fetchCorridor = async (corridor) => {
    const url = VESSEL_API_BASE
      + '?filter.latBottom=' + corridor.latB
      + '&filter.latTop='    + corridor.latT
      + '&filter.lonLeft='   + corridor.lonL
      + '&filter.lonRight='  + corridor.lonR
      + '&pagination.limit=50';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'Authorization': 'Bearer ' + VESSELAPI_KEY,
          'User-Agent':    'ArgusIntel/1.0',
          'Accept':        'application/json',
        },
      });
      clearTimeout(timer);
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        console.error('VesselAPI', corridor.name, '— status:', res.status, '| body:', errBody.slice(0, 200));
        return [];
      }
      const json = await res.json();
      return Array.isArray(json) ? json : (json.data || json.vessels || []);
    } catch (err) {
      clearTimeout(timer);
      console.warn('VesselAPI', corridor.name, 'failed:', err.message);
      return [];
    }
  };

  const results = await Promise.allSettled(CORRIDORS.map(fetchCorridor));
  const raw = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);

  if (!raw.length) {
    console.error('fetch-vessels: all corridors returned no data');
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: 'all corridors failed', vessels: [] }),
    };
  }

  // ── Normalise + deduplicate + sample ─────────────────────────────────────
  const seen = new Set();
  const normalised = [];
  for (const v of raw) {
    const lat = v.lat ?? v.latitude  ?? (v.position && v.position.lat);
    const lon = v.lon ?? v.longitude ?? (v.position && v.position.lon);
    if (lat == null || lon == null) continue;
    if (lat === 0 && lon === 0) continue;

    const mmsi = String(v.mmsi || v.MMSI || '');
    if (mmsi && seen.has(mmsi)) continue;
    if (mmsi) seen.add(mmsi);

    const sog  = v.sog ?? v.speed ?? v.speedOverGround ?? null;
    const cog  = v.cog ?? v.course ?? v.courseOverGround ?? null;
    const name = (v.shipName || v.name || v.vesselName || mmsi || 'VESSEL').trim();

    if (sog != null && sog < 0.5) continue;

    const isPriority = /tanker|carrier|bulk|cargo|container/i.test(name);
    if (!isPriority && Math.random() > SAMPLE_RATE) continue;

    normalised.push({
      mmsi,
      name,
      lat: parseFloat(lat.toFixed(4)),
      lon: parseFloat(lon.toFixed(4)),
      sog: sog != null ? parseFloat(Number(sog).toFixed(2)) : null,
      cog: cog != null ? parseFloat(Number(cog).toFixed(1)) : null,
    });

    if (normalised.length >= MAX_VESSELS) break;
  }

  const now = new Date().toISOString();
  console.log('fetch-vessels: normalised', normalised.length, 'vessels across', CORRIDORS.length, 'corridors');

  // ── Upsert to Supabase ────────────────────────────────────────────────────
  try {
    await supabase.from('global_events').upsert(
      { key: 'vessel_positions', payload: normalised, updated_at: now },
      { onConflict: 'key' }
    );
  } catch (cacheErr) {
    console.warn('fetch-vessels: Supabase upsert failed:', cacheErr.message);
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ vessels: normalised, source: 'live', ts: now }),
  };
};
