'use strict';
// core/providers/argusProviderCache.js
// Supplemental aircraft ingestion — two sources, one shared cache.
//
// Source A — adsb.lol via /.netlify/functions/fetch-supplemental (viewport-centered, 5 min)
// Source B — adsb.fi  via /adsb/* Netlify proxy redirect (16 global regions, 120 s)
//
// Architecture:
//   PURELY ADDITIVE. Injects aircraft absent from the primary fetch-traffic snapshot.
//   Never alters, overrides, or replaces primary data.
//
// Source isolation:
//   Each entry is tagged _source = 'supplemental' | 'adsb-fi'.
//   Stale eviction only removes same-source entries absent from the current incoming
//   batch — cross-source entries are untouched unless they exceed STALE_MS globally.
//
// Cache:
//   aircraftLiveCache  Map<icao24, normalizedRecord>  mutated in place each cycle.
//   renderAircraft() holds a live reference — zero allocation on cache hit.
//
// Dependencies:
//   window._argusReqCache   — deduped fetch (adsb.lol path only)
//   window.ArgusGlobe       — globe rotation for viewport center derivation
//   window.ArgusModuleAudit — optional

(function () {
  'use strict';

  // ── Config ────────────────────────────────────────────────────────────────────
  var SUPPLEMENTAL_FN   = '/.netlify/functions/fetch-supplemental';
  var SUPPLEMENTAL_POLL = 5 * 60 * 1000;   // 5 min — adsb.lol viewport poll
  var ADSB_FI_POLL      = 180 * 1000;      // 3 min — adsb.fi global poll
  var ADSB_FI_STAGGER   = 5000;            // 5 s between region fetches — 16 centers = 75s spread, ~5 req/min avg
  var ADSB_FI_DIST      = 249;             // nm radius per region (adsb.fi max = 249)
  var ADSB_DIST_NM      = 250;             // viewport radius (NM) — adsb.lol max
  var MAX_INJECT        = 500;             // combined cache ceiling (raised from 250)
  var STALE_MS          = SUPPLEMENTAL_POLL * 3; // 15 min — global stale threshold

  // ── adsb.fi regional centers ──────────────────────────────────────────────────
  var ADSB_FI_CENTERS = [
    { label: 'US East',        lat:  40, lon:  -75 },
    { label: 'US Central',     lat:  37, lon: -100 },
    { label: 'Europe',         lat:  50, lon:   10 },
    { label: 'Middle East',    lat:  25, lon:   55 },
    { label: 'East Asia',      lat:  35, lon:  125 },
    { label: 'Japan East',     lat:  40, lon:  142 },
    { label: 'South US',       lat:  30, lon:  -85 },
    { label: 'Northwest US',   lat:  47, lon: -122 },
    { label: 'SE Asia',        lat:  15, lon:  100 },
    { label: 'India',          lat:  20, lon:   80 },
    { label: 'Australia SE',   lat: -34, lon:  151 },
    { label: 'Brazil',         lat: -23, lon:  -46 },
    { label: 'Moscow',         lat:  55, lon:   37 },
    { label: 'Caribbean',      lat:  20, lon:  -72 },
    { label: 'Southern Africa',lat: -26, lon:   28 },
    { label: 'East Africa',    lat:   0, lon:   37 },
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
    adsbFiPolls:    0,
    adsbFiLastRaw:  0,
    adsbFiLastMs:   0,
  };

  // ── State ─────────────────────────────────────────────────────────────────────
  var _suppTimer    = null;
  var _suppActive   = false;
  var _adsbFiTimer  = null;
  var _adsbFiActive = false;
  var _enabled      = true;

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
  // Converts raw adsb.fi aircraft record → Argus schema expected by renderAircraft().
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
      track:      ac.track || 0,
      phase:      phase,
      flightType: 'unknown',
    };
  }

  // ── Ingestion core ────────────────────────────────────────────────────────────
  // sourceTag: 'supplemental' | 'adsb-fi'
  // Stale eviction is source-isolated — a poll from one source never evicts
  // valid entries contributed by the other source.
  function _ingestAircraftArray(aircraft, sourceTag) {
    if (!Array.isArray(aircraft)) return;
    var nowMs       = Date.now();
    var sizeAtStart = aircraftLiveCache.size;

    // ── Emergency guard ──────────────────────────────────────────────────────
    if (aircraftLiveCache.size > MAX_INJECT * 2) {
      console.warn('[ArgusProviderCache] Cache inflated to', aircraftLiveCache.size,
        '— clearing.');
      aircraftLiveCache.clear();
    }

    // ── Step 1: Build capped, deduplicated incoming set ──────────────────────
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

    // ── Step 2: Source-isolated stale eviction ───────────────────────────────
    // Same-source entries absent from this batch are evicted immediately.
    // Cross-source entries are only evicted if they exceed STALE_MS globally.
    var expired = 0;
    aircraftLiveCache.forEach(function (entry, id) {
      var tooOld     = (entry._cachedAt != null) && (nowMs - entry._cachedAt) > STALE_MS;
      var sameSource = (entry._source === sourceTag);
      if (tooOld || (sameSource && !incomingIds.has(id))) {
        aircraftLiveCache.delete(id);
        expired++;
      }
    });

    // ── Step 3: Diff upsert ──────────────────────────────────────────────────
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

    // ── Step 4: Hard cap ─────────────────────────────────────────────────────
    if (aircraftLiveCache.size > MAX_INJECT) {
      var iter = aircraftLiveCache.keys();
      var trim = aircraftLiveCache.size - MAX_INJECT;
      for (var k = 0; k < trim; k++) aircraftLiveCache.delete(iter.next().value);
      console.warn('[ArgusProviderCache] HARD CAP — trimmed', trim, 'entries.');
    }

    // ── Step 5: Cycle diagnostic ─────────────────────────────────────────────
    var delta = aircraftLiveCache.size - sizeAtStart;
    console.log(
      '[Supplemental Cycle]', sourceTag,
      '| created:', created,
      '| updated:', updated,
      '| expired:', expired,
      '| cacheSize:', aircraftLiveCache.size,
      '| delta:', (delta >= 0 ? '+' : '') + delta
    );

    _audit.injected  += created + updated;
    _audit.expired   += expired;
    _audit.lastPollMs = nowMs;
    _audit.lastError  = null;
  }

  // ── adsb.lol supplemental poll ────────────────────────────────────────────────
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
        console.log('[ArgusProviderCache] adsb.lol raw:', json.aircraft.length, 'aircraft');
        _ingestAircraftArray(json.aircraft, 'supplemental');
      })
      .catch(function (err) {
        _suppActive      = false;
        _audit.lastError = err && err.message ? err.message : String(err);
      });
  }

  // ── adsb.fi region fetch ──────────────────────────────────────────────────────
  function _fetchAdsbFiRegion(center) {
    var url = '/adsb/api/v2/lat/' + center.lat + '/lon/' + center.lon + '/dist/' + ADSB_FI_DIST;
    return fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (resp) {
        var ct = resp.headers.get('content-type') || '';
        if (!ct.includes('application/json')) return [];
        if (!resp.ok) return [];
        return resp.json().then(function (d) {
          return Array.isArray(d.aircraft) ? d.aircraft : [];
        });
      })
      .catch(function () { return []; });
  }

  // ── adsb.fi global poll ───────────────────────────────────────────────────────
  // Fetches all 16 centers with ADSB_FI_STAGGER ms between each to avoid
  // bursting adsb.fi's rate limit. Deduplicates by hex before ingestion.
  function _pollAdsbFi() {
    if (!_enabled || _adsbFiActive) return;
    _adsbFiActive = true;
    _audit.adsbFiPolls++;

    var staggered = ADSB_FI_CENTERS.map(function (center, i) {
      return new Promise(function (resolve) {
        setTimeout(function () {
          _fetchAdsbFiRegion(center).then(resolve).catch(function () { resolve([]); });
        }, i * ADSB_FI_STAGGER);
      });
    });

    Promise.allSettled(staggered).then(function (results) {
      var seen     = {};
      var aircraft = [];
      results.forEach(function (r) {
        if (r.status !== 'fulfilled') return;
        r.value.forEach(function (ac) {
          if (!ac || !ac.hex || ac.lat == null || ac.lon == null) return;
          if (seen[ac.hex]) return;
          seen[ac.hex] = true;
          aircraft.push(_normalizeAdsbFi(ac));
        });
      });

      _audit.adsbFiLastRaw = aircraft.length;
      _audit.adsbFiLastMs  = Date.now();
      console.log('[ArgusProviderCache] adsb.fi raw:', aircraft.length, 'unique aircraft');
      _ingestAircraftArray(aircraft, 'adsb-fi');
      _adsbFiActive = false;
    });
  }

  // ── Publish globals ───────────────────────────────────────────────────────────
  window._argusProviderAircraft = aircraftLiveCache;
  window._argusCurrentIcao24s   = new Set();
  window.aircraftLiveCache      = aircraftLiveCache;

  // ── Lifecycle ─────────────────────────────────────────────────────────────────
  function start() {
    if (_suppTimer) return;

    // adsb.lol: 20s delay then every 5 min
    setTimeout(_pollSupplemental, 20 * 1000);
    _suppTimer = setInterval(_pollSupplemental, SUPPLEMENTAL_POLL);

    // adsb.fi: 25s delay then every 120s
    // (offset from adsb.lol by 5s so they don't fire simultaneously)
    setTimeout(_pollAdsbFi, 25 * 1000);
    _adsbFiTimer = setInterval(_pollAdsbFi, ADSB_FI_POLL);

    console.log('[ArgusProviderCache] started',
      '— adsb.lol every', Math.round(SUPPLEMENTAL_POLL / 60000), 'min',
      '— adsb.fi every', Math.round(ADSB_FI_POLL / 1000), 's across',
      ADSB_FI_CENTERS.length, 'regions');
  }

  function stop() {
    if (_suppTimer)   { clearInterval(_suppTimer);   _suppTimer   = null; }
    if (_adsbFiTimer) { clearInterval(_adsbFiTimer); _adsbFiTimer = null; }
    aircraftLiveCache.clear();
    _enabled = false;
  }

  function status() {
    return {
      enabled:         _enabled,
      mode:            'netlify-supplemental + adsb-fi',
      cacheSize:       aircraftLiveCache.size,
      polls:           _audit.polls,
      injected:        _audit.injected,
      skipped:         _audit.skipped,
      expired:         _audit.expired,
      lastPollMs:      _audit.lastPollMs,
      lastError:       _audit.lastError,
      inFlight:        _suppActive,
      adsbFiPolls:     _audit.adsbFiPolls,
      adsbFiLastRaw:   _audit.adsbFiLastRaw,
      adsbFiLastMs:    _audit.adsbFiLastMs,
      adsbFiInFlight:  _adsbFiActive,
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
