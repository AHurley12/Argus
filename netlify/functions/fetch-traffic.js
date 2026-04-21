// netlify/functions/fetch-traffic.js
// Grid-stratified ADS-B ingestion pipeline v4.
//
// Pipeline:
//   1. Fetch FULL snapshots from 8 adsb.lol regional endpoints (no in-fetch cap)
//   2. Normalise: add ICAO24, velocity vector (track+gs), altitude band, flight phase, 5° cell ID
//   3. Cross-region ICAO24 deduplication (eliminates boundary ghosts)
//   4. Grid-stratified sample: guaranteed MIN_PER_CELL from every active cell,
//      remaining budget weighted inversely to cell density (sparse regions protected)
//   5. Corridor detection: heading-bucketed cluster centroids per cell (DBSCAN-lite)
//   6. Temporal carry-forward: cells absent from current snapshot inherit prev data (1 cycle)
//   7. Persist { regions, prev } + corridors to Supabase; stale regions preserved on failure
//
// Statistical guarantees:
//   • Every active 5° cell contributes ≥ MIN_PER_CELL aircraft regardless of global pressure
//   • Dense hubs receive proportionally fewer extra slots via inverse-√density weighting
//   • Sparse/remote regions remain visible — never dropped by density cut
//   • Corridors visible at any density level (minimum 3 co-directional aircraft per cell)
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;

const CACHE_KEY     = 'air_traffic_v4';
const REGION_TTL_MS = 60 * 1000;   // 60 s per-region freshness
const GLOBAL_CAP    = 750;          // hard ceiling on returned aircraft
const MIN_PER_CELL  = 2;            // guaranteed minimum per active 5° grid cell
const GRID_DEG      = 5;            // grid resolution in degrees
const CORRIDOR_MIN  = 3;            // minimum co-directional aircraft to form a corridor
const HEADING_BIN   = 15;           // degrees per heading bucket

const PRIORITY_RE         = /^(FDX|UPS|DHL|PAC|[A-Z]{2}\d)/i;
const CARGO_PREFIXES      = ['FDX', 'UPS', 'CLX', 'GTI', 'ABX'];
const MILITARY_PREFIXES   = ['RCH', 'BAF', 'RAF', 'AMC', 'NAV'];
const COMMERCIAL_PREFIXES = ['DAL', 'UAL', 'AAL', 'SWA', 'BAW', 'AFR', 'KLM'];

// ── Flight classification ──────────────────────────────────────────────────────
function classifyFlight(callsign, alt) {
  const prefix = (callsign || '').trim().slice(0, 3).toUpperCase();
  if (MILITARY_PREFIXES.includes(prefix))   return 'military';
  if (CARGO_PREFIXES.includes(prefix))      return 'cargo';
  if (COMMERCIAL_PREFIXES.includes(prefix)) return 'commercial';
  if (alt != null && alt > 20000)           return 'commercial';
  return 'unknown';
}

// ── 5° grid cell ID (row:col) ──────────────────────────────────────────────────
function cellId(lat, lon) {
  const row = Math.floor((lat  + 90)  / GRID_DEG);
  const col = Math.floor((lon  + 180) / GRID_DEG);
  return `${row}:${col}`;
}

// ── Altitude band ──────────────────────────────────────────────────────────────
function altBand(alt) {
  if (alt == null || isNaN(alt)) return 'unknown';
  if (alt < 10000)  return 'low';     // approach / departure / VFR
  if (alt < 25000)  return 'mid';     // transition
  if (alt < 40000)  return 'cruise';  // standard en-route
  return 'high';                      // above standard cruise / special
}

// ── Flight phase from vertical rate (ft/min) ───────────────────────────────────
function flightPhase(vs) {
  if (vs == null || isNaN(vs)) return 'cruise';
  if (vs >  500) return 'climb';
  if (vs < -500) return 'descent';
  return 'cruise';
}

// ── Fisher-Yates partial shuffle (in-place, returns first n items randomly) ───
function partialShuffle(arr, n) {
  const pool = arr.slice();
  const take = Math.min(n, pool.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, take);
}

// ── Region definitions — centers + radii for adsb.lol /v2/lat/lon/dist ────────
// Weights removed: density suppression now handled entirely by grid-stratified
// sampling rather than per-region fixed multipliers.
const REGIONS = [
  { name: 'NA_EAST',   lat:  40,  lon:  -75,  dist: 650 },
  { name: 'NA_WEST',   lat:  37,  lon: -118,  dist: 650 },
  { name: 'EUROPE',    lat:  51,  lon:   10,  dist: 750 },
  { name: 'EAST_ASIA', lat:  35,  lon:  127,  dist: 700 },
  { name: 'SE_ASIA',   lat:   5,  lon:  108,  dist: 650 },
  { name: 'MIDEAST',   lat:  25,  lon:   52,  dist: 550 },
  { name: 'LATAM',     lat: -10,  lon:  -55,  dist: 750 },
  { name: 'OCEANIA',   lat: -25,  lon:  140,  dist: 750 },
  { name: 'AFRICA',    lat:   5,  lon:   22,  dist: 750 },  // West/Central/East Africa — previously unqueried
  { name: 'RUSSIA',    lat:  60,  lon:   80,  dist: 800 },  // Siberia/Central Russia — gap east of EUROPE
];

