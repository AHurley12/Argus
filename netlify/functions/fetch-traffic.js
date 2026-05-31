// netlify/functions/fetch-traffic.js
// Adaptive geographic ADS-B ingestion pipeline v5.
//
// v5 changes from v4:
//   - 22 regions (was 12) — eliminates geographic blind spots
//   - Tiered TTLs: core=5 min, standard=8 min, discovery=12 min
//   - Per-region priority scoring prevents cold-start burst (MAX_SLOTS_PER_CYCLE=12)
//   - Adaptive yield EMA + stale-bonus ensures every region eventually gets polled
//   - Coverage heatmap logged each cycle to Netlify function logs
//
// Geographic gaps eliminated vs v4:
//   NA_CENTRAL  — US Midwest/Great Plains (gap between NA_EAST and NA_WEST)
//   NA_NORTH    — Canada + polar approach corridors
//   N_AFRICA    — Libya, Tunisia, Algeria, Egypt (was buried under AFRICA center)
//   S_AFRICA    — Southern Africa, Namibia, Zimbabwe
//   LATAM_S     — Argentina, Chile, Patagonia southern cone
//   C_ASIA      — Kazakhstan, Uzbekistan, Turkmenistan corridor
//   ARCTIC      — Trans-polar routes (Europe–Asia overfly)
//   INDONESIA   — Eastern Indonesian archipelago (SE_ASIA misses this)
//   N_ATLANTIC  — NATS transatlantic corridor (Gander–Shanwick)
//   S_ATLANTIC  — Brazil–Africa air bridge
//
// Rate analysis (steady state, 90 s Netlify CDN cache per client):
//   Core     (7 regions,  5-min TTL):  ~2.1 stale regions/invocation
//   Standard (8 regions,  8-min TTL):  ~1.5 stale regions/invocation
//   Discovery (7 regions, 12-min TTL): ~0.9 stale regions/invocation
//   Total avg ~4.5 stale/invocation — comfortably below MAX_SLOTS_PER_CYCLE=12
//   Cold start: exactly 12 parallel fetches (same as v4)
//
// All v4 guarantees preserved:
//   • MIN_PER_CELL per active 5° grid cell
//   • Inverse-√density surplus allocation
//   • Cross-region ICAO24 deduplication
//   • Temporal carry-forward (stale cells)
//   • Corridor detection (heading-bucketed centroids)
//   • Supabase persistence (same cache key)

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;

const CACHE_KEY          = 'air_traffic_v4';    // unchanged — shares Supabase row with v4
const GLOBAL_CAP         = 750;
const MIN_PER_CELL       = 2;
const GRID_DEG           = 5;
const CORRIDOR_MIN       = 3;
const HEADING_BIN        = 15;
const MAX_SLOTS_PER_CYCLE = 12;  // max parallel adsb.lol calls per invocation

// Tier TTLs
const TTL_CORE      = 5  * 60 * 1000;  // 300 s — high-density, polled every cycle
const TTL_STANDARD  = 8  * 60 * 1000;  // 480 s — moderate value, frequent refresh
const TTL_DISCOVERY = 12 * 60 * 1000;  // 720 s — blind-spot fill, priority-rotated

const PRIORITY_RE         = /^(FDX|UPS|DHL|PAC|[A-Z]{2}\d)/i;
const CARGO_PREFIXES      = ['FDX', 'UPS', 'CLX', 'GTI', 'ABX'];
const MILITARY_PREFIXES   = ['RCH', 'BAF', 'RAF', 'AMC', 'NAV'];
const COMMERCIAL_PREFIXES = ['DAL', 'UAL', 'AAL', 'SWA', 'BAW', 'AFR', 'KLM'];

