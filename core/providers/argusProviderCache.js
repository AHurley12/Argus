'use strict';
// core/providers/argusProviderCache.js
// Supplemental aircraft telemetry provider — adsb.lol via Netlify proxy.
//
// Architecture:
//   PURELY ADDITIVE. Injects aircraft absent from the primary fetch-traffic snapshot.
//   Never alters, overrides, or replaces primary data.
//
// Pipeline:
//   ArgusProviderCache.start()
//     → 20 s delay (primary renderAircraft() populates _argusCurrentIcao24s first)
//     → _pollSupplemental() every 5 min
//         → _argusReqCache.fetch(fetch-supplemental?lat=X&lon=X&dist=250)
//         → server normalizes adsb.lol → Argus schema (cs, lat, lon, alt, gs, track, phase)
//         → _ingestAircraftArray(json.aircraft)
//             → dedup against _argusCurrentIcao24s
//             → diff-upsert into aircraftLiveCache
//   renderAircraft() reads window._argusProviderAircraft (live Map reference)
//     → appends absent ICAO24s to states before placeAircraft() loop
//
// Staleness model:
//   STALE_MS = 3 × SUPPLEMENTAL_POLL (15 min). Aircraft not seen in 3 consecutive
//   polls are evicted from aircraftLiveCache by _ingestAircraftArray().
//   window._argusCurrentIcao24s (Set, populated by renderAircraft()) is checked
//   per-record — primary aircraft are never duplicated by supplemental.
//
// Cache:
//   aircraftLiveCache  Map<icao24, normalizedRecord>  mutated in place each cycle.
//   renderAircraft() holds a live reference — zero allocation on cache hit.
//
// Dependencies:
//   window._argusReqCache  — deduped fetch (coalesces concurrent calls to same URL)
//   window.ArgusGlobe      — globe rotation for viewport center derivation
//   window.ArgusModuleAudit — optional
//
// Load order: after argusAIS.js and argusTracking.js (last in body).

