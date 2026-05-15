'use strict';
// core/providers/argusProviderCache.js
// Additive telemetry fallback provider — AISHub (vessels) + OpenSky (aircraft).
//
// Architecture:
//   This module is PURELY ADDITIVE. It only injects entities that are absent from or
//   stale in the primary pipelines. It NEVER alters, overrides, or replaces primary data.
//
// Staleness model (simple threshold — no probabilistic fusion):
//   AIS vessel: stale if _aisState.vessels has no entry for this MMSI, or updatedAt is
//               older than AIS_STALE_MS (90 seconds — 3× the AIS render interval).
//   Aircraft: stale if cachedStates has no entry for this ICAO24 in current snapshot.
//             We inject into a side buffer merged before renderAircraft().
//
// Injection mechanisms:
//   Vessels: calls window.ArgusAIS.updateVesselState() — same path as WebSocket ingest.
//            The existing _ingestBuffer → _processAndRender pipeline handles dedup.
//   Aircraft: writes to window._argusProviderAircraft (a side buffer). renderAircraft()
//             reads and merges this buffer before processing states, filtered by ICAO24
//             deduplication against the primary aircraft array.
//
// Priority hierarchy (highest to lowest):
//   1. Primary pipelines (fetch-traffic, AISstream WebSocket) — always win
//   2. Fallback providers (AISHub, OpenSky) — fill gaps only
//
// Poll intervals:
//   AISHub:  5 min (respects free-tier rate limit)
//   OpenSky: 3 min (conservative for anonymous tier)
//
// Console policy: silent at steady state. Use ArgusProviderCache.status() for diagnostics.
//
// Dependencies:
//   window.ArgusAIS            — for updateVesselState() injection
//   window._argusReqCache      — for deduped fetch (reuses existing infrastructure)
//   window.ArgusModuleAudit    — optional
//
// Load order: after argusAIS.js and argusTracking.js