// ── Region catalog ─────────────────────────────────────────────────────────────
//
// tier:     'core' | 'standard' | 'discovery'
// geoFloor: base priority score for the tier — core always wins slot competition
//           unless a lower-tier region has accumulated enough staleBonus
//
// Priority formula (per-cycle slot selection when stale count > MAX_SLOTS_PER_CYCLE):
//   priority = geoFloor + yieldBonus + staleBonus
//   yieldBonus  = min(0.4, yieldAvg / 600)   — rewards high-aircraft-count regions
//   staleBonus  = min(0.6, cyclesSkipped × 0.15) — grows each cycle a region loses slot
//
// A discovery region starts at geoFloor=0.2. After 3 lost cycles its staleBonus=0.45
// pushing it to 0.65+, outcompeting many standard regions. After 5 cycles it reaches
// 0.75+ and outcompetes all but the busiest core regions. This guarantees every region
// is polled within 5–6 invocation cycles regardless of yield.
const REGIONS = [
  // ── Core (7 regions) — polled every ~5 min ────────────────────────────────
  { name: 'NA_EAST',    lat:  40, lon:  -75, dist: 650, tier: 'core',      geoFloor: 0.7 },
  { name: 'NA_WEST',    lat:  37, lon: -118, dist: 650, tier: 'core',      geoFloor: 0.7 },
  { name: 'EUROPE',     lat:  51, lon:   10, dist: 750, tier: 'core',      geoFloor: 0.8 },
  { name: 'EAST_ASIA',  lat:  35, lon:  127, dist: 700, tier: 'core',      geoFloor: 0.7 },
  { name: 'SE_ASIA',    lat:   5, lon:  108, dist: 650, tier: 'core',      geoFloor: 0.6 },
  { name: 'MIDEAST',    lat:  25, lon:   52, dist: 550, tier: 'core',      geoFloor: 0.6 },
  { name: 'INDIA',      lat:  22, lon:   82, dist: 600, tier: 'core',      geoFloor: 0.6 },
  // ── Standard (8 regions) — polled every ~8 min ───────────────────────────
  { name: 'LATAM',      lat: -10, lon:  -55, dist: 750, tier: 'standard',  geoFloor: 0.4 },
  { name: 'OCEANIA',    lat: -25, lon:  140, dist: 750, tier: 'standard',  geoFloor: 0.4 },
  { name: 'AFRICA',     lat:   5, lon:   22, dist: 750, tier: 'standard',  geoFloor: 0.4 },
  { name: 'RUSSIA',     lat:  60, lon:   80, dist: 800, tier: 'standard',  geoFloor: 0.4 },
  { name: 'CARIB',      lat:  15, lon:  -80, dist: 500, tier: 'standard',  geoFloor: 0.3 },
  { name: 'NA_CENTRAL', lat:  42, lon:  -95, dist: 650, tier: 'standard',  geoFloor: 0.4 },  // NEW: US Midwest
  { name: 'N_AFRICA',   lat:  28, lon:   18, dist: 700, tier: 'standard',  geoFloor: 0.3 },  // NEW: Maghreb + Sahara corridors
  { name: 'INDONESIA',  lat:  -3, lon:  118, dist: 650, tier: 'standard',  geoFloor: 0.3 },  // NEW: Eastern archipelago
  // ── Discovery (7 regions) — polled every ~12 min, priority-rotated ────────
  { name: 'NA_NORTH',   lat:  55, lon: -100, dist: 750, tier: 'discovery', geoFloor: 0.2 },  // NEW: Canada / NOPAC approaches
  { name: 'S_AFRICA',   lat: -27, lon:   25, dist: 650, tier: 'discovery', geoFloor: 0.2 },  // NEW: Southern Africa
  { name: 'LATAM_S',    lat: -35, lon:  -65, dist: 650, tier: 'discovery', geoFloor: 0.2 },  // NEW: Argentina / Chile
  { name: 'C_ASIA',     lat:  42, lon:   62, dist: 700, tier: 'discovery', geoFloor: 0.2 },  // NEW: Kazakh / Silk Road corridor
  { name: 'ARCTIC',     lat:  75, lon:   20, dist: 750, tier: 'discovery', geoFloor: 0.2 },  // NEW: Polar routes
  { name: 'N_ATLANTIC', lat:  50, lon:  -35, dist: 700, tier: 'discovery', geoFloor: 0.2 },  // NEW: NATS transatlantic
  { name: 'S_ATLANTIC', lat: -15, lon:  -22, dist: 700, tier: 'discovery', geoFloor: 0.2 },  // NEW: South Atlantic bridge
];

