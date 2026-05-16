'use strict';
// core/providers/argusProviderCache.js
// Aircraft supplemental telemetry provider — OpenSky Network (additive, aircraft only).
//
// Architecture:
//   PURELY ADDITIVE. Injects aircraft that are absent from the primary fetch-traffic
//   snapshot. Never alters, overrides, or replaces primary data.
//   AISstream remains the sole realtime vessel provider — no vessel fallback here.
//
// Vessel strategy:
//   AISstream WebSocket is the only vessel telemetry source. Future vessel additions
//   should target metadata enrichment (IMO lookup, flag/operator, destination
//   normalization) — NOT additional high-frequency global AIS streams.
//
// Aircraft staleness model:
//   An ICAO24 is considered absent if it is not in the current primary snapshot.
//   window._argusCurrentIcao24s (a Set) is populated by renderAircraft() on each
//   render pass. OpenSky entries whose ICAO24 is in that Set are silently skipped.
//
// Injection path:
//   OpenSky poll → normalize → filter by _argusCurrentIcao24s → write to aircraftLiveCache.
//   renderAircraft() reads window._argusProviderAircraft (live reference to aircraftLiveCache)
//   and appends absent ICAO24s before processing — zero allocation on cache hit.
//
// Cache:
//   aircraftLiveCache  Map<icao24, normalizedAircraftRecord>  — live, mutated in place.
//   Cleared and repopulated each poll cycle. renderAircraft() reads it by reference
//   between polls — no copy, no GC pressure.
//
// Poll interval: 3 min (conservative for OpenSky anonymous tier).
//   Server-side (fetch-opensky.js) caches 2 min in Supabase.
//
// Console policy: silent at steady state. ArgusProviderCache.status() for diagnostics.
//
// Dependencies:
//   window._argusReqCache    — deduped fetch infrastructure (cache.js)
//   window.ArgusModuleAudit  — optional
//
// Load order: after argusAIS.js and argusTracking.js (last two scripts in body)

(function () {
  'use strict';

  // ── Config ───────────────────────────────────────────────────────────────────
  var OPENSKY_FN       = '/.netlify/functions/fetch-opensky';
  var OPENSKY_POLL     = 3 * 60 * 1000;   // 3 min — conservative for anonymous tier
  var MAX_INJECT       = 200;             // max aircraft to load into cache per cycle

  // ── Live aircraft cache ──────────────────────────────────────────────────────
  // Canonical Map<icao24, normalizedRecord>. Populated by _pollOpenSky().
  // Consumed by renderAircraft() via window._argusProviderAircraft (live reference).
  // Mutated in place each cycle — entries are set() / clear(), not array push/splice.
  var aircraftLiveCache = new Map();  // icao24 → { icao24, callsign, lat, lon, track, gs, alt, flightType, stale, source }

  // ── Audit ────────────────────────────────────────────────────────────────────
  var _audit = {
    polls: 0, injected: 0, skipped: 0, lastPollMs: 0, lastError: null,
  };

  // ── State ────────────────────────────────────────────────────────────────────
  var _openskyTimer = null;
  var _enabled      = true;

  // ── Aircraft staleness check ─────────────────────────────────────────────────
  // Returns true if this ICAO24 is NOT in the current primary snapshot.
  // renderAircraft() populates window._argusCurrentIcao24s after extracting states.
  function _isPrimaryAbsent(icao24) {
    var primary = window._argusCurrentIcao24s;
    if (!primary || !primary.size) return true;  // no primary data yet — inject conservatively
    return !primary.has(icao24);
  }

  // ── OpenSky poll ─────────────────────────────────────────────────────────────
  function _pollOpenSky() {
    if (!_enabled || !window._argusReqCache) return;

    _audit.polls++;

    window._argusReqCache.fetch(OPENSKY_FN)
      .then(function (json) {
        _audit.lastPollMs = Date.now();
        _audit.lastError  = null;

        if (!json || !Array.isArray(json.aircraft)) return;

        // Repopulate cache — clear first to evict stale ICAO24s from previous cycle.
        // All mutations are in-place on the Map; the window reference stays stable.
        aircraftLiveCache.clear();

        var injected = 0;
        var skipped  = 0;

        for (var i = 0; i < json.aircraft.length; i++) {
          if (injected >= MAX_INJECT) break;
          var ac = json.aircraft[i];
          if (!ac || !ac.icao24 || ac.lat == null || ac.lon == null) { skipped++; continue; }

          // Only cache ICAO24s absent from the current primary snapshot.
          // On the next renderAircraft() call, the merge step re-checks this anyway,
          // but pre-filtering here avoids polluting the cache with known duplicates.
          if (!_isPrimaryAbsent(ac.icao24)) { skipped++; continue; }

          // Mutate in place if already cached (ICAO24 re-appearing after primary miss).
          // set() on an existing key overwrites — Map reference identity is preserved.
          aircraftLiveCache.set(ac.icao24, ac);
          injected++;
        }

        _audit.injected += injected;
        _audit.skipped  += skipped;
      })
      .catch(function (err) {
        _audit.lastError = err.message;
        // Silent failure — primary aircraft pipeline continues unaffected.
      });
  }

  // ── Publish globals ──────────────────────────────────────────────────────────
  // window._argusProviderAircraft  — live Map reference consumed by renderAircraft()
  // window._argusCurrentIcao24s    — Set populated by renderAircraft() for staleness checks
  // window.aircraftLiveCache       — canonical public name per architecture spec
  window._argusProviderAircraft = aircraftLiveCache;   // live reference — always current
  window._argusCurrentIcao24s   = new Set();           // populated by renderAircraft() on each pass
  window.aircraftLiveCache      = aircraftLiveCache;   // canonical alias

  // ── Start / stop ─────────────────────────────────────────────────────────────
  function start() {
    if (_openskyTimer) return;  // already running

    // Initial poll deferred 20 s — primary pipeline gets its first render in first.
    // This ensures _argusCurrentIcao24s is populated before we filter against it.
    setTimeout(_pollOpenSky, 20 * 1000);

    _openskyTimer = setInterval(_pollOpenSky, OPENSKY_POLL);

    console.log('[ArgusProviderCache] started — OpenSky supplemental aircraft every 3 min');
  }

  function stop() {
    if (_openskyTimer) { clearInterval(_openskyTimer); _openskyTimer = null; }
    aircraftLiveCache.clear();
    _enabled = false;
  }

  function status() {
    return {
      enabled:          _enabled,
      cacheSize:        aircraftLiveCache.size,
      polls:            _audit.polls,
      injected:         _audit.injected,
      skipped:          _audit.skipped,
      lastPollMs:       _audit.lastPollMs,
      lastError:        _audit.lastError,
    };
  }

  window.ArgusProviderCache = { start: start, stop: stop, status: status };

  // Auto-start — defer one tick so all modules complete init first.
  setTimeout(function () {
    if (window._argusReqCache) {
      start();
    } else {
      // Retry once after 3 s if request cache hasn't initialized yet.
      setTimeout(function () { if (window._argusReqCache) start(); }, 3000);
    }
  }, 0);

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusProviderCache');

}());
