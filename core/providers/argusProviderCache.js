'use strict';
// core/providers/argusProviderCache.js
// Supplemental aircraft ingestion — two sources, one shared cache.
//
// ── Source A: adsb.lol ────────────────────────────────────────────────────────
//   /.netlify/functions/fetch-supplemental — viewport-centered, every 5 min.
//
// ── Source B: adsb.fi ─────────────────────────────────────────────────────────
//   /adsb/* Netlify proxy redirect — adaptive priority regional scheduler.
//
//   Architecture: coverage-age-weighted time-division multiplexing.
//   One tile is polled per TICK_MS (10 s). The tile selected each tick is the
//   one with the highest overdue score:
//
//     score = (nowMs - lastPolledAt) / targetRevisitMs
//
//   Tiles that have not been polled in longer than their target window score > 1
//   and are always preferred over current tiles. Because sparse tiles carry a
//   shorter targetRevisitMs (300 s) than dense tiles (800 s), their score
//   accumulates faster — they are picked more frequently even though dense tiles
//   cover busier airspace. This is intentional: dense airspace is already covered
//   by the primary fetch-traffic pipeline. The supplemental layer's job is global
//   geographic representativeness, not maximum aircraft count.
//
//   Rate: exactly 6 req/min — structurally burst-proof by design.
//
//   47 globally distributed tiles across 4 density tiers:
//     dense    (8 tiles)  — cap 45, targetRevisit 800 s
//     medium   (15 tiles) — cap 35, targetRevisit 500 s
//     sparse   (19 tiles) — cap 20, targetRevisit 300 s
//     maritime (5 tiles)  — cap 15, targetRevisit 400 s (transoceanic corridors)
//
//   Within-tile anti-clustering: results are grouped by 1° grid cells before
//   the tile cap is applied. Each cell receives floor(cap / cellCount) slots,
//   min 2. This prevents a single dense airport from consuming a tile's entire
//   quota regardless of how many aircraft the API returns for that airport.
//
// ── Source isolation ──────────────────────────────────────────────────────────
//   adsb.lol entries: _source = 'supplemental'
//   adsb.fi entries:  _source = 'adsb-fi:<tileLabel>'
//   Stale eviction is per-source — a tile refresh never touches entries from
//   other tiles or from adsb.lol.
//
// ── Render budget ─────────────────────────────────────────────────────────────
//   AIRCRAFT_LIMIT (argusTracking.js) = 750. Primary fetch-traffic fills first.
//   Supplemental fills remaining slots. MAX_INJECT = 650 gives headroom for
//   both adsb.lol and adsb.fi without exceeding the render budget.
//
// Dependencies:
//   window._argusReqCache   — deduped fetch (adsb.lol path only)
//   window.ArgusGlobe       — globe rotation for viewport center
//   window.ArgusModuleAudit — optional