// ── Zone groupings for coverage heatmap ───────────────────────────────────────
const HEATMAP_ZONES = {
  'North America':       ['NA_EAST', 'NA_WEST', 'NA_CENTRAL', 'NA_NORTH', 'CARIB'],
  'South America':       ['LATAM', 'LATAM_S'],
  'Europe':              ['EUROPE'],
  'North Africa':        ['N_AFRICA'],
  'Sub-Saharan Africa':  ['AFRICA', 'S_AFRICA'],
  'Middle East':         ['MIDEAST'],
  'Central Asia':        ['C_ASIA'],
  'India':               ['INDIA'],
  'Southeast Asia':      ['SE_ASIA', 'INDONESIA'],
  'East Asia':           ['EAST_ASIA'],
  'Russia / Siberia':    ['RUSSIA'],
  'Arctic':              ['ARCTIC'],
  'Oceania':             ['OCEANIA'],
  'North Atlantic':      ['N_ATLANTIC'],
  'South Atlantic':      ['S_ATLANTIC'],
};

// ── TTL by tier ────────────────────────────────────────────────────────────────
function regionTtl(region) {
  if (region.tier === 'core')     return TTL_CORE;
  if (region.tier === 'standard') return TTL_STANDARD;
  return TTL_DISCOVERY;
}

// ── Per-region priority ────────────────────────────────────────────────────────
function regionPriority(region, scores) {
  const s          = (scores && scores[region.name]) || { yieldAvg: 0, cyclesSkipped: 0 };
  const yieldBonus = Math.min(0.4, (s.yieldAvg || 0) / 600);
  const staleBonus = Math.min(0.6, (s.cyclesSkipped || 0) * 0.15);
  return region.geoFloor + yieldBonus + staleBonus;
}

// ── Slot selection ────────────────────────────────────────────────────────────
// Returns { selected, skippedStale } where selected is the fetch list for this
// cycle (≤ MAX_SLOTS_PER_CYCLE), skippedStale are regions that were due but lost
// the priority contest (their cyclesSkipped will be incremented).
function selectRegions(regionCache, scores, now) {
  const stale = REGIONS.filter(r => {
    const c = regionCache[r.name];
    return !c || (now - c.ts) >= regionTtl(r);
  });

  if (stale.length <= MAX_SLOTS_PER_CYCLE) {
    return { selected: stale, skippedStale: [] };
  }

  const ranked  = stale.slice().sort((a, b) => regionPriority(b, scores) - regionPriority(a, scores));
  const selected = ranked.slice(0, MAX_SLOTS_PER_CYCLE);
  const skippedStale = ranked.slice(MAX_SLOTS_PER_CYCLE);
  return { selected, skippedStale };
}

// ── Score update after each cycle ─────────────────────────────────────────────
function updateScores(scores, fetched, skippedStale, regionCache) {
  const next = Object.assign({}, scores);

  for (const region of fetched) {
    const count = (regionCache[region.name] && regionCache[region.name].aircraft
      ? regionCache[region.name].aircraft.length : 0);
    const prev  = next[region.name] || { yieldAvg: 0, cyclesSkipped: 0 };
    // EMA α=0.3 — recent results weighted more but history preserved
    next[region.name] = {
      yieldAvg:      Math.round((prev.yieldAvg || 0) * 0.7 + count * 0.3),
      cyclesSkipped: 0,
    };
  }

  for (const region of skippedStale) {
    const prev = next[region.name] || { yieldAvg: 0, cyclesSkipped: 0 };
    next[region.name] = {
      yieldAvg:      prev.yieldAvg || 0,
      cyclesSkipped: (prev.cyclesSkipped || 0) + 1,
    };
  }

  return next;
}

// ── Coverage heatmap ───────────────────────────────────────────────────────────
function logCoverageHeatmap(aircraft) {
  const regionToZone = {};
  for (const [zone, regions] of Object.entries(HEATMAP_ZONES)) {
    for (const r of regions) regionToZone[r] = zone;
  }

  const zoneCounts = {};
  for (const a of aircraft) {
    const zone = regionToZone[a.region] || 'Other';
    zoneCounts[zone] = (zoneCounts[zone] || 0) + 1;
  }

  const sorted = Object.entries(zoneCounts).sort((a, b) => b[1] - a[1]);

  console.log('\n[ArgusAircraftCoverage] ─── Coverage Heatmap ───────────────────');
  for (const [zone, count] of sorted) {
    const bar = '█'.repeat(Math.min(30, Math.round(count / 8)));
    console.log(`  ${zone.padEnd(22)} ${String(count).padStart(4)}  ${bar}`);
  }
  console.log(`  ${'TOTAL'.padEnd(22)} ${String(aircraft.length).padStart(4)}`);
  console.log('[ArgusAircraftCoverage] ─────────────────────────────────────────\n');
}

