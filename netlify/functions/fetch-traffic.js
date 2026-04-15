// netlify/functions/fetch-traffic.js
// Fetches live ADS-B aircraft via adsb.lol (free, no key, cloud-IP friendly).
// Covers 4 strategic corridors via center+radius queries.
// Sampling: 10% random, always keeps FDX / UPS / DHL / PAC callsigns.
// Cache: Supabase global_events table, 10-minute TTL.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;

const CACHE_TTL_MS  = 10 * 60 * 1000;
const SAMPLE_RATE   = 0.10;
const PRIORITY_RE   = /^(FDX|UPS|DHL|PAC)/i;

// Strategic corridors — center lat/lon + radius in nautical miles
// adsb.lol endpoint: /v2/lat/{lat}/lon/{lon}/dist/{nm}
const CORRIDORS = {
  US_NE:     { lat: 40,    lon: -72.5, dist: 500 },
  NORTH_SEA: { lat: 56,    lon: 4,     dist: 500 },
  HORMUZ:    { lat: 25,    lon: 56.5,  dist: 300 },
  CHINA_SEA: { lat: 17.5,  lon: 112.5, dist: 700 },
};

async function fetchCorridor(name, { lat, lon, dist }) {
  const url = `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}`;
  console.log(`[${name}] fetching: ${url}`);

  const res = await fetch(url, {
    headers: { 'User-Agent': 'ArgusIntel/1.0' },
    signal: AbortSignal.timeout(12000),
  });

  console.log(`[${name}] status: ${res.status}`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[${name}] error body: ${body.slice(0, 200)}`);
    throw new Error(`adsb.lol ${name} HTTP ${res.status}`);
  }

  const json = await res.json();
  const states = Array.isArray(json.ac) ? json.ac : [];
  console.log(`[${name}] raw states: ${states.length}`);

  // adsb.lol fields: hex, flight, lat, lon, track, alt_baro (ft or "ground"), gs
  const aircraft = states
    .filter(s =>
      s.lat != null && s.lon != null &&
      s.alt_baro !== 'ground' &&
      (s.alt_baro == null || s.alt_baro >= 3000)   // ~1000 m in feet
    )
    .map(s => ({
      corridor: name,
      cs:       (s.flight || '').trim(),
      country:  '',
      lat:      s.lat,
      lon:      s.lon,
      track:    s.track ?? null,
      alt:      s.alt_baro ?? null,
    }));

  return aircraft.filter(a =>
    PRIORITY_RE.test(a.cs) || Math.random() < SAMPLE_RATE
  );
}

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // ── Check Supabase cache ──────────────────────────────────────────────────
    const { data: cached } = await supabase
      .from('global_events')
      .select('*')
      .eq('key', 'air_traffic_v2')
      .single();

    if (cached && Date.now() - new Date(cached.updated_at).getTime() < CACHE_TTL_MS) {
      console.log('Serving from Supabase cache');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ source: 'cache', aircraft: cached.payload }),
      };
    }

    // ── Fetch all corridors in parallel ───────────────────────────────────────
    const results = await Promise.allSettled(
      Object.entries(CORRIDORS).map(([name, cfg]) => fetchCorridor(name, cfg))
    );

    const aircraft = results.flatMap(r =>
      r.status === 'fulfilled' ? r.value : []
    );

    const corridorStatus = {};
    Object.keys(CORRIDORS).forEach((name, i) => {
      if (results[i].status === 'fulfilled') {
        corridorStatus[name] = results[i].value.length;
      } else {
        const err = results[i].reason;
        corridorStatus[name] = `${err?.message} | cause: ${err?.cause?.message || err?.cause || 'none'}`;
        console.error(`[${name}] FAILED:`, err?.message, '| cause:', err?.cause);
      }
    });

    console.log('corridorStatus:', JSON.stringify(corridorStatus));

    // ── Cache only if we got data ─────────────────────────────────────────────
    if (aircraft.length) {
      await supabase.from('global_events').upsert({
        key:        'air_traffic_v2',
        payload:    aircraft,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ source: 'live', corridors: corridorStatus, aircraft }),
    };

  } catch (err) {
    console.error('[fetch-traffic]', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message, aircraft: [] }),
    };
  }
};
