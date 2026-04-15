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

// VesselAPI — bounding box endpoint (global sweep: full lat/lon range)
const VESSEL_API_URL = 'https://api.vesselapi.com/v1/location/vessels/bounding-box'
  + '?filter.latBottom=-90&filter.latTop=90&filter.lonLeft=-180&filter.lonRight=180';

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

  // ── Fetch from VesselAPI with retry ───────────────────────────────────────
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const res = await fetch(VESSEL_API_URL, {
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
        console.error('VesselAPI error — status:', res.status, '| body:', errBody.slice(0, 200));
        throw new Error('VesselAPI HTTP ' + res.status);
      }

      const json = await res.json();

      // VesselAPI returns { data: [...] } or an array directly
      const raw = Array.isArray(json) ? json : (json.data || json.vessels || []);

      if (!Array.isArray(raw)) {
        throw new Error('VesselAPI: unexpected response shape');
      }

      // ── Normalise + sample ──────────────────────────────────────────────
      const normalised = [];
      for (const v of raw) {
        // Skip null-island and vessels without coordinates
        const lat = v.lat ?? v.latitude  ?? (v.position && v.position.lat);
        const lon = v.lon ?? v.longitude ?? (v.position && v.position.lon);
        if (lat == null || lon == null) continue;
        if (lat === 0 && lon === 0) continue;

        const sog  = v.sog ?? v.speed ?? v.speedOverGround ?? null;
        const cog  = v.cog ?? v.course ?? v.courseOverGround ?? null;
        const mmsi = String(v.mmsi || v.MMSI || '');
        const name = (v.shipName || v.name || v.vesselName || mmsi || 'VESSEL').trim();

        // Skip anchored / very slow (< 0.5 kn) — same threshold as old AISStream filter
        if (sog != null && sog < 0.5) continue;

        // 10% sampling — priority vessels always pass through
        const isPriority = /tanker|carrier|bulk|cargo|container/i.test(name);
        if (!isPriority && Math.random() > SAMPLE_RATE) continue;

        normalised.push({
          mmsi,
          name,
          lat:  parseFloat(lat.toFixed(4)),
          lon:  parseFloat(lon.toFixed(4)),
          sog:  sog  != null ? parseFloat(Number(sog).toFixed(2))  : null,
          cog:  cog  != null ? parseFloat(Number(cog).toFixed(1))  : null,
        });

        if (normalised.length >= MAX_VESSELS) break;
      }

      const now = new Date().toISOString();

      // ── Upsert to Supabase ────────────────────────────────────────────────
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

    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        console.warn(`fetch-vessels: attempt ${attempt} failed (${err.message}), retrying…`);
        await new Promise(r => setTimeout(r, 1500 * attempt));
      }
    }
  }

  console.error('fetch-vessels: all retries exhausted:', lastErr && lastErr.message);
  return {
    statusCode: 502,
    headers,
    body: JSON.stringify({ error: lastErr ? lastErr.message : 'fetch failed', vessels: [] }),
  };
};
