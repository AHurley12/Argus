// netlify/functions/fetch-vessels.js
// Multi-region vessel ingestion via VesselAPI.
// 5 maritime regions / 15 corridors with stratified sampling and per-region caching.
// Per-region TTLs tuned to ~59 VesselAPI credits/day (1,500 credit budget over 24 days).
// Env: VESSELAPI_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_KEY;

const CACHE_KEY       = 'vessel_positions_v2';
const GLOBAL_CAP      = 300;
const TIMEOUT_MS      = 8000;

const VESSEL_API_BASE = 'https://api.vesselapi.com/v1/location/vessels/bounding-box';
const PRIORITY_RE     = /tanker|carrier|bulk|cargo|container/i;

// ── Vessel classification ──────────────────────────────────────────────────────
function classifyVessel(rawType, name) {
  const normalized = (rawType || '').toLowerCase();
  const nameLower  = (name   || '').toLowerCase();
  // Prefer explicit type field; fall back to name-based matching
  const src = normalized || nameLower;
  if (!src) return 'other';
  if (src.includes('cargo') || src.includes('container') || src.includes('bulk') || src.includes('carrier')) return 'cargo';
  if (src.includes('tanker'))    return 'tanker';
  if (src.includes('passenger') || src.includes('cruise') || src.includes('ferry')) return 'passenger';
  if (src.includes('fishing'))   return 'fishing';
  return 'other';
}

// ── Credit budget ──────────────────────────────────────────────────────────────
// Each corridor fetch = 1 VesselAPI credit.
// Per-region TTLs are set to consume ~59 credits/day total:
//   MIDDLE_EAST  (2 corridors, 4h TTL)  → 12 credits/day  [highest tactical value]
//   ASIA_PACIFIC (5 corridors, 6h TTL)  → 20 credits/day
//   EUROPE_MED   (4 corridors, 6h TTL)  → 16 credits/day
//   AMERICAS     (3 corridors, 8h TTL)  →  9 credits/day
//   SOUTH_AFRICA (1 corridor,  12h TTL) →  2 credits/day
//   ─────────────────────────────────────────────────────
//   Total                               ~59 credits/day  (1,416 / 24-day window)

// ── Region definitions ─────────────────────────────────────────────────────────
// Each region contains named VesselAPI corridors (2°×2° bounding boxes).
// target  = desired vessel count from this region after sampling
// weight  = adaptive multiplier (> 1 overweights sparse regions)
// ttl     = per-region cache TTL in ms (drives credit consumption rate)
const REGIONS = [
  {
    name: 'ASIA_PACIFIC', target: 80, weight: 1.0,
    ttl: 6 * 60 * 60 * 1000,   // 6h — 4 refreshes/day × 5 corridors = 20 credits/day
    corridors: [
      { name: 'Strait of Malacca',   latB: 1,    latT: 3,    lonL: 102,   lonR: 104  },
      { name: 'South China Sea',     latB: 14,   latT: 16,   lonL: 113,   lonR: 115  },
      { name: 'Taiwan Strait',       latB: 23,   latT: 25,   lonL: 119,   lonR: 121  },
      { name: 'East China Sea',      latB: 29,   latT: 31,   lonL: 122,   lonR: 124  },
      { name: 'Bay of Bengal',       latB: 12,   latT: 14,   lonL: 82,    lonR: 84   },
    ],
  },
  {
    name: 'MIDDLE_EAST', target: 55, weight: 1.1,
    ttl: 4 * 60 * 60 * 1000,   // 4h — 6 refreshes/day × 2 corridors = 12 credits/day
    corridors: [
      { name: 'Strait of Hormuz',    latB: 25,   latT: 27,   lonL: 55,    lonR: 57   },
      { name: 'Bab el-Mandeb',       latB: 11.5, latT: 13.5, lonL: 42.5,  lonR: 44.5 },
    ],
  },
  {
    name: 'EUROPE_MED', target: 70, weight: 0.85, // suppress density bias
    ttl: 6 * 60 * 60 * 1000,   // 6h — 4 refreshes/day × 4 corridors = 16 credits/day
    corridors: [
      { name: 'Suez Canal',          latB: 29,   latT: 31,   lonL: 31.5,  lonR: 33.5 },
      { name: 'English Channel',     latB: 50,   latT: 52,   lonL: 0,     lonR: 2    },
      { name: 'Strait of Gibraltar', latB: 35,   latT: 37,   lonL: -6.5,  lonR: -4.5 },
      { name: 'North Sea',           latB: 55,   latT: 57,   lonL: 2,     lonR: 4    },
    ],
  },
  {
    name: 'AMERICAS', target: 60, weight: 1.1,
    ttl: 8 * 60 * 60 * 1000,   // 8h — 3 refreshes/day × 3 corridors = 9 credits/day
    corridors: [
      { name: 'Panama Canal',        latB: 8,    latT: 10,   lonL: -80.5, lonR: -78.5 },
      { name: 'US East Coast',       latB: 36,   latT: 38,   lonL: -76,   lonR: -74  },
      { name: 'Caribbean',           latB: 17,   latT: 19,   lonL: -67,   lonR: -65  },
    ],
  },
  {
    name: 'SOUTH_AFRICA', target: 35, weight: 1.2, // overweight sparse region
    ttl: 12 * 60 * 60 * 1000,  // 12h — 2 refreshes/day × 1 corridor = 2 credits/day
    corridors: [
      { name: 'Cape of Good Hope',   latB: -35,  latT: -33,  lonL: 17,    lonR: 19   },
    ],
  },
];
// Sum of targets = 300 (at GLOBAL_CAP)

