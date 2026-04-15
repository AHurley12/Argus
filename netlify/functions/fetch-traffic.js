// netlify/functions/fetch-traffic.js
// Multi-region ADS-B ingestion via adsb.lol.
// Stratified sampling across 8 global regions eliminates geographic density bias.
// Per-region Supabase cache (10 s TTL) enables rolling refresh without full re-fetches.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY;

const CACHE_KEY      = 'air_traffic_v3';
const REGION_TTL_MS  = 10 * 1000;   // 10 s per-region freshness window
const GLOBAL_CAP     = 300;          // hard ceiling on returned aircraft
const PRIORITY_RE    = /^(FDX|UPS|DHL|PAC|[A-Z]{2}\d)/i; // cargo + commercial callsigns

// ── Region definitions ─────────────────────────────────────────────────────────
// lat/lon  = center point
// dist     = radius in nautical miles
// target   = desired aircraft count from this region
// weight   = adaptive multiplier (< 1 suppresses dense regions, > 1 boosts sparse)
const REGIONS = [
  { name: 'NA_EAST',    lat:  40,   lon:  -75,  dist: 650,  target: 50, weight: 1.0  },
  { name: 'NA_WEST',    lat:  37,   lon: -118,  dist: 650,  target: 40, weight: 1.0  },
  { name: 'EUROPE',     lat:  51,   lon:   10,  dist: 750,  target: 45, weight: 0.55 }, // suppress density bias
  { name: 'EAST_ASIA',  lat:  35,   lon:  127,  dist: 700,  target: 45, weight: 1.0  },
  { name: 'SE_ASIA',    lat:   5,   lon:  108,  dist: 650,  target: 35, weight: 1.1  },
  { name: 'MIDEAST',    lat:  25,   lon:   52,  dist: 550,  target: 30, weight: 1.1  },
  { name: 'LATAM',      lat: -10,   lon:  -55,  dist: 750,  target: 25, weight: 1.2  }, // overweight sparse
  { name: 'OCEANIA',    lat: -25,   lon:  140,  dist: 750,  target: 25, weight: 1.2  }, // overweight sparse
];
// Sum of targets = 295  (within 200–500 performance budget)

// ── Data fetching ──────────────────────────────────────────────────────────────

async function fetchRegion(region) {
  const url = `https://api.adsb.lol/v2/lat/${region.lat}/lon/${region.lon}/dist/${region.dist}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'ArgusIntel/1.0' },
    signal:  AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`adsb.lol ${region.name} HTTP ${res.status}`);

  const json   = await res.json();
  const states = Array.isArray(json.ac) ? json.ac : [];

  return states
    .filter(s =>
      s.lat != null && s.lon != null &&
      s.alt_baro !== 'ground' &&
      (s.alt_baro == null || s.alt_baro >= 3000)
    )
    .map(s => ({
      region: region.name,
      cs:     (s.flight || '').trim(),
      country: '',
      lat:    s.lat,
      lon:    s.lon,
      track:  s.track  ?? null,
      alt:    s.alt_baro ?? null,
    }));
}

// Stagger region fetches in batches of `batchSize` with `delayMs` between batches.
// Prevents burst rate-limiting while keeping total wall-clock time low.
async function fetchRegionsThrottled(regions, batchSize = 2, delayMs = 400) {
  const results = [];
  for (let i = 0; i < regions.length; i += batchSize) {
    const batch   = regions.slice(i, i + batchSize);
    const settled = await Promise.allSettled(batch.map(fetchRegion));
    results.push(...settled);
    if (i + batchSize < regions.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return results;
}

// ── Sampling ───────────────────────────────────────────────────────────────────

// Stratified sample with Fisher-Yates partial shuffle.
// Priority callsigns are always retained; remainder is randomly downsampled to `target * weight`.
function stratifiedSample(aircraft, target, weight) {
  const effective = Math.round(target * weight);
  const priority  = aircraft.filter(a => PRIORITY_RE.test(a.cs));
  const rest      = aircraft.filter(a => !PRIORITY_RE.test(a.cs));
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

// Merge regional arrays; if still over GLOBAL_CAP, proportionally trim each region.
function aggregate(regionCache) {
  const all = REGIONS.flatMap(r => regionCache[r.name]?.aircraft || []);
  if (all.length <= GLOBAL_CAP) return all;

  const ratio = GLOBAL_CAP / all.length;
  return REGIONS
    .flatMap(r => {
      const ac = regionCache[r.name]?.aircraft || [];
      return ac.slice(0, Math.ceil(ac.length * ratio));
    })
    .slice(0, GLOBAL_CAP);
}

// ── Handler ────────────────────────────────────────────────────────────────────

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const now      = Date.now();

  // ── Load per-region cache from Supabase ──────────────────────────────────────
  let regionCache = {};
  try {
    const { data } = await supabase
      .from('global_events')
      .select('payload')
      .eq('key', CACHE_KEY)
      .single();
    if (data?.payload) regionCache = data.payload;
  } catch (_) {}

  // ── Determine which regions are stale ────────────────────────────────────────
  const stale = REGIONS.filter(r => {
    const c = regionCache[r.name];
    return !c || (now - c.ts) >= REGION_TTL_MS;
  });
  const cached = REGIONS.filter(r => !stale.includes(r));

  console.log(
    `Stale: [${stale.map(r => r.name).join(', ')}]`,
    `| Cached: [${cached.map(r => r.name).join(', ')}]`
  );

  // ── Fetch stale regions ───────────────────────────────────────────────────────
  if (stale.length) {
    const results = await fetchRegionsThrottled(stale);

    stale.forEach((region, i) => {
      const res = results[i];
      if (res.status === 'fulfilled') {
        const sampled = stratifiedSample(res.value, region.target, region.weight);
        console.log(`[${region.name}] raw: ${res.value.length} → sampled: ${sampled.length}`);
        regionCache[region.name] = { aircraft: sampled, ts: now };
      } else {
        const err = res.reason;
        console.error(`[${region.name}] FAILED: ${err?.message} | cause: ${err?.cause?.message || 'none'}`);
        // Preserve stale cached data on failure rather than evicting it
      }
    });

    // Persist updated cache
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

  // ── Aggregate and return ──────────────────────────────────────────────────────
  const aircraft = aggregate(regionCache);

  const regionStatus = {};
  REGIONS.forEach(r => {
    const c = regionCache[r.name];
    regionStatus[r.name] = c
      ? { count: c.aircraft.length, age_s: Math.round((now - c.ts) / 1000) }
      : 'no-data';
  });

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      source:   stale.length ? 'live' : 'cache',
      regions:  regionStatus,
      total:    aircraft.length,
      aircraft,
    }),
  };
};