// ── Flight classification ──────────────────────────────────────────────────────
function classifyFlight(callsign, alt) {
  const prefix = (callsign || '').trim().slice(0, 3).toUpperCase();
  if (MILITARY_PREFIXES.includes(prefix))   return 'military';
  if (CARGO_PREFIXES.includes(prefix))      return 'cargo';
  if (COMMERCIAL_PREFIXES.includes(prefix)) return 'commercial';
  if (alt != null && alt > 20000)           return 'commercial';
  return 'unknown';
}

// ── 5° grid cell ID ────────────────────────────────────────────────────────────
function cellId(lat, lon) {
  const row = Math.floor((lat  + 90)  / GRID_DEG);
  const col = Math.floor((lon  + 180) / GRID_DEG);
  return `${row}:${col}`;
}

// ── Altitude band ──────────────────────────────────────────────────────────────
function altBand(alt) {
  if (alt == null || isNaN(alt)) return 'unknown';
  if (alt < 10000)  return 'low';
  if (alt < 25000)  return 'mid';
  if (alt < 40000)  return 'cruise';
  return 'high';
}

// ── Flight phase ───────────────────────────────────────────────────────────────
function flightPhase(vs) {
  if (vs == null || isNaN(vs)) return 'cruise';
  if (vs >  500) return 'climb';
  if (vs < -500) return 'descent';
  return 'cruise';
}

// ── Fisher-Yates partial shuffle ───────────────────────────────────────────────
function partialShuffle(arr, n) {
  const pool = arr.slice();
  const take = Math.min(n, pool.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, take);
}

// ── Region fetch ───────────────────────────────────────────────────────────────
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
      const vs  = s.baro_rate ?? null;
      const gs  = s.gs        ?? null;
      return {
        icao24:     (s.hex || '').toLowerCase().trim(),
        region:     region.name,
        cs,
        lat:        s.lat,
        lon:        s.lon,
        track:      s.track ?? null,
        gs,
        alt,
        vs,
        altBand:    altBand(alt),
        phase:      flightPhase(vs),
        flightType: classifyFlight(cs, alt),
        cellId:     cellId(s.lat, s.lon),
        seenAt:     Date.now(),
      };
    });
}

// Parallel fetch — fits within Netlify's 26 s timeout.
async function fetchRegionsThrottled(regions) {
  return Promise.allSettled(regions.map(fetchRegion));
}

