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

  // ── Instanced visual mesh ────────────────────────────────────────────────────
  // Ghost meshes (material.visible=false) stay in eventMarkerGroup for raycasting.
  // A single InstancedMesh handles all visual rendering — 873 draw calls → 1.
  var _imesh   = null;
  var _iDummy  = new THREE.Object3D();
  var _iColor  = new THREE.Color();
  var _IMAX    = 2000;  // pre-allocated instance capacity

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

      // Ghost mesh: material.visible=false → zero draw calls, still raycasted for hover/click.
      // Visual rendering is handled by _imesh (InstancedMesh) below.
      var mesh = new THREE.Mesh(
        new THREE.SphereGeometry(1.4, 8, 8),
        new THREE.MeshBasicMaterial({ color: col, visible: false })
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

    // Rebuild InstancedMesh whenever the event set changes (or on first render).
    // Ghost meshes above handle raycasting; _imesh handles all visual draw calls (873→1).
    _rebuildInstanced(AG, altR, visible);
  }

  // ── InstancedMesh rebuild ─────────────────────────────────────────────────────
  // Called after every _renderEvents(). Builds one InstancedMesh for all ACLED events,
  // using per-instance color. Ghost meshes are kept invisible for raycasting only.
  function _rebuildInstanced(AG, altR, visible) {
    if (!AG || !AG.eventMarkerGroup) return;

    // Create InstancedMesh once; reuse across rebuilds.
    if (!_imesh) {
      var geo = new THREE.SphereGeometry(1.4, 8, 8);
      var mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.75 });
      _imesh = new THREE.InstancedMesh(geo, mat, _IMAX);
      _imesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      _imesh.name          = 'ArgusACLEDInstanced';
      _imesh.frustumCulled = false;
      _imesh.count         = 0;
      _imesh.visible       = false;  // hidden until first rebuild sets it

      // Pre-allocate instanceColor buffer
      var cols = new Float32Array(_IMAX * 3);
      for (var ci = 0; ci < _IMAX * 3; ci++) cols[ci] = 1.0;
      _imesh.instanceColor = new THREE.InstancedBufferAttribute(cols, 3);

      AG.eventMarkerGroup.add(_imesh);
    }

    // Zero-scale dummy for slots beyond the active count
    _iDummy.scale.set(0, 0, 0);
    _iDummy.position.set(0, 0, 0);
    _iDummy.rotation.set(0, 0, 0);
    _iDummy.updateMatrix();

    var n = 0;
    acledEventCache.forEach(function (ev) {
      if (n >= _IMAX) return;
      var pos = AG.latLonToVector(ev.lat, ev.lon, altR);
      _iDummy.position.copy(pos);
      _iDummy.scale.set(1, 1, 1);
      _iDummy.updateMatrix();
      _imesh.setMatrixAt(n, _iDummy.matrix);

      _iColor.setHex(_eventColor(ev.eventType));
      var off = n * 3;
      _imesh.instanceColor.array[off]     = _iColor.r;
      _imesh.instanceColor.array[off + 1] = _iColor.g;
      _imesh.instanceColor.array[off + 2] = _iColor.b;
      n++;
    });

    _imesh.count = n;
    _imesh.instanceMatrix.needsUpdate = true;
    _imesh.instanceColor.needsUpdate  = true;
    _imesh.visible = !!(visible);

    console.log('[ArgusACLED] instanced mesh rebuilt —', n, 'events in 1 draw call');
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
    if (_imesh) _imesh.visible = false;
    acledEventCache.clear();
    _placedIds.clear();
  }

  function refresh() {
    _poll();
  }

  // Called by index.html event layer toggles (E key, modal close) to show/hide
  // the InstancedMesh. Ghost meshes are managed via window.eventMarkers.forEach().
  function setVisible(v) {
    if (_imesh) _imesh.visible = !!v;
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

  return { start: start, stop: stop, refresh: refresh, status: status, setVisible: setVisible };

}());