(function () {
  'use strict';

  // ── Config ───────────────────────────────────────────────────────────────────
  var SUPPLEMENTAL_FN   = '/.netlify/functions/fetch-supplemental';
  var SUPPLEMENTAL_POLL = 5 * 60 * 1000;  // 5 min — supplemental cadence
  var ADSB_DIST_NM      = 250;             // viewport radius (NM) — adsb.lol max
  var _pollInterval     = SUPPLEMENTAL_POLL;
  var STALE_MS          = _pollInterval * 3; // 15 min — evict after 3 missed cycles
  var MAX_INJECT        = 200;             // hard ceiling on supplemental cache size

  // ── Live aircraft cache ──────────────────────────────────────────────────────
  var aircraftLiveCache = new Map(); // icao24 → normalized Argus record

  // ── Audit ────────────────────────────────────────────────────────────────────
  var _audit = {
    polls: 0, injected: 0, skipped: 0, expired: 0, lastPollMs: 0, lastError: null,
  };

  // ── State ────────────────────────────────────────────────────────────────────
  var _supplementalTimer = null;
  var _enabled           = true;
  var _pollActive        = false; // in-flight guard

  // ── Primary-absent check ──────────────────────────────────────────────────────
  // Returns true if icao24 is not in the current primary snapshot.
  // Prevents supplemental from duplicating aircraft already rendered by fetch-traffic.
  function _isPrimaryAbsent(icao24) {
    var primary = window._argusCurrentIcao24s;
    if (!primary || !primary.size) return true; // primary not yet populated — inject conservatively
    return !primary.has(icao24);
  }

  // ── Viewport center ───────────────────────────────────────────────────────────
  // Returns { lat, lon } of the globe point currently facing the camera.
  // Math: camera at world (0,0,z). Inverse globe rotation M^-1 applied to (0,0,1):
  //   M^-1*(0,0,1) = (-sin(ry)cos(rx), sin(rx), cos(ry)cos(rx))
  // Then lat = 90 - arccos(y)*r2d; lon from atan2(z,-x)*r2d - 180.
  function _getViewportCenter() {
    var ag = window.ArgusGlobe;
    if (!ag || !ag.globeGroup) return null;
    var rx = ag.globeGroup.rotation.x;
    var ry = ag.globeGroup.rotation.y;
    var lx = -Math.sin(ry) * Math.cos(rx);
    var ly =  Math.sin(rx);
    var lz =  Math.cos(ry) * Math.cos(rx);
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

  // ── Ingestion core ────────────────────────────────────────────────────────────
  // Diff-based — never blind-clears the cache. Called each poll cycle.
  // aircraft: array of normalized Argus records from fetch-supplemental.
  function _ingestAircraftArray(aircraft) {
    if (!Array.isArray(aircraft)) return;
    var nowMs       = Date.now();
    var sizeAtStart = aircraftLiveCache.size;

    // ── Emergency guard: corrupt cache detection ─────────────────────────────
    if (aircraftLiveCache.size > MAX_INJECT * 2) {
      console.warn('[ArgusProviderCache] Cache inflated to', aircraftLiveCache.size,
        'entries — clearing. Investigate external writes to window.aircraftLiveCache.');
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

    // ── Step 2: Explicit stale expiration ────────────────────────────────────
    var expired = 0;
    aircraftLiveCache.forEach(function (entry, id) {
      var tooOld = (entry._cachedAt != null) && (nowMs - entry._cachedAt) > STALE_MS;
      if (!incomingIds.has(id) || tooOld) {
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
      '[Supplemental Cycle]',
      'created:', created,
      '| updated:', updated,
      '| expired:', expired,
      '| cacheSize:', aircraftLiveCache.size,
      '| growthDelta:', (delta >= 0 ? '+' : '') + delta
    );

    _audit.injected  += created + updated;
    _audit.expired   += expired;
    _audit.lastPollMs = nowMs;
    _audit.lastError  = null;
  }

  // ── Supplemental poll ─────────────────────────────────────────────────────────
  // Calls fetch-supplemental Netlify function with current viewport center.
  // Uses _argusReqCache for request coalescing (multiple tabs, rapid calls).
  // fetch-supplemental normalizes adsb.lol → Argus schema server-side.
  function _pollSupplemental() {
    if (!_enabled || _pollActive) return;
    if (!window._argusReqCache) return; // not yet available — will retry on next interval
    _pollActive = true;
    _audit.polls++;

    var center = _getViewportCenter();
    var lat    = center ? center.lat.toFixed(2) : '0';
    var lon    = center ? center.lon.toFixed(2) : '0';
    var url    = SUPPLEMENTAL_FN + '?lat=' + lat + '&lon=' + lon + '&dist=' + ADSB_DIST_NM;

    window._argusReqCache.fetch(url)
      .then(function (json) {
        _pollActive = false;
        if (!json || !Array.isArray(json.aircraft)) return;
        console.log('[ArgusProviderCache] supplemental raw:', json.aircraft.length, 'aircraft');
        _ingestAircraftArray(json.aircraft);
      })
      .catch(function (err) {
        _pollActive      = false;
        _audit.lastError = err && err.message ? err.message : String(err);
        // Silent failure — primary aircraft pipeline (fetch-traffic) continues unaffected.
      });
  }

  // ── Publish globals ──────────────────────────────────────────────────────────
  window._argusProviderAircraft = aircraftLiveCache;  // live Map ref — renderAircraft() reads this
  window._argusCurrentIcao24s   = new Set();          // populated by renderAircraft() each pass
  window.aircraftLiveCache      = aircraftLiveCache;  // public alias

  // ── Lifecycle ─────────────────────────────────────────────────────────────────
  function start() {
    if (_supplementalTimer) return; // already running
    // 20 s delay: primary renderAircraft() must populate _argusCurrentIcao24s before
    // first supplemental poll so we don't inject duplicates.
    setTimeout(_pollSupplemental, 20 * 1000);
    _supplementalTimer = setInterval(_pollSupplemental, SUPPLEMENTAL_POLL);
    console.log('[ArgusProviderCache] started — supplemental every',
      Math.round(SUPPLEMENTAL_POLL / 60000), 'min via fetch-supplemental');
  }

  function stop() {
    if (_supplementalTimer) { clearInterval(_supplementalTimer); _supplementalTimer = null; }
    aircraftLiveCache.clear();
    _enabled = false;
  }

  function status() {
    return {
      enabled:    _enabled,
      mode:       'netlify-supplemental',
      cacheSize:  aircraftLiveCache.size,
      polls:      _audit.polls,
      injected:   _audit.injected,
      skipped:    _audit.skipped,
      expired:    _audit.expired,
      lastPollMs: _audit.lastPollMs,
      lastError:  _audit.lastError,
      inFlight:   _pollActive,
    };
  }

  window.ArgusProviderCache = { start: start, stop: stop, status: status };

  // ── Auto-start ────────────────────────────────────────────────────────────────
  // Requires _argusReqCache. Retry once after 3 s if not yet available.
  setTimeout(function () {
    if (window._argusReqCache) {
      start();
    } else {
      setTimeout(function () { if (window._argusReqCache) start(); }, 3000);
    }
  }, 0);

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusProviderCache');

}());
