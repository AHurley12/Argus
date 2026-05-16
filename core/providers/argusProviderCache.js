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
  var MAX_INJECT       = 200;             // hard ceiling: cache never exceeds this count
  var STALE_MS         = OPENSKY_POLL * 3; // 9 min — force-evict after 3 missed cycles

  // ── Live aircraft cache ──────────────────────────────────────────────────────
  // Canonical Map<icao24, normalizedRecord>. Populated by _pollOpenSky().
  // Consumed by renderAircraft() via window._argusProviderAircraft (live reference).
  // Mutated in place each cycle — entries are set() / clear(), not array push/splice.
  var aircraftLiveCache = new Map();  // icao24 → { icao24, callsign, lat, lon, track, gs, alt, flightType, stale, source }

  // ── Audit ────────────────────────────────────────────────────────────────────
  var _audit = {
    polls: 0, injected: 0, skipped: 0, expired: 0, lastPollMs: 0, lastError: null,
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
  // Diff-based update — never blind-clears the cache.
  // Explicit expiration: delete entries absent from incoming snapshot OR older than STALE_MS.
  // Hard cap: aircraftLiveCache.size is guaranteed ≤ MAX_INJECT after every cycle.
  function _pollOpenSky() {
    if (!_enabled || !window._argusReqCache) return;

    _audit.polls++;
    var sizeAtStart = aircraftLiveCache.size;

    window._argusReqCache.fetch(OPENSKY_FN)
      .then(function (json) {
        _audit.lastPollMs = Date.now();
        _audit.lastError  = null;

        if (!json || !Array.isArray(json.aircraft)) return;

        var nowMs = Date.now();

        // ── Emergency guard: corrupt cache detection ───────────────────────────
        // If something external wrote to window.aircraftLiveCache without the
        // injection cap, the Map may be inflated to thousands or hundreds of
        // thousands of entries. Iterating that in Step 2 would itself cause a
        // long task. Short-circuit with clear() instead — next poll repopulates.
        if (aircraftLiveCache.size > MAX_INJECT * 2) {
          console.warn('[ArgusProviderCache] Cache inflated to', aircraftLiveCache.size,
            'entries — clearing. Investigate external writes to window.aircraftLiveCache.');
          aircraftLiveCache.clear();
        }

        // ── Step 1: Build capped, deduplicated incoming set ────────────────────
        // Process the response first — build the set of valid, primary-absent ICAO24s
        // we actually intend to keep this cycle. Cap applied here prevents the loop
        // from writing more than MAX_INJECT entries regardless of response size.
        var incomingIds = new Set();
        var incoming    = [];

        for (var i = 0; i < json.aircraft.length; i++) {
          if (incoming.length >= MAX_INJECT) break;
          var ac = json.aircraft[i];
          if (!ac || !ac.icao24 || ac.lat == null || ac.lon == null) continue;
          if (incomingIds.has(ac.icao24)) continue;  // dedup within this response
          if (!_isPrimaryAbsent(ac.icao24)) continue;
          incomingIds.add(ac.icao24);
          incoming.push(ac);
        }

        // ── Step 2: Explicit stale expiration ──────────────────────────────────
        // Delete any cache entry that is:
        //   (a) absent from the incoming snapshot — dropped by primary or OpenSky, or
        //   (b) older than STALE_MS regardless — secondary circuit-breaker.
        // This is O(cache size) and mutates the live Map directly. The window reference
        // (window._argusProviderAircraft) stays stable — no reassignment needed.
        var expired = 0;
        aircraftLiveCache.forEach(function (entry, id) {
          var tooOld = (entry._cachedAt != null) && (nowMs - entry._cachedAt) > STALE_MS;
          if (!incomingIds.has(id) || tooOld) {
            aircraftLiveCache.delete(id);
            expired++;
          }
        });

        // ── Step 3: Diff upsert — UPDATE existing entries, CREATE new ones ─────
        // Stable ICAO24 is the canonical key. Same aircraft across polls → same key.
        // No ID instability here: ICAO24 is a fixed transponder address, not derived
        // from timestamps, random values, or per-cycle data.
        var created = 0;
        var updated = 0;

        for (var j = 0; j < incoming.length; j++) {
          var entry  = incoming[j];
          var exists = aircraftLiveCache.has(entry.icao24);
          entry._cachedAt = nowMs;  // stamp insertion time for STALE_MS circuit-breaker
          aircraftLiveCache.set(entry.icao24, entry);
          if (exists) { updated++; } else { created++; }
        }

        // ── Step 4: Hard cap — belt-and-suspenders ─────────────────────────────
        // Should never fire under normal operation (Step 1 cap prevents it).
        // Guards against any external writes to window.aircraftLiveCache that bypass
        // the injection path (e.g. direct console manipulation, external modules).
        if (aircraftLiveCache.size > MAX_INJECT) {
          var iter = aircraftLiveCache.keys();
          var trim = aircraftLiveCache.size - MAX_INJECT;
          for (var k = 0; k < trim; k++) aircraftLiveCache.delete(iter.next().value);
          console.warn('[ArgusProviderCache] HARD CAP — trimmed', trim, 'excess entries. Investigate write source.');
        }

        // ── Step 5: Structured cycle diagnostic ───────────────────────────────
        var delta = aircraftLiveCache.size - sizeAtStart;
        console.log(
          '[OpenSky Cycle]',
          'created:', created,
          '| updated:', updated,
          '| expired:', expired,
          '| cacheSize:', aircraftLiveCache.size,
          '| growthDelta:', (delta >= 0 ? '+' : '') + delta
        );

        _audit.injected += created + updated;
        _audit.skipped  += (json.aircraft.length - incoming.length);
        _audit.expired  += expired;
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
      expired:          _audit.expired,
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
