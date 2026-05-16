'use strict';
// modules/argusAcled.js
// ACLED geopolitical conflict/event intelligence overlay.
//
// Architecture:
//   SPARSE INTELLIGENCE OVERLAY. Not realtime telemetry.
//   Polls /.netlify/functions/fetch-acled every 4 hours.
//   Events are historical point-in-time records — not moving entities.
//   No animation loops. No continuous rerenders. No pulse rings.
//
// Cache isolation:
//   acledEventCache  Map<eventId, normalizedEvent>  — isolated from telemetry caches.
//   localStorage with 4h TTL for offline resilience.
//
// Render:
//   Low-frequency overlay markers on globe eventMarkerGroup.
//   Diff-based refresh — adds new events, removes stale ones, never full clear/recreate.
//   Visibility tied to window.ArgusLayerState.events.
//
// Globals:
//   window.acledEventCache — Map<id, event> per architecture spec
//   window.ArgusACLED      — { start, stop, refresh, status }
//
// Load order: after cache.js (window._argusReqCache) and globe init

window.ArgusACLED = (function () {
  'use strict';

  var ACLED_FN   = '/.netlify/functions/fetch-acled';
  var POLL_MS    = 4 * 60 * 60 * 1000;  // 4 hours — ACLED is sparse intelligence
  var CACHE_KEY  = 'argus_acled_v1';
  var CACHE_TS   = 'argus_acled_ts_v1';
  var CACHE_TTL  = 4 * 60 * 60 * 1000;

  // ── Isolated event cache ─────────────────────────────────────────────────────
  // Separate from aircraftLiveCache / weatherOverlayCache / energyInfrastructureCache.
  // Mutated in place — stable Map reference, zero GC pressure on cache hit.
  var acledEventCache = new Map();

  // ── Render state ─────────────────────────────────────────────────────────────
  // Track which eventIds are currently in the scene for diff-based updates.
  var _placedIds = new Set();

  // ── Audit ────────────────────────────────────────────────────────────────────
  var _audit = { polls: 0, placed: 0, removed: 0, lastPollMs: 0, lastError: null };

  // ── Poll timer ───────────────────────────────────────────────────────────────
  var _pollTimer = null;

  // ── Event type → THREE.js hex color ─────────────────────────────────────────
  var EVENT_COLORS = {
    'Battles':                     0xff0044,
    'Explosions/Remote violence':  0xff3300,
    'Violence against civilians':  0xff6600,
    'Riots':                       0xffaa00,
    'Protests':                    0xffee00,
    'Strategic developments':      0x00aaff,
  };
  var DEFAULT_COLOR = 0xff9933;

  function _eventColor(eventType) {
    return EVENT_COLORS[eventType] || DEFAULT_COLOR;
  }

  // ── Diff-based render ────────────────────────────────────────────────────────
  // Removes markers for events no longer in cache; adds markers for new events.
  // Never clears the entire event layer — only mutates the delta.
  function _renderEvents() {
    var AG = window.ArgusGlobe;
    if (!AG || !AG.eventMarkerGroup || !AG.latLonToVector) return;
    if (!acledEventCache.size) return;

    var R       = AG.R || {};
    var altR    = R.MARKER || 101;
    var visible = !!(window.ArgusLayerState && window.ArgusLayerState.events);
    var added   = 0;
    var removed = 0;

    // ── Remove markers for events no longer in cache ─────────────────────────
    var toRemove = [];
    AG.eventMarkerGroup.children.forEach(function (o) {
      if (o.userData && o.userData._acledMarker && !acledEventCache.has(o.userData._acledId)) {
        toRemove.push(o);
      }
    });
    for (var r = 0; r < toRemove.length; r++) {
      var dead = toRemove[r];
      if (window.ArgusResourceTracker) window.ArgusResourceTracker.safeDisposeMesh(dead, 'acled_event');
      AG.eventMarkerGroup.remove(dead);
      _placedIds.delete(dead.userData._acledId);
      removed++;
    }
    if (removed > 0) {
      window.eventMarkers = (window.eventMarkers || []).filter(function (m) {
        return !(m.userData && m.userData._acledMarker && !acledEventCache.has(m.userData._acledId));
      });
    }

    // ── Add markers for events not yet in scene ──────────────────────────────
    acledEventCache.forEach(function (ev) {
      if (_placedIds.has(ev.id)) return;  // already rendered — skip allocation

      var col = _eventColor(ev.eventType);
      var pos = AG.latLonToVector(ev.lat, ev.lon, altR);

      var mesh = new THREE.Mesh(
        new THREE.SphereGeometry(1.4, 8, 8),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.75 })
      );
      mesh.position.copy(pos);
      mesh.visible = visible;
      mesh.userData = {
        _acledMarker: true,
        _acledId:     ev.id,
        type:         ev.eventType,
        isACLED:      true,
        isCountry:    false,
        title:        (ev.country || 'Unknown') + ' — ' + ev.eventType,
        impact:       (ev.subEventType ? ev.subEventType + '. ' : '') +
                      (ev.actor1 || '') +
                      (ev.actor2 ? ' vs ' + ev.actor2 : '') +
                      (ev.fatalities ? '. Fatalities: ' + ev.fatalities : '') +
                      (ev.date ? ' (' + ev.date + ')' : ''),
        source:       'ACLED',
        countryCode:  null,
      };

      AG.eventMarkerGroup.add(mesh);
      if (window.eventMarkers) window.eventMarkers.push(mesh);
      _placedIds.add(ev.id);
      added++;
    });

    _audit.placed  += added;
    _audit.removed += removed;

    if (added > 0 || removed > 0) {
      if (typeof window.updateNodeCounts === 'function') window.updateNodeCounts();
    }
  }

  // ── Load API response into cache (diff-aware) ─────────────────────────────────
  function _loadResponse(json) {
    if (!json || !Array.isArray(json.events)) return;

    // Build incoming ID set for stale eviction
    var incomingIds = new Set();
    for (var i = 0; i < json.events.length; i++) {
      var ev = json.events[i];
      if (ev && ev.id && ev.lat != null && ev.lon != null) incomingIds.add(ev.id);
    }

    // Remove cache entries absent from new response
    acledEventCache.forEach(function (ev, id) {
      if (!incomingIds.has(id)) acledEventCache.delete(id);
    });

    // Upsert new / updated entries — mutate existing entry if key present
    for (var j = 0; j < json.events.length; j++) {
      var evt = json.events[j];
      if (!evt || !evt.id || evt.lat == null || evt.lon == null) continue;
      acledEventCache.set(evt.id, evt);
    }
  }

  // ── Poll ─────────────────────────────────────────────────────────────────────
  function _poll() {
    var reqCache = window._argusReqCache;
    if (!reqCache) return;

    _audit.polls++;

    reqCache.fetch(ACLED_FN)
      .then(function (json) {
        _audit.lastPollMs = Date.now();
        _audit.lastError  = null;

        if (json && json.disabled) return;  // feature gated on backend

        _loadResponse(json);

        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify(json));
          localStorage.setItem(CACHE_TS,  String(Date.now()));
        } catch (e) { /* localStorage full */ }

        _renderEvents();
      })
      .catch(function (err) {
        _audit.lastError = err.message;
        // Silent — ACLED is supplemental intelligence, not critical path
      });
  }

  // ── Start / stop ─────────────────────────────────────────────────────────────
  function start() {
    if (_pollTimer) return;

    // Warm from localStorage if cache is fresh — avoids cold-start network fetch
    try {
      var cached = localStorage.getItem(CACHE_KEY);
      var ts     = parseInt(localStorage.getItem(CACHE_TS) || '0');
      if (cached && Date.now() - ts < CACHE_TTL) {
        _loadResponse(JSON.parse(cached));
        // Defer render — globe must be ready first
        setTimeout(_renderEvents, 4000);
        _pollTimer = setInterval(_poll, POLL_MS);
        return;
      }
    } catch (e) { /* corrupt cache — fall through to network */ }

    // Initial fetch deferred 30s — primary telemetry pipeline gets first priority
    setTimeout(_poll, 30 * 1000);
    _pollTimer = setInterval(_poll, POLL_MS);
  }

  function stop() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    // Clear scene markers — diff will re-add on next start() if needed
    var AG = window.ArgusGlobe;
    if (AG && AG.eventMarkerGroup) {
      var toRemove = [];
      AG.eventMarkerGroup.children.forEach(function (o) {
        if (o.userData && o.userData._acledMarker) toRemove.push(o);
      });
      for (var i = 0; i < toRemove.length; i++) {
        if (window.ArgusResourceTracker) window.ArgusResourceTracker.safeDisposeMesh(toRemove[i], 'acled_event');
        AG.eventMarkerGroup.remove(toRemove[i]);
      }
      window.eventMarkers = (window.eventMarkers || []).filter(function (m) {
        return !(m.userData && m.userData._acledMarker);
      });
    }
    acledEventCache.clear();
    _placedIds.clear();
  }

  function refresh() {
    _poll();
  }

  function status() {
    return {
      cacheSize:  acledEventCache.size,
      placed:     _placedIds.size,
      polls:      _audit.polls,
      placed:     _audit.placed,
      removed:    _audit.removed,
      lastPollMs: _audit.lastPollMs,
      lastError:  _audit.lastError,
    };
  }

  // ── Publish globals ───────────────────────────────────────────────────────────
  window.acledEventCache = acledEventCache;  // canonical public name per architecture spec

  // Auto-start deferred one tick — allow all modules to complete init first
  setTimeout(function () {
    if (window._argusReqCache) {
      start();
    } else {
      setTimeout(function () { if (window._argusReqCache) start(); }, 3000);
    }
  }, 0);

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusACLED');

  return { start: start, stop: stop, refresh: refresh, status: status };

}());
