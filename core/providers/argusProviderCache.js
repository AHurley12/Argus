'use strict';
// core/providers/argusProviderCache.js
// Supplemental aircraft ingestion — two sources, one shared cache.
//
// ── Source A: adsb.lol ────────────────────────────────────────────────────────
//   /.netlify/functions/fetch-supplemental — viewport-centered, every 5 min.
//
// ── Source B: adsb.fi ─────────────────────────────────────────────────────────
//   /adsb/* Netlify proxy redirect — tick-based rotating regional scheduler.
//
//   Architecture: time-division multiplexing.
//   One region is polled per TICK_MS (10 s). The region queue rotates through all
//   ADSB_FI_REGIONS in sequence. Full global cycle = 16 regions × 10 s = 160 s.
//   Rate: exactly 6 req/min — structurally burst-proof by design.
//
//   Each region has a density tier that determines:
//     dist  — query radius in nm (smaller in dense regions → fewer aircraft)
//     cap   — max aircraft accepted from that region per poll
//   This prevents high-density regions (Europe, CONUS) from monopolizing
//   the cache while sparse regions (Africa, Oceania) still get representation.
//
// ── Source isolation ──────────────────────────────────────────────────────────
//   adsb.lol entries: _source = 'supplemental'
//   adsb.fi entries:  _source = 'adsb-fi:<regionLabel>'
//   Stale eviction is per-source — a region refresh never touches entries from
//   other regions or from adsb.lol.
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
  var TICK_MS           = 10 * 1000;      // 10 s between adsb.fi region polls — 6 req/min steady state
  var TICK_INIT_DELAY   = 25 * 1000;      // 25 s before first tick (primary pipeline settles first)
  var MAX_INJECT        = 650;            // combined cache ceiling
  var STALE_MS          = 15 * 60 * 1000; // 15 min global stale threshold

  // ── adsb.fi regional partition table ─────────────────────────────────────────
  // Three density tiers. Tier 1 (dense): small dist + hard cap prevents regional
  // monopolization. Tier 3 (sparse): full dist to capture what aircraft exist.
  // Total max per full cycle: (5×50)+(6×35)+(5×25) = 585 aircraft, geographically
  // distributed across all populated airspace zones.
  var ADSB_FI_REGIONS = [
    // ── Tier 1: Dense airspace — small radius, hard cap ──────────────────────
    { label: 'Europe',          lat:  50, lon:   10, dist: 120, cap: 50, tier: 1 },
    { label: 'US East',         lat:  40, lon:  -75, dist: 150, cap: 50, tier: 1 },
    { label: 'US Central',      lat:  37, lon: -100, dist: 150, cap: 40, tier: 1 },
    { label: 'East Asia',       lat:  35, lon:  125, dist: 150, cap: 50, tier: 1 },
    { label: 'India',           lat:  20, lon:   80, dist: 150, cap: 40, tier: 1 },
    // ── Tier 2: Medium airspace — balanced radius and cap ────────────────────
    { label: 'Japan',           lat:  36, lon:  140, dist: 200, cap: 35, tier: 2 },
    { label: 'SE Asia',         lat:  15, lon:  100, dist: 200, cap: 35, tier: 2 },
    { label: 'Middle East',     lat:  25, lon:   55, dist: 200, cap: 35, tier: 2 },
    { label: 'Northwest US',    lat:  47, lon: -122, dist: 200, cap: 35, tier: 2 },
    { label: 'South US',        lat:  30, lon:  -85, dist: 200, cap: 35, tier: 2 },
    { label: 'Moscow',          lat:  55, lon:   37, dist: 200, cap: 35, tier: 2 },
    // ── Tier 3: Sparse airspace — max radius, proportional cap ───────────────
    { label: 'Australia SE',    lat: -34, lon:  151, dist: 249, cap: 25, tier: 3 },
    { label: 'Brazil',          lat: -23, lon:  -46, dist: 249, cap: 25, tier: 3 },
    { label: 'Caribbean',       lat:  20, lon:  -72, dist: 249, cap: 25, tier: 3 },
    { label: 'Southern Africa', lat: -26, lon:   28, dist: 249, cap: 25, tier: 3 },
    { label: 'East Africa',     lat:   0, lon:   37, dist: 249, cap: 25, tier: 3 },
  ];

  // ── Live aircraft cache ───────────────────────────────────────────────────────
  var aircraftLiveCache = new Map(); // icao24 → normalized Argus record

  // ── Audit ─────────────────────────────────────────────────────────────────────
  var _audit = {
    polls:         0,
    injected:      0,
    skipped:       0,
    expired:       0,
    lastPollMs:    0,
    lastError:     null,
    ticks:         0,
    tickLastRegion: '',
    tickLastCount:  0,
    tickLastMs:     0,
  };

  // ── State ─────────────────────────────────────────────────────────────────────
  var _suppTimer  = null;
  var _suppActive = false;
  var _tickTimer  = null;
  var _regionQueue = [];
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

  // ── adsb.fi region fetch ──────────────────────────────────────────────────────
  // Uses per-region dist from the partition table.
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

  // ── Per-region ingestion ──────────────────────────────────────────────────────
  // Source key is 'adsb-fi:<regionLabel>' — eviction is fully isolated to the
  // region being refreshed. No other region or adsb.lol entries are touched.
  function _ingestRegion(aircraft, regionLabel) {
    if (!Array.isArray(aircraft) || !aircraft.length) return;
    var nowMs  = Date.now();
    var srcKey = 'adsb-fi:' + regionLabel;

    // Build filtered incoming set (primary-absent check applied here)
    var incomingIds = new Set();
    var toInsert    = [];
    aircraft.forEach(function (ac) {
      if (!ac || !ac.icao24) return;
      if (!_isPrimaryAbsent(ac.icao24)) { _audit.skipped++; return; }
      incomingIds.add(ac.icao24);
      toInsert.push(ac);
    });

    // Evict same-region entries absent from this batch or globally stale
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

    _audit.injected    += created + updated;
    _audit.tickLastMs   = nowMs;
    console.log('[adsb.fi tick]', regionLabel,
      '| in:', toInsert.length,
      '| created:', created, '| updated:', updated,
      '| cacheTotal:', aircraftLiveCache.size);
  }

  // ── adsb.fi tick scheduler ────────────────────────────────────────────────────
  // Pops one region from the rotating queue, fetches it, ingests it.
  // One region per TICK_MS = 6 req/min steady state. No burst possible.
  function _tickAdsbFi() {
    if (!_enabled) return;

    // Reload queue when exhausted — full global cycle complete
    if (_regionQueue.length === 0) {
      _regionQueue = ADSB_FI_REGIONS.slice();
    }

    var region = _regionQueue.shift();
    _audit.ticks++;
    _audit.tickLastRegion = region.label;

    _fetchAdsbFiRegion(region).then(function (rawAc) {
      if (!rawAc.length) return;
      // Apply regional density cap before normalization
      var capped = rawAc.slice(0, region.cap);
      var normalized = capped
        .filter(function (ac) { return ac && ac.hex && ac.lat != null && ac.lon != null; })
        .map(_normalizeAdsbFi);
      _audit.tickLastCount = normalized.length;
      _ingestRegion(normalized, region.label);
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

    // adsb.fi: 25 s then tick every 10 s
    // Queue primed at start. One region per tick, rotating.
    _regionQueue = ADSB_FI_REGIONS.slice();
    setTimeout(function () {
      _tickAdsbFi();
      _tickTimer = setInterval(_tickAdsbFi, TICK_MS);
    }, TICK_INIT_DELAY);

    console.log('[ArgusProviderCache] started',
      '— adsb.lol every', Math.round(SUPPLEMENTAL_POLL / 60000), 'min',
      '— adsb.fi tick every', TICK_MS / 1000, 's across',
      ADSB_FI_REGIONS.length, 'regions (', Math.round(ADSB_FI_REGIONS.length * TICK_MS / 1000), 's cycle)');
  }

  function stop() {
    if (_suppTimer)  { clearInterval(_suppTimer);  _suppTimer  = null; }
    if (_tickTimer)  { clearInterval(_tickTimer);  _tickTimer  = null; }
    aircraftLiveCache.clear();
    _enabled = false;
  }

  function status() {
    return {
      enabled:         _enabled,
      mode:            'adsb.lol + adsb.fi tick scheduler',
      cacheSize:       aircraftLiveCache.size,
      polls:           _audit.polls,
      injected:        _audit.injected,
      skipped:         _audit.skipped,
      expired:         _audit.expired,
      lastPollMs:      _audit.lastPollMs,
      lastError:       _audit.lastError,
      inFlight:        _suppActive,
      ticks:           _audit.ticks,
      tickLastRegion:  _audit.tickLastRegion,
      tickLastCount:   _audit.tickLastCount,
      tickLastMs:      _audit.tickLastMs,
      queueRemaining:  _regionQueue.length,
    };
  }

  window.ArgusProviderCache = { start: start, stop: stop, status: status };

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