(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────────────
  var AISHUB_FN     = '/.netlify/functions/fetch-aishub';
  var OPENSKY_FN    = '/.netlify/functions/fetch-opensky';

  var AIS_STALE_MS  = 90 * 1000;          // vessel is stale if not seen in 90 s
  var AISHUB_POLL   = 5 * 60 * 1000;      // AISHub free tier: 5 min minimum
  var OPENSKY_POLL  = 3 * 60 * 1000;      // OpenSky: 3 min (anonymous rate limit buffer)

  // Maximum fallback entities to inject per poll cycle — prevents fallback
  // from crowding out primary data if primary returns a partial snapshot.
  var MAX_AIS_INJECT       = 300;  // vessels from AISHub per cycle
  var MAX_OPENSKY_INJECT   = 200;  // aircraft from OpenSky per cycle

  // ── State ───────────────────────────────────────────────────────────────────
  var _aishubTimer   = null;
  var _openskyTimer  = null;
  var _enabled       = true;  // set false to fully suspend without reloading

  var _audit = {
    aishub:  { polls: 0, injected: 0, skipped: 0, lastPollMs: 0, lastError: null },
    opensky: { polls: 0, injected: 0, skipped: 0, lastPollMs: 0, lastError: null },
  };

  // Side buffer for OpenSky aircraft — consumed by the patched renderAircraft() wrapper.
  // Keyed by ICAO24 to allow O(1) lookups. Cleared after each merge.
  var _openskyBuffer = new Map();  // icao24 → normalized aircraft record

  // ── AIS vessel staleness check ───────────────────────────────────────────────
  // Returns true if this MMSI is absent from the primary AIS state store, or if
  // the vessel's last update is older than AIS_STALE_MS.
  function _isAISStale(mmsi) {
    var aisModule = window.ArgusAIS;
    if (!aisModule) return true;  // AIS not ready — inject conservatively

    // Access the internal state store via the exposed diagnostic interface.
    // ArgusAIS exposes _aisState.vessels indirectly through window._aisMarkers.
    // We check the aisMarkers Map (mmsi → { sprite, updatedAt }) which is reliable.
    var markers = window._aisMarkers;
    if (!markers) return true;

    var entry = markers.get(mmsi);
    if (!entry) return true;  // not tracked at all
    if (!entry.updatedAt) return true;

    return (Date.now() - entry.updatedAt) > AIS_STALE_MS;
  }

  // ── Aircraft staleness check ─────────────────────────────────────────────────
  // Returns true if this ICAO24 is absent from the current primary snapshot.
  // We read window._argusCurrentIcao24s — a Set maintained by the renderAircraft wrapper.
  function _isAircraftStale(icao24) {
    var primary = window._argusCurrentIcao24s;
    if (!primary || !primary.size) return true;  // no primary data yet — inject conservatively
    return !primary.has(icao24);
  }

  // ── AISHub poll ──────────────────────────────────────────────────────────────
  function _pollAISHub() {
    if (!_enabled) return;
    var aisModule = window.ArgusAIS;
    if (!aisModule || !aisModule.updateVesselState) return;  // AIS not initialized yet

    _audit.aishub.polls++;

    window._argusReqCache.fetch(AISHUB_FN)
      .then(function (json) {
        _audit.aishub.lastPollMs = Date.now();

        if (!json || !Array.isArray(json.vessels)) return;

        var injected = 0;
        var skipped  = 0;

        for (var i = 0; i < json.vessels.length && injected < MAX_AIS_INJECT; i++) {
          var v = json.vessels[i];
          if (!v || !v.mmsi || v.lat == null || v.lon == null) { skipped++; continue; }

          if (!_isAISStale(v.mmsi)) { skipped++; continue; }

          // Inject via the same path as WebSocket ingest — _ingestBuffer → _processAndRender.
          // This ensures all existing dedup, diff, and rendering logic applies uniformly.
          aisModule.updateVesselState(
            v.mmsi,
            v.name || null,
            v.lat,
            v.lon,
            v.heading,
            v.velocity,
            v.shipType || 'unknown',
            v.navStatus != null ? v.navStatus : null
          );
          injected++;
        }

        _audit.aishub.injected += injected;
        _audit.aishub.skipped  += skipped;
        _audit.aishub.lastError = null;
      })
      .catch(function (err) {
        _audit.aishub.lastError = err.message;
        // Silent failure — primary pipeline continues unaffected
      });
  }

  // ── OpenSky poll ─────────────────────────────────────────────────────────────
  function _pollOpenSky() {
    if (!_enabled) return;

    _audit.opensky.polls++;

    window._argusReqCache.fetch(OPENSKY_FN)
      .then(function (json) {
        _audit.opensky.lastPollMs = Date.now();

        if (!json || !Array.isArray(json.aircraft)) return;

        // Write to side buffer — renderAircraft() wrapper will merge on next render.
        // Clear first so we don't accumulate across polls.
        _openskyBuffer.clear();

        var injected = 0;
        var skipped  = 0;

        for (var i = 0; i < json.aircraft.length && injected < MAX_OPENSKY_INJECT; i++) {
          var ac = json.aircraft[i];
          if (!ac || !ac.icao24 || ac.lat == null || ac.lon == null) { skipped++; continue; }

          if (!_isAircraftStale(ac.icao24)) { skipped++; continue; }

          _openskyBuffer.set(ac.icao24, ac);
          injected++;
        }

        _audit.opensky.injected += injected;
        _audit.opensky.skipped  += skipped;
        _audit.opensky.lastError = null;
      })
      .catch(function (err) {
        _audit.opensky.lastError = err.message;
      });
  }

  // ── renderAircraft wrapper ───────────────────────────────────────────────────
  // Patches ArgusTracking.renderAircraft (internal) by hooking fetchAndRenderAircraft.
  // Strategy: intercept at the cachedStates level before renderAircraft() is called.
  //
  // We install a MutationObserver-free approach: poll for ArgusTracking readiness,
  // then wrap the internal fetchAndRenderAircraft to:
  //   1. After primary fetch resolves: extract the ICAO24 Set into _argusCurrentIcao24s
  //   2. Append _openskyBuffer entries that are absent from the primary snapshot
  //   3. Call renderAircraft with the merged payload
  //
  // This is accomplished by wrapping at the window.ArgusTracking public interface level.
  // ArgusTracking exposes no renderAircraft directly — we hook via a shared side buffer
  // that renderAircraft reads before processing. The buffer is installed as a property
  // on the cachedStates object so it flows naturally through the existing code path.
  //
  // SIMPLER approach used here: we expose _openskyBuffer on the window and patch
  // argusTracking's renderAircraft call site by injecting into cachedStates.aircraft
  // after the primary fetch, before the next render pass. This avoids monkey-patching
  // private functions and is fully reversible.
  //
  // Implementation: ArgusTracking reads window._argusProviderAircraft (if set) and
  // appends entries whose icao24 is NOT in the primary states array. We set this global
  // and ArgusTracking will read it. This requires one addition to argusTracking.js —
  // a single 4-line read of window._argusProviderAircraft inside renderAircraft().
  //
  // We also maintain window._argusCurrentIcao24s — the Set of ICAO24s in the current
  // primary snapshot, built inside renderAircraft() after states are extracted.
  //
  // Both globals are documented in ARGUS_GLOBALS.md (if present).

  window._argusProviderAircraft = _openskyBuffer;  // live reference — always current
  window._argusCurrentIcao24s   = new Set();       // populated by renderAircraft() patch

  // ── Start / stop ─────────────────────────────────────────────────────────────
  function start() {
    if (_aishubTimer || _openskyTimer) return;  // already running

    // Initial polls — staggered 10 s apart to avoid burst at startup
    setTimeout(_pollAISHub,  10 * 1000);
    setTimeout(_pollOpenSky, 20 * 1000);

    // Recurring polls
    _aishubTimer  = setInterval(_pollAISHub,  AISHUB_POLL);
    _openskyTimer = setInterval(_pollOpenSky, OPENSKY_POLL);

    console.log('[ArgusProviderCache] started — AISHub every 5 min, OpenSky every 3 min');
  }

  function stop() {
    if (_aishubTimer)  { clearInterval(_aishubTimer);  _aishubTimer  = null; }
    if (_openskyTimer) { clearInterval(_openskyTimer); _openskyTimer = null; }
    _openskyBuffer.clear();
    _enabled = false;
  }

  function status() {
    return {
      enabled:  _enabled,
      aishub:   JSON.parse(JSON.stringify(_audit.aishub)),
      opensky:  JSON.parse(JSON.stringify(_audit.opensky)),
      openskyBufferSize: _openskyBuffer.size,
    };
  }

  window.ArgusProviderCache = { start: start, stop: stop, status: status };

  // Auto-start when ArgusTracking is ready (it loads before this file)
  // Defer to next tick so all modules finish their own init first.
  setTimeout(function () {
    if (window._argusReqCache) {
      start();
    } else {
      // _argusReqCache not ready — retry once after 3 s
      setTimeout(function () { if (window._argusReqCache) start(); }, 3000);
    }
  }, 0);

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusProviderCache');

}());