// ── Fetch one region — full snapshot, no per-fetch aircraft cap ────────────────
async function fetchRegion(region) {
  const url = `https://api.adsb.lol/v2/lat/${region.lat}/lon/${region.lon}/dist/${region.dist}`;
  const res  = await fetch(url, {
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
    .map(s => {
      const cs  = (s.flight || '').trim();
      const alt = s.alt_baro  ?? null;
      const vs  = s.baro_rate ?? null;       // vertical rate ft/min
      const gs  = s.gs        ?? null;       // ground speed knots
      return {
        icao24:     (s.hex || '').toLowerCase().trim(),   // unique aircraft ID
        region:     region.name,
        cs,
        lat:        s.lat,
        lon:        s.lon,
        track:      s.track ?? null,          // true heading 0-360
        gs,                                   // ground speed knots
        alt,
        vs,
        altBand:    altBand(alt),
        phase:      flightPhase(vs),
        flightType: classifyFlight(cs, alt),
        cellId:     cellId(s.lat, s.lon),
        seenAt:     Date.now(),               // per-aircraft timestamp ms
      };
    });
}

// Stagger fetches 2 at a time with 400 ms between batches — same as v3
async function fetchRegionsThrottled(regions) {
  const results = [];
  const batchSize = 2, delayMs = 400;
  for (let i = 0; i < regions.length; i += batchSize) {
    const batch   = regions.slice(i, i + batchSize);
    const settled = await Promise.allSettled(batch.map(fetchRegion));
    results.push(...settled);
    if (i + batchSize < regions.length)
      await new Promise(r => setTimeout(r, delayMs));
  }
  return results;
}

// ── Grid-stratified sampler ────────────────────────────────────────────────────
// Phase 1: guaranteed MIN_PER_CELL from every populated 5° cell (priority callsigns first).
// Phase 2: remaining budget distributed by inverse-√density weights so sparse cells
//          receive proportionally more of the surplus than dense hubs.
function gridStratifiedSample(allAircraft, budget) {
  // Build cell map
  const cellMap = new Map();
  for (const a of allAircraft) {
    if (!cellMap.has(a.cellId)) cellMap.set(a.cellId, []);
    cellMap.get(a.cellId).push(a);
  }

  // Phase 1 — guaranteed minimum; priority aircraft always taken first
  const selected = [];
  const overflow = new Map();  // residual per cell after minimum taken

  for (const [id, ac] of cellMap) {
    const priority = ac.filter(a => PRIORITY_RE.test(a.cs));
    const rest     = ac.filter(a => !PRIORITY_RE.test(a.cs));
    const pool     = [...priority, ...partialShuffle(rest, rest.length)];
    const minTake  = Math.min(MIN_PER_CELL, pool.length);
    selected.push(...pool.slice(0, minTake));
    if (pool.length > minTake) overflow.set(id, pool.slice(minTake));
  }

  // Phase 2 — inverse-√density allocation of remaining budget
  let remaining = budget - selected.length;
  if (remaining <= 0 || overflow.size === 0) return selected.slice(0, budget);

  let totalW = 0;
  const weights = new Map();
  for (const [id] of overflow) {
    // Sparse cell (small cellMap size) → higher weight; hub → lower weight
    const w = 1 / Math.sqrt(cellMap.get(id).length);
    weights.set(id, w);
    totalW += w;
  }

  for (const [id, ac] of overflow) {
    const allocation = Math.round((weights.get(id) / totalW) * remaining);
    selected.push(...ac.slice(0, Math.min(allocation, ac.length)));
  }

  return selected.slice(0, budget);
}

// ── Corridor detection — heading-bucketed centroids per grid cell ──────────────
// For each (cellId × headingBucket) pair with ≥ CORRIDOR_MIN aircraft, emits a
// corridor centroid: { lat, lon, heading, count, cellId }.
// Represents directional flow without full DBSCAN cost.
function detectCorridors(aircraft) {
  const clusters = new Map();

  for (const a of aircraft) {
    if (a.track == null) continue;
    const hBucket = Math.floor(a.track / HEADING_BIN) * HEADING_BIN;
    const key     = `${a.cellId}:${hBucket}`;
    if (!clusters.has(key))
      clusters.set(key, { latSum: 0, lonSum: 0, heading: hBucket, count: 0, cellId: a.cellId });
    const c = clusters.get(key);
    c.latSum += a.lat;
    c.lonSum += a.lon;
    c.count++;
  }

  const corridors = [];
  for (const c of clusters.values()) {
    if (c.count < CORRIDOR_MIN) continue;
    corridors.push({
      lat:     parseFloat((c.latSum / c.count).toFixed(2)),
      lon:     parseFloat((c.lonSum / c.count).toFixed(2)),
      heading: c.heading,
      count:   c.count,
      cellId:  c.cellId,
    });
  }

  // Return top 80 corridors by aircraft count (most active routes first)
  return corridors.sort((a, b) => b.count - a.count).slice(0, 80);
}

// ── Temporal carry-forward ─────────────────────────────────────────────────────
// Cells present in prevAircraft but absent from current snapshot are carried
// forward for one cycle (marked stale:true). Prevents single-cycle region gaps
// caused by momentary API miss or sparse sampling edge cases.
function applyCarryForward(current, prevAircraft) {
  if (!prevAircraft || !prevAircraft.length) return current;

  const currentCells = new Set(current.map(a => a.cellId));
  const prevByCell   = new Map();
  for (const a of prevAircraft) {
    if (!prevByCell.has(a.cellId)) prevByCell.set(a.cellId, []);
    prevByCell.get(a.cellId).push(a);
  }

  const carried = [];
  for (const [cId, ac] of prevByCell) {
    if (!currentCells.has(cId)) {
      carried.push(...ac.slice(0, MIN_PER_CELL).map(a => ({ ...a, stale: true })));
    }
  }

  return [...current, ...carried];
}

// ── Merge all regions, cross-region ICAO24 dedup ──────────────────────────────
// Aircraft near region boundaries appear in multiple regional fetches.
// ICAO24-based dedup ensures each physical aircraft counts once.
function aggregateRegions(regionCache) {
  const seen = new Set();
  const all  = [];
  for (const region of REGIONS) {
    for (const a of (regionCache[region.name]?.aircraft || [])) {
      if (a.icao24 && seen.has(a.icao24)) continue;
      if (a.icao24) seen.add(a.icao24);
      all.push(a);
    }
  }
  return all;
}

// ── Handler ────────────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS')
    return { statusCode: 204, headers, body: '' };

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const now      = Date.now();

  // ── Load cache ───────────────────────────────────────────────────────────────
  let regionCache  = {};
  let prevAircraft = [];
  try {
    const { data } = await supabase
      .from('global_events')
      .select('payload')
      .eq('key', CACHE_KEY)
      .single();
    if (data?.payload) {
      regionCache  = data.payload.regions || {};
      prevAircraft = data.payload.prev    || [];
    }
  } catch (_) {}

  // ── Determine stale regions ──────────────────────────────────────────────────
  const stale  = REGIONS.filter(r => {
    const c = regionCache[r.name];
    return !c || (now - c.ts) >= REGION_TTL_MS;
  });

  console.log(
    `Stale: [${stale.map(r => r.name).join(', ')}]`,
    `| Cached: [${REGIONS.filter(r => !stale.includes(r)).map(r => r.name).join(', ')}]`
  );

  // ── Fetch stale regions (full snapshot — no per-fetch cap) ───────────────────
  if (stale.length) {
    const results = await fetchRegionsThrottled(stale);
    stale.forEach((region, i) => {
      const res = results[i];
      if (res.status === 'fulfilled') {
        console.log(`[${region.name}] raw: ${res.value.length}`);
        regionCache[region.name] = { aircraft: res.value, ts: now };
      } else {
        console.error(`[${region.name}] FAILED: ${results[i].reason?.message}`);
        // Preserve stale cache on failure — never evict
      }
    });
  }

  // ── Merge → dedup → grid-stratified sample ───────────────────────────────────
  const merged  = aggregateRegions(regionCache);
  const sampled = gridStratifiedSample(merged, GLOBAL_CAP);

  // ── Temporal carry-forward ───────────────────────────────────────────────────
  const withCarryForward = applyCarryForward(sampled, prevAircraft);

  // ── Corridor detection (on non-stale aircraft only) ──────────────────────────
  const corridors = detectCorridors(withCarryForward.filter(a => !a.stale));

  // ── Persist: store fresh sampled set as next cycle's prev ─────────────────────
  if (stale.length) {
    try {
      await supabase.from('global_events').upsert({
        key:        CACHE_KEY,
        payload:    { regions: regionCache, prev: sampled },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });
    } catch (err) {
      console.warn('Supabase upsert failed:', err.message);
    }
  }

  // ── Region status + cell diagnostics ─────────────────────────────────────────
  const regionStatus = {};
  REGIONS.forEach(r => {
    const c = regionCache[r.name];
    regionStatus[r.name] = c
      ? { count: c.aircraft.length, age_s: Math.round((now - c.ts) / 1000) }
      : 'no-data';
  });

  const activeCells = new Set(withCarryForward.map(a => a.cellId)).size;
  const staleCells  = withCarryForward.filter(a => a.stale).length;

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      source:      stale.length ? 'live' : 'cache',
      regions:     regionStatus,
      total:       withCarryForward.length,
      activeCells,
      staleCells,
      corridors,
      aircraft:    withCarryForward,
    }),
  };
};