// ── Grid-stratified sampler ────────────────────────────────────────────────────
// Phase 1: guaranteed MIN_PER_CELL from every populated 5° cell.
// Phase 2: remaining budget distributed by inverse-√density so sparse cells
//          receive proportionally more of the surplus than dense hubs.
function gridStratifiedSample(allAircraft, budget) {
  const cellMap = new Map();
  for (const a of allAircraft) {
    if (!cellMap.has(a.cellId)) cellMap.set(a.cellId, []);
    cellMap.get(a.cellId).push(a);
  }

  const selected = [];
  const overflow = new Map();

  for (const [id, ac] of cellMap) {
    const priority = ac.filter(a => PRIORITY_RE.test(a.cs));
    const rest     = ac.filter(a => !PRIORITY_RE.test(a.cs));
    const pool     = [...priority, ...partialShuffle(rest, rest.length)];
    const minTake  = Math.min(MIN_PER_CELL, pool.length);
    selected.push(...pool.slice(0, minTake));
    if (pool.length > minTake) overflow.set(id, pool.slice(minTake));
  }

  let remaining = budget - selected.length;
  if (remaining <= 0 || overflow.size === 0) return selected.slice(0, budget);

  let totalW = 0;
  const weights = new Map();
  for (const [id] of overflow) {
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

// ── Corridor detection ─────────────────────────────────────────────────────────
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

  return corridors.sort((a, b) => b.count - a.count).slice(0, 80);
}

// ── Temporal carry-forward ─────────────────────────────────────────────────────
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

// ── Cross-region ICAO24 dedup ──────────────────────────────────────────────────
function aggregateRegions(regionCache) {
  const seen = new Set();
  const all  = [];
  for (const region of REGIONS) {
    for (const a of ((regionCache[region.name] && regionCache[region.name].aircraft) || [])) {
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

  // ── Load cache + scores ──────────────────────────────────────────────────────
  let regionCache  = {};
  let prevAircraft = [];
  let scores       = {};
  try {
    const { data } = await supabase
      .from('global_events')
      .select('payload')
      .eq('key', CACHE_KEY)
      .single();
    if (data && data.payload) {
      regionCache  = data.payload.regions || {};
      prevAircraft = data.payload.prev    || [];
      scores       = data.payload.scores  || {};
    }
  } catch (_) {}

  // ── Select regions to fetch this cycle ──────────────────────────────────────
  const { selected, skippedStale } = selectRegions(regionCache, scores, now);

  const cachedNames  = REGIONS.filter(r => !selected.includes(r) && !skippedStale.includes(r)).map(r => r.name);
  const selectedNames = selected.map(r => r.name);

  console.log(
    `[v5] Fetching [${selectedNames.join(', ')}]`,
    `| Cached: [${cachedNames.join(', ')}]`,
    skippedStale.length ? `| Deferred (slot cap): [${skippedStale.map(r => r.name).join(', ')}]` : ''
  );

  // ── Fetch selected regions ───────────────────────────────────────────────────
  if (selected.length) {
    const results = await fetchRegionsThrottled(selected);
    selected.forEach((region, i) => {
      const res = results[i];
      if (res.status === 'fulfilled') {
        console.log(`[${region.name}] tier=${region.tier} raw=${res.value.length}`);
        regionCache[region.name] = { aircraft: res.value, ts: now };
      } else {
        console.error(`[${region.name}] FAILED: ${results[i].reason && results[i].reason.message}`);
        // Preserve stale cache on failure — never evict
      }
    });
  }

  // ── Update priority scores ───────────────────────────────────────────────────
  scores = updateScores(scores, selected, skippedStale, regionCache);

  // ── Merge → dedup → grid-stratified sample ───────────────────────────────────
  const merged  = aggregateRegions(regionCache);
  const sampled = gridStratifiedSample(merged, GLOBAL_CAP);

  // ── Temporal carry-forward ───────────────────────────────────────────────────
  const withCarryForward = applyCarryForward(sampled, prevAircraft);

  // ── Corridor detection ───────────────────────────────────────────────────────
  const corridors = detectCorridors(withCarryForward.filter(a => !a.stale));

  // ── Coverage heatmap ─────────────────────────────────────────────────────────
  logCoverageHeatmap(withCarryForward);

  // ── Persist ──────────────────────────────────────────────────────────────────
  if (selected.length) {
    try {
      await supabase.from('global_events').upsert({
        key:        CACHE_KEY,
        payload:    { regions: regionCache, prev: sampled, scores },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });
    } catch (err) {
      console.warn('Supabase upsert failed:', err.message);
    }
  }

  // ── Region status ─────────────────────────────────────────────────────────────
  const regionStatus = {};
  REGIONS.forEach(r => {
    const c = regionCache[r.name];
    const s = scores[r.name] || {};
    regionStatus[r.name] = c
      ? {
          count:       c.aircraft.length,
          age_s:       Math.round((now - c.ts) / 1000),
          tier:        r.tier,
          yieldAvg:    s.yieldAvg || 0,
          cyclesSkipped: s.cyclesSkipped || 0,
        }
      : 'no-data';
  });

  const activeCells = new Set(withCarryForward.map(a => a.cellId)).size;
  const staleCells  = withCarryForward.filter(a => a.stale).length;

  return {
    statusCode: 200,
    headers: {
      ...headers,
      'Cache-Control': 'public, s-maxage=90, stale-while-revalidate=30',
    },
    body: JSON.stringify({
      source:      selected.length ? 'live' : 'cache',
      regions:     regionStatus,
      total:       withCarryForward.length,
      activeCells,
      staleCells,
      corridors,
      aircraft:    withCarryForward,
    }),
  };
};