(function () {
  'use strict';

  // ── Config ────────────────────────────────────────────────────────────────────
  var SUPPLEMENTAL_FN   = '/.netlify/functions/fetch-supplemental';
  var SUPPLEMENTAL_POLL = 5 * 60 * 1000;  // 5 min — adsb.lol viewport poll
  var ADSB_DIST_NM      = 250;            // viewport radius for adsb.lol (nm)
  var TICK_MS           = 10 * 1000;      // 10 s between adsb.fi tile polls — 6 req/min steady state
  var TICK_INIT_DELAY   = 25 * 1000;      // 25 s before first tick (primary pipeline settles first)
  var MAX_INJECT        = 650;            // combined cache ceiling
  var STALE_MS          = 15 * 60 * 1000; // 15 min global stale threshold

  // ── Global tile set ───────────────────────────────────────────────────────────
  // 47 tiles covering all major airspace, maritime corridors, and polar routes.
  //
  // targetRevisitMs — adaptive scheduler target: shorter = picked more often.
  //   dense tiles    800 s — primary already covers, supplemental fills gaps
  //   medium tiles   500 s — moderate primary coverage, supplemental adds depth
  //   sparse tiles   300 s — rare traffic; frequent polls needed to catch any
  //   maritime tiles 400 s — transoceanic; infrequent but globally significant
  //
  // cap — max aircraft accepted per poll after within-tile anti-clustering.
  // dist — query radius in nm; smaller in dense areas → tighter bound per poll.
  //
  // lastPolledAt is mutated in place by the scheduler. Initial value 0 → score
  // of Infinity on first evaluation → all tiles polled once before rebalancing.
  var GLOBAL_TILES = [
    // ── Dense (8 tiles) — targetRevisit=800s, cap=45 ─────────────────────────
    { label: 'NA_NE',      lat:  42, lon:  -73, dist: 280, cap: 45, tier: 'dense',    targetRevisitMs: 800000, lastPolledAt: 0 },
    { label: 'NA_MID',     lat:  38, lon:  -77, dist: 260, cap: 45, tier: 'dense',    targetRevisitMs: 800000, lastPolledAt: 0 },
    { label: 'EU_UK',      lat:  53, lon:   -2, dist: 280, cap: 45, tier: 'dense',    targetRevisitMs: 800000, lastPolledAt: 0 },
    { label: 'EU_WEST',    lat:  47, lon:    5, dist: 280, cap: 45, tier: 'dense',    targetRevisitMs: 800000, lastPolledAt: 0 },
    { label: 'EU_CENTRAL', lat:  51, lon:   14, dist: 280, cap: 45, tier: 'dense',    targetRevisitMs: 800000, lastPolledAt: 0 },
    { label: 'AS_JAPAN',   lat:  35, lon:  137, dist: 300, cap: 45, tier: 'dense',    targetRevisitMs: 800000, lastPolledAt: 0 },
    { label: 'AS_KOREA',   lat:  37, lon:  128, dist: 270, cap: 45, tier: 'dense',    targetRevisitMs: 800000, lastPolledAt: 0 },
    { label: 'AS_CHINA_E', lat:  32, lon:  121, dist: 340, cap: 45, tier: 'dense',    targetRevisitMs: 800000, lastPolledAt: 0 },
    // ── Medium (15 tiles) — targetRevisit=500s, cap=35 ───────────────────────
    { label: 'NA_SE',      lat:  33, lon:  -84, dist: 300, cap: 35, tier: 'medium',   targetRevisitMs: 500000, lastPolledAt: 0 },
    { label: 'NA_FL',      lat:  27, lon:  -82, dist: 270, cap: 35, tier: 'medium',   targetRevisitMs: 500000, lastPolledAt: 0 },
    { label: 'NA_MIDWEST', lat:  41, lon:  -87, dist: 280, cap: 35, tier: 'medium',   targetRevisitMs: 500000, lastPolledAt: 0 },
    { label: 'NA_NW',      lat:  47, lon: -122, dist: 310, cap: 35, tier: 'medium',   targetRevisitMs: 500000, lastPolledAt: 0 },
    { label: 'NA_SW',      lat:  35, lon: -117, dist: 300, cap: 35, tier: 'medium',   targetRevisitMs: 500000, lastPolledAt: 0 },
    { label: 'EU_EAST',    lat:  50, lon:   28, dist: 320, cap: 35, tier: 'medium',   targetRevisitMs: 500000, lastPolledAt: 0 },
    { label: 'EU_SOUTH',   lat:  40, lon:   15, dist: 360, cap: 35, tier: 'medium',   targetRevisitMs: 500000, lastPolledAt: 0 },
    { label: 'EU_IBERIA',  lat:  40, lon:   -4, dist: 310, cap: 35, tier: 'medium',   targetRevisitMs: 500000, lastPolledAt: 0 },
    { label: 'ME_GULF',    lat:  25, lon:   55, dist: 340, cap: 35, tier: 'medium',   targetRevisitMs: 500000, lastPolledAt: 0 },
    { label: 'ME_TURKEY',  lat:  39, lon:   35, dist: 340, cap: 30, tier: 'medium',   targetRevisitMs: 500000, lastPolledAt: 0 },
    { label: 'AS_INDIA_N', lat:  28, lon:   77, dist: 350, cap: 35, tier: 'medium',   targetRevisitMs: 500000, lastPolledAt: 0 },
    { label: 'AS_INDIA_S', lat:  13, lon:   80, dist: 340, cap: 30, tier: 'medium',   targetRevisitMs: 500000, lastPolledAt: 0 },
    { label: 'AS_SE',      lat:  13, lon:  103, dist: 390, cap: 35, tier: 'medium',   targetRevisitMs: 500000, lastPolledAt: 0 },
    { label: 'RU_WEST',    lat:  55, lon:   37, dist: 390, cap: 30, tier: 'medium',   targetRevisitMs: 500000, lastPolledAt: 0 },
    { label: 'OC_AUS_E',   lat: -33, lon:  150, dist: 390, cap: 30, tier: 'medium',   targetRevisitMs: 500000, lastPolledAt: 0 },
    // ── Sparse (19 tiles) — targetRevisit=300s, cap=20 ───────────────────────
    // Short targetRevisitMs means these tiles accumulate overdue score faster
    // and are selected by the scheduler more frequently per unit time. Geographic
    // representativeness of rarely-queried airspace depends on this.
    { label: 'ARCTIC_ATL', lat:  72, lon:  -20, dist: 600, cap: 20, tier: 'sparse',   targetRevisitMs: 300000, lastPolledAt: 0 },
    { label: 'ARCTIC_PAC', lat:  72, lon:  160, dist: 600, cap: 20, tier: 'sparse',   targetRevisitMs: 300000, lastPolledAt: 0 },
    { label: 'NA_PLAINS',  lat:  40, lon:  -98, dist: 370, cap: 20, tier: 'sparse',   targetRevisitMs: 300000, lastPolledAt: 0 },
    { label: 'NA_CANADA',  lat:  51, lon:  -95, dist: 440, cap: 20, tier: 'sparse',   targetRevisitMs: 300000, lastPolledAt: 0 },
    { label: 'NATL_W',     lat:  47, lon:  -40, dist: 600, cap: 20, tier: 'sparse',   targetRevisitMs: 300000, lastPolledAt: 0 },
    { label: 'NATL_E',     lat:  52, lon:  -20, dist: 490, cap: 20, tier: 'sparse',   targetRevisitMs: 300000, lastPolledAt: 0 },
    { label: 'EU_NORDIC',  lat:  62, lon:   15, dist: 340, cap: 20, tier: 'sparse',   targetRevisitMs: 300000, lastPolledAt: 0 },
    { label: 'AS_CHINA_W', lat:  35, lon:  104, dist: 410, cap: 20, tier: 'sparse',   targetRevisitMs: 300000, lastPolledAt: 0 },
    { label: 'AS_MALAY',   lat:   0, lon:  110, dist: 440, cap: 20, tier: 'sparse',   targetRevisitMs: 300000, lastPolledAt: 0 },
    { label: 'RU_EAST',    lat:  55, lon:   83, dist: 490, cap: 20, tier: 'sparse',   targetRevisitMs: 300000, lastPolledAt: 0 },
    { label: 'AF_NORTH',   lat:  25, lon:   15, dist: 540, cap: 20, tier: 'sparse',   targetRevisitMs: 300000, lastPolledAt: 0 },
    { label: 'AF_WEST',    lat:  10, lon:    0, dist: 490, cap: 20, tier: 'sparse',   targetRevisitMs: 300000, lastPolledAt: 0 },
    { label: 'AF_EAST',    lat:   0, lon:   38, dist: 490, cap: 20, tier: 'sparse',   targetRevisitMs: 300000, lastPolledAt: 0 },
    { label: 'AF_SOUTH',   lat: -25, lon:   28, dist: 440, cap: 20, tier: 'sparse',   targetRevisitMs: 300000, lastPolledAt: 0 },
    { label: 'SA_NORTH',   lat:   5, lon:  -72, dist: 440, cap: 20, tier: 'sparse',   targetRevisitMs: 300000, lastPolledAt: 0 },
    { label: 'SA_BRAZIL',  lat: -10, lon:  -50, dist: 490, cap: 20, tier: 'sparse',   targetRevisitMs: 300000, lastPolledAt: 0 },
    { label: 'SA_SOUTH',   lat: -34, lon:  -64, dist: 440, cap: 20, tier: 'sparse',   targetRevisitMs: 300000, lastPolledAt: 0 },
    { label: 'OC_AUS_W',   lat: -25, lon:  122, dist: 490, cap: 20, tier: 'sparse',   targetRevisitMs: 300000, lastPolledAt: 0 },
    { label: 'OC_NZ',      lat: -43, lon:  172, dist: 340, cap: 20, tier: 'sparse',   targetRevisitMs: 300000, lastPolledAt: 0 },
    // ── Maritime / polar corridors (5 tiles) — targetRevisit=400s, cap=15 ─────
    // Wide dist sweeps full corridor width. Traffic is rare but globally important.
    { label: 'MAR_NATL',   lat:  38, lon:  -45, dist: 650, cap: 15, tier: 'maritime', targetRevisitMs: 400000, lastPolledAt: 0 },
    { label: 'MAR_SATL',   lat: -15, lon:  -25, dist: 650, cap: 15, tier: 'maritime', targetRevisitMs: 400000, lastPolledAt: 0 },
    { label: 'MAR_IND',    lat: -10, lon:   72, dist: 650, cap: 15, tier: 'maritime', targetRevisitMs: 400000, lastPolledAt: 0 },
    { label: 'MAR_NPAC',   lat:  35, lon:  175, dist: 700, cap: 15, tier: 'maritime', targetRevisitMs: 400000, lastPolledAt: 0 },
    { label: 'MAR_SPAC',   lat: -30, lon: -140, dist: 740, cap: 15, tier: 'maritime', targetRevisitMs: 400000, lastPolledAt: 0 },
  ];

  // ── Live aircraft cache ───────────────────────────────────────────────────────
  var aircraftLiveCache = new Map(); // icao24 → normalized Argus record

  // ── Audit ─────────────────────────────────────────────────────────────────────
  var _audit = {
    polls:          0,
    injected:       0,
    skipped:        0,
    expired:        0,
    lastPollMs:     0,
    lastError:      null,
    ticks:          0,
    tickLastTile:   '',
    tickLastCount:  0,
    tickLastMs:     0,
    tickLastScore:  0,
  };

  // ── State ─────────────────────────────────────────────────────────────────────
  var _suppTimer  = null;
  var _suppActive = false;
  var _tickTimer  = null;
  var _enabled    = true;

  // ── Primary-absent check ──────────────────────────────────────────────────────
  function _isPrimaryAbsent(icao24) {
    var primary = window._argusCurrentIcao24s;
    if (!primary || !primary.size) return true;
    return !primary.has(icao24);
  }

  // ── Viewport center ───────────────────────────────────────────────────────────
  function _getViewportCenter() {
    var ag = window.ArgusGlobe;
    if (!ag || !ag.globeGroup) return null;
    var rx  = ag.globeGroup.rotation.x;
    var ry  = ag.globeGroup.rotation.y;
    var lx  = -Math.sin(ry) * Math.cos(rx);
    var ly  =  Math.sin(rx);
    var lz  =  Math.cos(ry) * Math.cos(rx);
    var phi = Math.acos(Math.max(-1, Math.min(1, ly)));
    var lat = 90 - phi * 180 / Math.PI;
    var lon = 0;
    if (Math.abs(Math.sin(phi)) > 1e-6) {
      lon = Math.atan2(lz, -lx) * 180 / Math.PI - 180;
      if (lon < -180) lon += 360;
      if (lon >  180) lon -= 360;
    }
    return { lat: lat, lon: lon };
  }

  // ── adsb.fi schema normalizer ─────────────────────────────────────────────────
  function _normalizeAdsbFi(ac) {
    var altFt = ac.alt_baro;
    var alt   = typeof altFt === 'number' ? altFt : 0;
    var gs    = ac.gs       || 0;
    var br    = ac.baro_rate;
    var phase = 'airborne';
    if (altFt === 'ground' || (alt < 500 && gs < 50)) {
      phase = 'ground';
    } else if (typeof br === 'number') {
      if      (br >  300) phase = 'climb';
      else if (br < -300) phase = 'descent';
    }
    return {
      icao24:     ac.hex,
      cs:         ac.flight ? ac.flight.trim() : '',
      lat:        ac.lat,
      lon:        ac.lon,
      alt:        alt,
      gs:         gs,
      track:      ac.track  || 0,
      phase:      phase,
      flightType: 'unknown',
    };
  }

  // ── Fisher-Yates shuffle (non-mutating) ──────────────────────────────────────
  function _shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // ── Within-tile anti-clustering sampler ──────────────────────────────────────
  // Groups raw API results by 1° grid cells before applying the tile's cap.
  // Per-cell slot allocation: floor(cap / cellCount), clamped to [2, 8].
  // Cells are shuffled before sampling to remove positional API bias.
  // Prevents a single busy airport from filling an entire tile's quota.
  function _sampleTileAircraft(rawAc, tileCap) {
    var cells = {};
    var i, ac, key, k, bucket, take;
    for (i = 0; i < rawAc.length; i++) {
      ac = rawAc[i];
      if (!ac || ac.lat == null || ac.lon == null) continue;
      key = Math.floor(ac.lat) + ':' + Math.floor(ac.lon);
      if (!cells[key]) cells[key] = [];
      cells[key].push(ac);
    }
    var keys = Object.keys(cells);
    if (!keys.length) return [];

    // Slots per 1° cell — sparse cells still get a minimum of 2
    var perCell = Math.max(2, Math.min(8, Math.floor(tileCap / keys.length)));
    var out = [];
    for (k = 0; k < keys.length; k++) {
      bucket = _shuffle(cells[keys[k]]);
      take   = Math.min(perCell, bucket.length);
      for (i = 0; i < take; i++) out.push(bucket[i]);
    }

    // Hard trim if per-cell allocation still exceeds cap (many 2-aircraft cells)
    if (out.length > tileCap) {
      out = _shuffle(out).slice(0, tileCap);
    }
    return out;
  }

  // ── Adaptive priority tile picker ─────────────────────────────────────────────
  // Evaluates all tiles and returns the one with the highest overdue score.
  // Score = (nowMs - lastPolledAt) / targetRevisitMs.
  // Never-polled tiles (lastPolledAt = 0) score Infinity and are always first.
  // Tiles with shorter targetRevisitMs (sparse/maritime) accumulate score faster
  // and win more ticks than dense tiles — this is the proportional-coverage
  // mechanism. No tile can starve: score grows monotonically between polls.
  function _pickNextTile() {
    var now       = Date.now();
    var best      = null;
    var bestScore = -Infinity;
    var score, age, tile, i;
    for (i = 0; i < GLOBAL_TILES.length; i++) {
      tile  = GLOBAL_TILES[i];
      age   = tile.lastPolledAt === 0 ? Infinity : (now - tile.lastPolledAt);
      score = age === Infinity ? Infinity : age / tile.targetRevisitMs;
      if (score > bestScore) {
        bestScore = score;
        best      = tile;
      }
    }
    return { tile: best, score: bestScore };
  }

  // ── adsb.fi tile fetch ────────────────────────────────────────────────────────
  function _fetchAdsbFiRegion(region) {
    var url = '/adsb/api/v2/lat/' + region.lat + '/lon/' + region.lon + '/dist/' + region.dist;
    return fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (resp) {
        var ct = resp.headers.get('content-type') || '';
        if (!ct.includes('application/json') || !resp.ok) return [];
        return resp.json().then(function (d) {
          return Array.isArray(d.aircraft) ? d.aircraft : [];
        });
      })
      .catch(function () { return []; });
  }

  // ── Per-tile ingestion ────────────────────────────────────────────────────────
  // Source key 'adsb-fi:<tileLabel>' scopes all eviction to that tile only.
  // No other tile or adsb.lol entries are touched during a tile refresh.
  function _ingestRegion(aircraft, tileLabel) {
    if (!Array.isArray(aircraft) || !aircraft.length) return;
    var nowMs  = Date.now();
    var srcKey = 'adsb-fi:' + tileLabel;

    var incomingIds = new Set();
    var toInsert    = [];
    aircraft.forEach(function (ac) {
      if (!ac || !ac.icao24) return;
      if (!_isPrimaryAbsent(ac.icao24)) { _audit.skipped++; return; }
      incomingIds.add(ac.icao24);
      toInsert.push(ac);
    });

    // Evict same-tile entries absent from this batch or globally stale
    aircraftLiveCache.forEach(function (entry, id) {
      if (entry._source !== srcKey) return;
      var tooOld = (entry._cachedAt != null) && (nowMs - entry._cachedAt) > STALE_MS;
      if (!incomingIds.has(id) || tooOld) {
        aircraftLiveCache.delete(id);
        _audit.expired++;
      }
    });

    // Upsert within overall cap
    var created = 0;
    var updated = 0;
    toInsert.forEach(function (ac) {
      var exists = aircraftLiveCache.has(ac.icao24);
      if (!exists && aircraftLiveCache.size >= MAX_INJECT) return;
      ac._cachedAt = nowMs;
      ac._source   = srcKey;
      aircraftLiveCache.set(ac.icao24, ac);
      if (exists) { updated++; } else { created++; }
    });

    _audit.injected  += created + updated;
    _audit.tickLastMs = nowMs;
    console.log('[adsb.fi tick]', tileLabel,
      '| in:', toInsert.length,
      '| created:', created, '| updated:', updated,
      '| cacheTotal:', aircraftLiveCache.size);
  }

  // ── Coverage heatmap ──────────────────────────────────────────────────────────
  // Groups aircraftLiveCache entries by geographic zone and logs counts.
  // Called after each full sweep of all 47 tiles (every TOTAL_TILES × TICK_MS ≈ 470 s).
  // Also callable manually: ArgusProviderCache.logHeatmap()
  var _TILE_ZONES = {
    'North America':  ['NA_NE','NA_MID','NA_SE','NA_FL','NA_MIDWEST','NA_NW','NA_SW','NA_PLAINS','NA_CANADA'],
    'Europe':         ['EU_UK','EU_WEST','EU_CENTRAL','EU_EAST','EU_SOUTH','EU_IBERIA','EU_NORDIC'],
    'Middle East':    ['ME_GULF','ME_TURKEY'],
    'South Asia':     ['AS_INDIA_N','AS_INDIA_S','AS_SE'],
    'East Asia':      ['AS_JAPAN','AS_KOREA','AS_CHINA_E','AS_CHINA_W'],
    'Southeast Asia': ['AS_MALAY'],
    'Russia':         ['RU_WEST','RU_EAST'],
    'Africa':         ['AF_NORTH','AF_WEST','AF_EAST','AF_SOUTH'],
    'South America':  ['SA_NORTH','SA_BRAZIL','SA_SOUTH'],
    'Oceania':        ['OC_AUS_E','OC_AUS_W','OC_NZ'],
    'Arctic':         ['ARCTIC_ATL','ARCTIC_PAC'],
    'N. Atlantic':    ['NATL_W','NATL_E','MAR_NATL'],
    'S. Atlantic':    ['MAR_SATL'],
    'Indian Ocean':   ['MAR_IND'],
    'Pacific':        ['MAR_NPAC','MAR_SPAC'],
  };

  function _logCoverageHeatmap() {
    // Build label → zone lookup
    var labelToZone = {};
    Object.keys(_TILE_ZONES).forEach(function (zone) {
      _TILE_ZONES[zone].forEach(function (label) { labelToZone[label] = zone; });
    });

    var zoneCounts = {};
    aircraftLiveCache.forEach(function (ac) {
      var src   = ac._source || '';                   // 'adsb-fi:<label>' or 'supplemental'
      var label = src.indexOf('adsb-fi:') === 0 ? src.slice(8) : 'supplemental';
      var zone  = labelToZone[label] || 'Other';
      zoneCounts[zone] = (zoneCounts[zone] || 0) + 1;
    });

    var rows = Object.keys(zoneCounts).map(function (z) { return [z, zoneCounts[z]]; });
    rows.sort(function (a, b) { return b[1] - a[1]; });

    console.group('[ArgusProviderCache] Coverage heatmap — supplemental layer (' + aircraftLiveCache.size + ' aircraft)');
    rows.forEach(function (row) {
      var bar = '';
      for (var i = 0; i < Math.min(20, Math.round(row[1] / 3)); i++) bar += '█';
      console.log('  ' + row[0].padEnd(16) + ' ' + String(row[1]).padStart(4) + '  ' + bar);
    });
    console.groupEnd();
  }

  // ── adsb.fi adaptive tick ─────────────────────────────────────────────────────
  // Picks the most-overdue tile, marks it as polled immediately (prevents
  // double-pick during async fetch), fetches, applies within-tile sampling,
  // normalizes, then ingests.
  function _tickAdsbFi() {
    if (!_enabled) return;

    var picked = _pickNextTile();
    var tile   = picked.tile;
    if (!tile) return;

    tile.lastPolledAt    = Date.now();
    _audit.ticks++;
    _audit.tickLastTile  = tile.label;
    _audit.tickLastScore = picked.score;

    _fetchAdsbFiRegion(tile).then(function (rawAc) {
      if (!rawAc.length) return;
      var sampled    = _sampleTileAircraft(rawAc, tile.cap);
      var normalized = sampled
        .filter(function (ac) { return ac && ac.hex && ac.lat != null && ac.lon != null; })
        .map(_normalizeAdsbFi);
      _audit.tickLastCount = normalized.length;
      _ingestRegion(normalized, tile.label);

      // Log coverage heatmap after every full sweep (every 47 ticks)
      if (_audit.ticks % GLOBAL_TILES.length === 0) _logCoverageHeatmap();
    });
  }

  // ── adsb.lol supplemental poll ────────────────────────────────────────────────
  function _ingestAircraftArray(aircraft, sourceTag) {
    if (!Array.isArray(aircraft)) return;
    var nowMs       = Date.now();
    var sizeAtStart = aircraftLiveCache.size;

    if (aircraftLiveCache.size > MAX_INJECT * 2) {
      console.warn('[ArgusProviderCache] Cache inflated to', aircraftLiveCache.size, '— clearing.');
      aircraftLiveCache.clear();
    }

    var incomingIds = new Set();
    var incoming    = [];
    for (var i = 0; i < aircraft.length; i++) {
      if (incoming.length >= MAX_INJECT) break;
      var ac = aircraft[i];
      if (!ac || !ac.icao24 || ac.lat == null || ac.lon == null) continue;
      if (incomingIds.has(ac.icao24)) continue;
      if (!_isPrimaryAbsent(ac.icao24)) { _audit.skipped++; continue; }
      incomingIds.add(ac.icao24);
      incoming.push(ac);
    }

    var expired = 0;
    aircraftLiveCache.forEach(function (entry, id) {
      var tooOld     = (entry._cachedAt != null) && (nowMs - entry._cachedAt) > STALE_MS;
      var sameSource = (entry._source === sourceTag);
      if (tooOld || (sameSource && !incomingIds.has(id))) {
        aircraftLiveCache.delete(id);
        expired++;
      }
    });

    var created = 0;
    var updated = 0;
    for (var j = 0; j < incoming.length; j++) {
      var entry  = incoming[j];
      var exists = aircraftLiveCache.has(entry.icao24);
      entry._cachedAt = nowMs;
      entry._source   = sourceTag;
      aircraftLiveCache.set(entry.icao24, entry);
      if (exists) { updated++; } else { created++; }
    }

    if (aircraftLiveCache.size > MAX_INJECT) {
      var iter = aircraftLiveCache.keys();
      var trim = aircraftLiveCache.size - MAX_INJECT;
      for (var k = 0; k < trim; k++) aircraftLiveCache.delete(iter.next().value);
      console.warn('[ArgusProviderCache] HARD CAP — trimmed', trim);
    }

    var delta = aircraftLiveCache.size - sizeAtStart;
    console.log('[Supplemental Cycle] adsb.lol',
      '| created:', created, '| updated:', updated,
      '| expired:', expired, '| cacheSize:', aircraftLiveCache.size,
      '| delta:', (delta >= 0 ? '+' : '') + delta);

    _audit.injected  += created + updated;
    _audit.expired   += expired;
    _audit.lastPollMs = nowMs;
    _audit.lastError  = null;
  }

  function _pollSupplemental() {
    if (!_enabled || _suppActive) return;
    if (!window._argusReqCache) return;
    _suppActive = true;
    _audit.polls++;

    var center = _getViewportCenter();
    var lat    = center ? center.lat.toFixed(2) : '0';
    var lon    = center ? center.lon.toFixed(2) : '0';
    var url    = SUPPLEMENTAL_FN + '?lat=' + lat + '&lon=' + lon + '&dist=' + ADSB_DIST_NM;

    window._argusReqCache.fetch(url)
      .then(function (json) {
        _suppActive = false;
        if (!json || !Array.isArray(json.aircraft)) return;
        console.log('[ArgusProviderCache] adsb.lol raw:', json.aircraft.length);
        _ingestAircraftArray(json.aircraft, 'supplemental');
      })
      .catch(function (err) {
        _suppActive      = false;
        _audit.lastError = err && err.message ? err.message : String(err);
      });
  }

  // ── Publish globals ───────────────────────────────────────────────────────────
  window._argusProviderAircraft = aircraftLiveCache;
  window._argusCurrentIcao24s   = new Set();
  window.aircraftLiveCache      = aircraftLiveCache;

  // ── Lifecycle ─────────────────────────────────────────────────────────────────
  function start() {
    if (_suppTimer) return;

    // adsb.lol: 20 s then every 5 min
    setTimeout(_pollSupplemental, 20 * 1000);
    _suppTimer = setInterval(_pollSupplemental, SUPPLEMENTAL_POLL);

    // adsb.fi: 25 s then adaptive tick every 10 s.
    // All lastPolledAt values start at 0 → score Infinity → first 47 ticks cover
    // every tile once in insertion order (470 s). After that the priority scheduler
    // takes over, naturally polling sparse/maritime tiles more frequently.
    setTimeout(function () {
      _tickAdsbFi();
      _tickTimer = setInterval(_tickAdsbFi, TICK_MS);
    }, TICK_INIT_DELAY);

    var denseTiles    = GLOBAL_TILES.filter(function (t) { return t.tier === 'dense';    }).length;
    var mediumTiles   = GLOBAL_TILES.filter(function (t) { return t.tier === 'medium';   }).length;
    var sparseTiles   = GLOBAL_TILES.filter(function (t) { return t.tier === 'sparse';   }).length;
    var maritimeTiles = GLOBAL_TILES.filter(function (t) { return t.tier === 'maritime'; }).length;

    console.log('[ArgusProviderCache] started',
      '— adsb.lol every', Math.round(SUPPLEMENTAL_POLL / 60000), 'min',
      '— adsb.fi adaptive tick every', TICK_MS / 1000, 's',
      '— tiles: dense=' + denseTiles,
      'medium=' + mediumTiles,
      'sparse=' + sparseTiles,
      'maritime=' + maritimeTiles,
      'total=' + GLOBAL_TILES.length,
      '— initial full-coverage sweep:', Math.round(GLOBAL_TILES.length * TICK_MS / 1000), 's');
  }

  function stop() {
    if (_suppTimer)  { clearInterval(_suppTimer);  _suppTimer  = null; }
    if (_tickTimer)  { clearInterval(_tickTimer);  _tickTimer  = null; }
    aircraftLiveCache.clear();
    _enabled = false;
  }

  function status() {
    var now = Date.now();
    var tileStatus = GLOBAL_TILES.map(function (t) {
      var age = t.lastPolledAt === 0 ? null : Math.round((now - t.lastPolledAt) / 1000);
      return {
        label:         t.label,
        tier:          t.tier,
        lastPolledAgo: age,
        overdue:       age !== null ? age > t.targetRevisitMs / 1000 : true,
      };
    });
    return {
      enabled:        _enabled,
      mode:           'adsb.lol + adsb.fi adaptive priority scheduler',
      cacheSize:      aircraftLiveCache.size,
      polls:          _audit.polls,
      injected:       _audit.injected,
      skipped:        _audit.skipped,
      expired:        _audit.expired,
      lastPollMs:     _audit.lastPollMs,
      lastError:      _audit.lastError,
      inFlight:       _suppActive,
      ticks:          _audit.ticks,
      tickLastTile:   _audit.tickLastTile,
      tickLastCount:  _audit.tickLastCount,
      tickLastMs:     _audit.tickLastMs,
      tickLastScore:  _audit.tickLastScore,
      tiles:          tileStatus,
    };
  }

  window.ArgusProviderCache = { start: start, stop: stop, status: status, logHeatmap: _logCoverageHeatmap };

  // ── Auto-start ────────────────────────────────────────────────────────────────
  setTimeout(function () {
    if (window._argusReqCache) {
      start();
    } else {
      setTimeout(function () { if (window._argusReqCache) start(); }, 3000);
    }
  }, 0);

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusProviderCache');

}());