// ── Data fetching ──────────────────────────────────────────────────────────────

function buildUrl(corridor) {
  return `${VESSEL_API_BASE}?filter.latBottom=${corridor.latB}&filter.latTop=${corridor.latT}&filter.lonLeft=${corridor.lonL}&filter.lonRight=${corridor.lonR}&pagination.limit=50`;
}

async function fetchCorridor(corridor, apiKey) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(buildUrl(corridor), {
      signal:  controller.signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent':    'ArgusIntel/1.0',
        'Accept':        'application/json',
      },
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.error(`[${corridor.name}] HTTP ${res.status}`);
      return [];
    }
    const json = await res.json();
    return Array.isArray(json) ? json : (json.data || json.vessels || []);
  } catch (err) {
    clearTimeout(timer);
    console.warn(`[${corridor.name}] failed: ${err.message}`);
    return [];
  }
}

// Fetch all corridors in a region, batched 3 at a time with 400 ms delay.
async function fetchRegion(region, apiKey) {
  const raw       = [];
  const batchSize = 3;
  const delayMs   = 400;

  for (let i = 0; i < region.corridors.length; i += batchSize) {
    const batch   = region.corridors.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map(c => fetchCorridor(c, apiKey)));
    results.forEach(r => { if (r.status === 'fulfilled') raw.push(...r.value); });
    if (i + batchSize < region.corridors.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return raw;
}

// Fetch stale regions 2 at a time with 500 ms delay between batches.
async function fetchRegionsThrottled(regions, apiKey, batchSize = 2, delayMs = 500) {
  const results = [];
  for (let i = 0; i < regions.length; i += batchSize) {
    const batch   = regions.slice(i, i + batchSize);
    const settled = await Promise.allSettled(batch.map(r => fetchRegion(r, apiKey)));
    results.push(...settled);
    if (i + batchSize < regions.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return results;
}

// ── Normalisation ──────────────────────────────────────────────────────────────

function normalise(v, regionName) {
  const lat  = v.lat ?? v.latitude  ?? v.position?.lat;
  const lon  = v.lon ?? v.longitude ?? v.position?.lon;
  if (lat == null || lon == null) return null;
  if (lat === 0 && lon === 0)    return null;

  const sog  = v.sog ?? v.speed ?? v.speedOverGround ?? null;
  if (sog != null && sog < 0.5) return null;  // skip anchored / very slow

  const mmsi     = String(v.mmsi || v.MMSI || '');
  const name     = (v.shipName || v.name || v.vesselName || mmsi || 'VESSEL').trim();
  const cog      = v.cog ?? v.course ?? v.courseOverGround ?? null;
  const rawType  = v.type || v.vesselType || v.shipType || null;

  return {
    mmsi,
    name,
    region:       regionName,
    lat:          parseFloat(Number(lat).toFixed(4)),
    lon:          parseFloat(Number(lon).toFixed(4)),
    sog:          sog != null ? parseFloat(Number(sog).toFixed(2)) : null,
    cog:          cog != null ? parseFloat(Number(cog).toFixed(1)) : null,
    typeCategory: classifyVessel(rawType, name),
  };
}

// ── Sampling ───────────────────────────────────────────────────────────────────

function stratifiedSample(vessels, target, weight) {
  const effective = Math.round(target * weight);
  const priority  = vessels.filter(v => PRIORITY_RE.test(v.name));
  const rest      = vessels.filter(v => !PRIORITY_RE.test(v.name));
  const slots     = Math.max(0, effective - priority.length);

  if (rest.length <= slots) return [...priority, ...rest];

  const pool = rest.slice();
  for (let i = 0; i < slots; i++) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return [...priority, ...pool.slice(0, slots)];
}

// ── Aggregation ────────────────────────────────────────────────────────────────

function aggregate(regionCache) {
  // Merge regions; cross-region MMSI dedup handles corridor-boundary overlap
  const globalSeen = new Set();
  const all = REGIONS.flatMap(r =>
    (regionCache[r.name]?.vessels || []).filter(v => {
      if (!v.mmsi) return true;
      if (globalSeen.has(v.mmsi)) return false;
      globalSeen.add(v.mmsi);
      return true;
    })
  );

  if (all.length <= GLOBAL_CAP) return all;

  const ratio = GLOBAL_CAP / all.length;
  return REGIONS
    .flatMap(r => (regionCache[r.name]?.vessels || []).slice(0, Math.ceil((regionCache[r.name]?.vessels.length || 0) * ratio)))
    .slice(0, GLOBAL_CAP);
}

// ── Handler ────────────────────────────────────────────────────────────────────

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
  if (!VESSELAPI_KEY) {
    return {
      statusCode: 503,
      headers,
      body: JSON.stringify({ error: 'VESSELAPI_KEY not configured', vessels: [] }),
    };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const now      = Date.now();

  // ── Load per-region cache ────────────────────────────────────────────────────
  let regionCache = {};
  try {
    const { data } = await supabase
      .from('global_events')
      .select('payload')
      .eq('key', CACHE_KEY)
      .single();
    if (data?.payload) regionCache = data.payload;
  } catch (_) {}

  // ── Determine stale regions (each region uses its own TTL) ──────────────────
  const stale  = REGIONS.filter(r => {
    const c = regionCache[r.name];
    return !c || (now - c.ts) >= r.ttl;
  });
  const cached = REGIONS.filter(r => !stale.includes(r));

  console.log(
    `Stale: [${stale.map(r => `${r.name}(${r.ttl / 3600000}h)`).join(', ')}]`,
    `| Cached: [${cached.map(r => r.name).join(', ')}]`
  );

  // ── Fetch stale regions ───────────────────────────────────────────────────────
  if (stale.length) {
    const results = await fetchRegionsThrottled(stale, VESSELAPI_KEY);

    stale.forEach((region, i) => {
      const res = results[i];
      if (res.status === 'fulfilled') {
        const raw = res.value;

        // Normalise and deduplicate within region
        const seen   = new Set();
        const deduped = [];
        for (const v of raw) {
          const n = normalise(v, region.name);
          if (!n) continue;
          if (n.mmsi && seen.has(n.mmsi)) continue;
          if (n.mmsi) seen.add(n.mmsi);
          deduped.push(n);
        }

        const sampled = stratifiedSample(deduped, region.target, region.weight);
        console.log(`[${region.name}] raw: ${raw.length} → deduped: ${deduped.length} → sampled: ${sampled.length}`);
        regionCache[region.name] = { vessels: sampled, ts: now };
      } else {
        console.error(`[${region.name}] FAILED: ${results[i].reason?.message}`);
        // Preserve stale cache on failure
      }
    });

    // Persist updated cache only when we have data
    const hasData = REGIONS.some(r => regionCache[r.name]?.vessels?.length);
    if (hasData) {
      try {
        await supabase.from('global_events').upsert({
          key:        CACHE_KEY,
          payload:    regionCache,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'key' });
      } catch (err) {
        console.warn('Supabase upsert failed:', err.message);
      }
    }
  }

  // ── Aggregate and return ──────────────────────────────────────────────────────
  const vessels = aggregate(regionCache);

  const regionStatus = {};
  REGIONS.forEach(r => {
    const c = regionCache[r.name];
    regionStatus[r.name] = c
      ? { count: c.vessels.length, age_s: Math.round((now - c.ts) / 1000) }
      : 'no-data';
  });

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      source:  stale.length ? 'live' : 'cache',
      regions: regionStatus,
      total:   vessels.length,
      vessels,
    }),
  };
};
