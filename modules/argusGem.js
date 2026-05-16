'use strict';
// modules/argusGem.js
// Global Energy Monitor (GEM) infrastructure intelligence overlay.
//
// Architecture:
//   STATIC INFRASTRUCTURE INTELLIGENCE. Not realtime. Not event-driven.
//   GEM data (LNG terminals, pipelines, power infrastructure, energy chokepoints)
//   changes rarely — treated as persistent strategic reference data.
//
//   Fetches once on startup (or when cache is stale). Refreshes daily.
//   No polling loops after initial load. No animation. No rerenders.
//
// Cache isolation:
//   energyInfrastructureCache  Map<infraId, normalizedInfra> — separate from all other caches.
//   localStorage with 24h TTL (avoids network on every page load).
//
// Render:
//   Static infrastructure markers on globe eventMarkerGroup.
//   Placed once — not continuously rerendered.
//   Infrastructure type color coding: LNG (cyan), pipeline (green), power (yellow).
//   Visibility tied to window.ArgusLayerState.events.
//
// Globals:
//   window.energyInfrastructureCache — Map<id, infra> per architecture spec
//   window.ArgusGEM                  — { start, stop, refresh, status }
//
// Load order: after cache.js (window._argusReqCache) and globe init

window.ArgusGEM = (function () {
  'use strict';

  var GEM_FN     = '/.netlify/functions/fetch-gem';
  var CACHE_KEY  = 'argus_gem_v1';
  var CACHE_TS   = 'argus_gem_ts_v1';
  var CACHE_TTL  = 24 * 60 * 60 * 1000;  // 24h localStorage TTL
  var REFRESH_MS = 24 * 60 * 60 * 1000;  // daily refresh check

  // ── Isolated infrastructure cache ────────────────────────────────────────────
  var energyInfrastructureCache = new Map();

  // ── Render state ─────────────────────────────────────────────────────────────
  var _placedIds   = new Set();
  var _rendered    = false;  // one-shot render flag

  // ── Audit ────────────────────────────────────────────────────────────────────
  var _audit = { fetches: 0, placed: 0, lastFetchMs: 0, lastError: null };

  // ── Refresh timer ─────────────────────────────────────────────────────────────
  var _refreshTimer = null;

  // ── Infrastructure type → THREE.js hex color ─────────────────────────────────
  var TYPE_COLORS = {
    'lng':            0x00ffff,  // cyan — LNG terminals
    'lng terminal':   0x00ffff,
    'pipeline':       0x00ff88,  // green — gas pipelines
    'gas':            0x00cc66,
    'power':          0xffee00,  // yellow — power plants
    'coal':           0xaaaaaa,  // gray — coal infrastructure
    'oil':            0xff8800,  // orange — oil infrastructure
    'nuclear':        0x8888ff,  // lavender — nuclear
    'solar':          0xffdd00,  // solar yellow
    'wind':           0x88ffcc,  // teal — wind
    'hydro':          0x4488ff,  // blue — hydro
    'infrastructure': 0x88aacc,  // default steel blue
  };

  function _infraColor(type) {
    var t = (type || '').toLowerCase();
    for (var key in TYPE_COLORS) {
      if (Object.prototype.hasOwnProperty.call(TYPE_COLORS, key) && t.indexOf(key) >= 0) {
        return TYPE_COLORS[key];
      }
    }
    return TYPE_COLORS['infrastructure'];
  }

  // ── Render infrastructure from cache (one-shot, not a loop) ──────────────────
  function _renderInfrastructure() {
    var AG = window.ArgusGlobe;
    if (!AG || !AG.eventMarkerGroup || !AG.latLonToVector) return;
    if (!energyInfrastructureCache.size) return;

    var R       = AG.R || {};
    var altR    = R.MARKER || 101;
    var visible = !!(window.ArgusLayerState && window.ArgusLayerState.events);
    var added   = 0;

    // ── Remove stale markers (items evicted from cache) ──────────────────────
    var toRemove = [];
    AG.eventMarkerGroup.children.forEach(function (o) {
      if (o.userData && o.userData._gemMarker && !energyInfrastructureCache.has(o.userData._gemId)) {
        toRemove.push(o);
      }
    });
    for (var r = 0; r < toRemove.length; r++) {
      var dead = toRemove[r];
      if (window.ArgusResourceTracker) window.ArgusResourceTracker.safeDisposeMesh(dead, 'gem_infra');
      AG.eventMarkerGroup.remove(dead);
      _placedIds.delete(dead.userData._gemId);
    }
    if (toRemove.length > 0) {
      window.eventMarkers = (window.eventMarkers || []).filter(function (m) {
        return !(m.userData && m.userData._gemMarker && !energyInfrastructureCache.has(m.userData._gemId));
      });
    }

    // ── Add new markers (items not yet in scene) ──────────────────────────────
    // BoxGeometry — visually distinct from event spheres and GDACS octahedra
    energyInfrastructureCache.forEach(function (infra) {
      if (_placedIds.has(infra.id)) return;

      var col = _infraColor(infra.type);
      var pos = AG.latLonToVector(infra.lat, infra.lon, altR);

      var mesh = new THREE.Mesh(
        new THREE.BoxGeometry(1.2, 1.2, 1.2),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.70 })
      );
      mesh.position.copy(pos);
      mesh.visible = visible;

      var capacityStr = infra.capacity
        ? ' · Capacity: ' + infra.capacity + (infra.unit ? ' ' + infra.unit : '')
        : '';
      var statusStr = infra.status ? ' · Status: ' + infra.status : '';

      mesh.userData = {
        _gemMarker:  true,
        _gemId:      infra.id,
        type:        infra.type,
        isGEM:       true,
        isCountry:   false,
        title:       (infra.name || infra.type) + (infra.country ? ' — ' + infra.country : ''),
        impact:      (infra.type || 'Infrastructure') + capacityStr + statusStr +
                     (infra.fuel ? ' · Fuel: ' + infra.fuel : ''),
        source:      'Global Energy Monitor',
        countryCode: null,
      };

      AG.eventMarkerGroup.add(mesh);
      if (window.eventMarkers) window.eventMarkers.push(mesh);
      _placedIds.add(infra.id);
      added++;
    });

    _audit.placed += added;
    _rendered = true;

    if (added > 0) {
      if (typeof window.updateNodeCounts === 'function') window.updateNodeCounts();
    }
  }

  // ── Load response into cache ───────────────────────────────────────────────────
  function _loadResponse(json) {
    if (!json || !Array.isArray(json.infrastructure)) return;

    var incomingIds = new Set();
    for (var i = 0; i < json.infrastructure.length; i++) {
      var infra = json.infrastructure[i];
      if (infra && infra.id && infra.lat != null && infra.lon != null) incomingIds.add(infra.id);
    }

    // Evict removed infrastructure
    energyInfrastructureCache.forEach(function (infra, id) {
      if (!incomingIds.has(id)) energyInfrastructureCache.delete(id);
    });

    // Upsert — mutate in place if key exists
    for (var j = 0; j < json.infrastructure.length; j++) {
      var item = json.infrastructure[j];
      if (!item || !item.id || item.lat == null || item.lon == null) continue;
      energyInfrastructureCache.set(item.id, item);
    }
  }

  // ── Fetch (not a tight poll — daily check only) ───────────────────────────────
  function _fetch() {
    var reqCache = window._argusReqCache;
    if (!reqCache) return;

    _audit.fetches++;

    reqCache.fetch(GEM_FN)
      .then(function (json) {
        _audit.lastFetchMs = Date.now();
        _audit.lastError   = null;

        if (json && json.disabled) return;  // feature gated on backend

        _loadResponse(json);

        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify(json));
          localStorage.setItem(CACHE_TS,  String(Date.now()));
        } catch (e) { /* localStorage full */ }

        _renderInfrastructure();
      })
      .catch(function (err) {
        _audit.lastError = err.message;
        // Silent — GEM is optional infrastructure intelligence
      });
  }

  // ── Start / stop ─────────────────────────────────────────────────────────────
  function start() {
    if (_refreshTimer) return;

    // Warm from localStorage if fresh — GEM data rarely changes
    try {
      var cached = localStorage.getItem(CACHE_KEY);
      var ts     = parseInt(localStorage.getItem(CACHE_TS) || '0');
      if (cached && Date.now() - ts < CACHE_TTL) {
        var parsed = JSON.parse(cached);
        if (parsed && !parsed.disabled) {
          _loadResponse(parsed);
          setTimeout(_renderInfrastructure, 5000);
          // Daily refresh check — just check cache age, only re-fetch if stale
          _refreshTimer = setInterval(function () {
            var age = Date.now() - parseInt(localStorage.getItem(CACHE_TS) || '0');
            if (age > CACHE_TTL) _fetch();
          }, REFRESH_MS);
          return;
        }
      }
    } catch (e) { /* fall through */ }

    // Initial fetch deferred 60s — lower priority than ACLED and NOAA starts
    setTimeout(_fetch, 60 * 1000);

    // Daily refresh check
    _refreshTimer = setInterval(function () {
      var age = Date.now() - parseInt(localStorage.getItem(CACHE_TS) || '0');
      if (age > CACHE_TTL) _fetch();
    }, REFRESH_MS);
  }

  function stop() {
    if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
    var AG = window.ArgusGlobe;
    if (AG && AG.eventMarkerGroup) {
      var toRemove = [];
      AG.eventMarkerGroup.children.forEach(function (o) {
        if (o.userData && o.userData._gemMarker) toRemove.push(o);
      });
      for (var i = 0; i < toRemove.length; i++) {
        if (window.ArgusResourceTracker) window.ArgusResourceTracker.safeDisposeMesh(toRemove[i], 'gem_infra');
        AG.eventMarkerGroup.remove(toRemove[i]);
      }
      window.eventMarkers = (window.eventMarkers || []).filter(function (m) {
        return !(m.userData && m.userData._gemMarker);
      });
    }
    energyInfrastructureCache.clear();
    _placedIds.clear();
    _rendered = false;
  }

  function refresh() {
    _fetch();
  }

  function status() {
    return {
      cacheSize:   energyInfrastructureCache.size,
      placed:      _placedIds.size,
      rendered:    _rendered,
      fetches:     _audit.fetches,
      placed:      _audit.placed,
      lastFetchMs: _audit.lastFetchMs,
      lastError:   _audit.lastError,
    };
  }

  // ── Publish globals ───────────────────────────────────────────────────────────
  window.energyInfrastructureCache = energyInfrastructureCache;

  setTimeout(function () {
    if (window._argusReqCache) {
      start();
    } else {
      setTimeout(function () { if (window._argusReqCache) start(); }, 3000);
    }
  }, 0);

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusGEM');

  return { start: start, stop: stop, refresh: refresh, status: status };

}());
