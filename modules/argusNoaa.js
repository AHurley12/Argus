'use strict';
// modules/argusNoaa.js
// NOAA environmental and weather intelligence overlay.
//
// Architecture:
//   SPARSE ENVIRONMENTAL INTELLIGENCE OVERLAY. Not realtime weather.
//   Surfaces macro weather systems: hurricanes, severe storms, extreme alerts.
//   Polls /.netlify/functions/fetch-noaa every 15 minutes.
//   No animation loops. No particle systems. No continuous rerenders.
//
// Data coverage:
//   - US NWS active severe alerts (Extreme + Severe severity)
//   - NHC global tropical cyclones (active Atlantic + Pacific storms)
//
// Cache isolation:
//   weatherOverlayCache  Map<alertId, normalizedAlert> — separate from all other caches.
//   localStorage with 15m TTL for offline resilience.
//
// Render:
//   Diff-based overlay markers on globe eventMarkerGroup.
//   Severity color coding: Extreme (magenta), Severe (red-orange), Moderate (yellow).
//   Visibility tied to window.ArgusLayerState.events.
//
// Globals:
//   window.weatherOverlayCache — Map<id, alert> per architecture spec
//   window.ArgusNOAA           — { start, stop, refresh, status }
//
// Load order: after cache.js (window._argusReqCache) and globe init

window.ArgusNOAA = (function () {
  'use strict';

  var NOAA_FN   = '/.netlify/functions/fetch-noaa';
  var POLL_MS   = 15 * 60 * 1000;  // 15 minutes
  var CACHE_KEY = 'argus_noaa_v1';
  var CACHE_TS  = 'argus_noaa_ts_v1';
  var CACHE_TTL = 15 * 60 * 1000;

  // ── Isolated weather cache ───────────────────────────────────────────────────
  // Separate from acledEventCache / aircraftLiveCache / energyInfrastructureCache.
  var weatherOverlayCache = new Map();

  // ── Render state ─────────────────────────────────────────────────────────────
  var _placedIds = new Set();

  // ── Audit ────────────────────────────────────────────────────────────────────
  var _audit = { polls: 0, placed: 0, removed: 0, lastPollMs: 0, lastError: null };

  // ── Poll timer ───────────────────────────────────────────────────────────────
  var _pollTimer = null;

  // ── Severity → THREE.js hex color ────────────────────────────────────────────
  var SEVERITY_COLORS = {
    'Extreme':  0xff00cc,  // magenta — catastrophic (Cat 3+ hurricane, violent tornado)
    'Severe':   0xff4400,  // red-orange — major impact (tropical storm, severe warning)
    'Moderate': 0xffcc00,  // yellow — watch / advisory
    'Minor':    0xaaaaaa,  // gray — informational
    'Unknown':  0xff9933,  // default orange
  };

  var WEATHER_BLUE = 0x2299ee;
  var WEATHER_RE   = /flood|storm|rain|snow|blizzard|drought|tornado|cyclone|monsoon|surge/i;

  function _severityColor(severity, eventType) {
    // Flood and precipitation-type alerts always use water blue regardless of severity
    if (eventType && WEATHER_RE.test(eventType)) return WEATHER_BLUE;
    return SEVERITY_COLORS[severity] || SEVERITY_COLORS['Unknown'];
  }

  // ── Geometry by event type ────────────────────────────────────────────────────
  // Hurricanes get a distinct shape vs standard warning spheres
  function _isTropicalCyclone(eventType) {
    var t = (eventType || '').toLowerCase();
    return t.indexOf('hurricane') >= 0 || t.indexOf('typhoon') >= 0 ||
           t.indexOf('tropical') >= 0  || t.indexOf('cyclone') >= 0;
  }

  // ── Diff-based render ────────────────────────────────────────────────────────
  function _renderAlerts() {
    var AG = window.ArgusGlobe;
    if (!AG || !AG.eventMarkerGroup || !AG.latLonToVector) return;
    if (!weatherOverlayCache.size) return;

    var R       = AG.R || {};
    var altR    = (R.MARKER || 101) + 0.5;  // very slightly above event markers
    var visible = !!(window.ArgusLayerState && window.ArgusLayerState.events);
    var added   = 0;
    var removed = 0;

    // ── Remove expired alerts ────────────────────────────────────────────────
    var toRemove = [];
    AG.eventMarkerGroup.children.forEach(function (o) {
      if (o.userData && o.userData._noaaMarker && !weatherOverlayCache.has(o.userData._noaaId)) {
        toRemove.push(o);
      }
    });
    for (var r = 0; r < toRemove.length; r++) {
      var dead = toRemove[r];
      if (window.ArgusResourceTracker) window.ArgusResourceTracker.safeDisposeMesh(dead, 'noaa_alert');
      AG.eventMarkerGroup.remove(dead);
      _placedIds.delete(dead.userData._noaaId);
      removed++;
    }
    if (removed > 0) {
      window.eventMarkers = (window.eventMarkers || []).filter(function (m) {
        return !(m.userData && m.userData._noaaMarker && !weatherOverlayCache.has(m.userData._noaaId));
      });
    }

    // ── Add new alerts ───────────────────────────────────────────────────────
    weatherOverlayCache.forEach(function (alert) {
      if (_placedIds.has(alert.id)) return;

      var col      = _severityColor(alert.severity, alert.eventType);
      var pos      = AG.latLonToVector(alert.lat, alert.lon, altR);
      var isTrop   = _isTropicalCyclone(alert.eventType);

      // Tropical cyclones use TetrahedronGeometry to distinguish from other alerts
      var geom = isTrop
        ? new THREE.TetrahedronGeometry(2.2, 0)
        : new THREE.SphereGeometry(1.6, 8, 8);

      var mesh = new THREE.Mesh(
        geom,
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.80 })
      );
      mesh.position.copy(pos);
      mesh.visible = visible;
      mesh.userData = {
        _noaaMarker:  true,
        _noaaId:      alert.id,
        _floodMarker: WEATHER_RE.test(alert.eventType || ''),
        type:         alert.eventType,
        isNOAA:       true,
        isCountry:    false,
        title:       alert.eventType + (alert.areaDesc ? ' — ' + alert.areaDesc.slice(0, 60) : ''),
        impact:      (alert.headline || alert.eventType) +
                     (alert.severity ? '. Severity: ' + alert.severity : '') +
                     (alert.urgency  ? '. Urgency: '  + alert.urgency  : '') +
                     (alert.expires  ? '. Expires: '  + alert.expires.slice(0, 10) : ''),
        source:      alert.source || 'NOAA',
        countryCode: null,
      };

      AG.eventMarkerGroup.add(mesh);
      if (window.eventMarkers) window.eventMarkers.push(mesh);
      _placedIds.add(alert.id);
      added++;
    });

    _audit.placed  += added;
    _audit.removed += removed;

    if (added > 0 || removed > 0) {
      if (typeof window.updateNodeCounts === 'function') window.updateNodeCounts();
    }
  }

  // ── Load API response into cache ──────────────────────────────────────────────
  function _loadResponse(json) {
    if (!json || !Array.isArray(json.alerts)) return;

    // Build incoming ID set for expired-alert eviction
    var incomingIds = new Set();
    for (var i = 0; i < json.alerts.length; i++) {
      var al = json.alerts[i];
      if (al && al.id && al.lat != null && al.lon != null) incomingIds.add(al.id);
    }

    // Evict alerts no longer active in response
    weatherOverlayCache.forEach(function (al, id) {
      if (!incomingIds.has(id)) weatherOverlayCache.delete(id);
    });

    // Upsert — mutate existing entry if key present (stable reference)
    for (var j = 0; j < json.alerts.length; j++) {
      var alert = json.alerts[j];
      if (!alert || !alert.id || alert.lat == null || alert.lon == null) continue;
      weatherOverlayCache.set(alert.id, alert);
    }
  }

  // ── Poll ─────────────────────────────────────────────────────────────────────
  function _poll() {
    var reqCache = window._argusReqCache;
    if (!reqCache) return;

    _audit.polls++;

    reqCache.fetch(NOAA_FN)
      .then(function (json) {
        _audit.lastPollMs = Date.now();
        _audit.lastError  = null;

        if (json && json.disabled) return;

        _loadResponse(json);

        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify(json));
          localStorage.setItem(CACHE_TS,  String(Date.now()));
        } catch (e) { /* localStorage full */ }

        _renderAlerts();
      })
      .catch(function (err) {
        _audit.lastError = err.message;
      });
  }

  // ── Start / stop ─────────────────────────────────────────────────────────────
  function start() {
    if (_pollTimer) return;

    try {
      var cached = localStorage.getItem(CACHE_KEY);
      var ts     = parseInt(localStorage.getItem(CACHE_TS) || '0');
      if (cached && Date.now() - ts < CACHE_TTL) {
        _loadResponse(JSON.parse(cached));
        setTimeout(_renderAlerts, 4500);
        _pollTimer = setInterval(_poll, POLL_MS);
        return;
      }
    } catch (e) { /* fall through */ }

    // Initial fetch deferred 45s — after ACLED deferred start at 30s
    setTimeout(_poll, 45 * 1000);
    _pollTimer = setInterval(_poll, POLL_MS);
  }

  function stop() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    var AG = window.ArgusGlobe;
    if (AG && AG.eventMarkerGroup) {
      var toRemove = [];
      AG.eventMarkerGroup.children.forEach(function (o) {
        if (o.userData && o.userData._noaaMarker) toRemove.push(o);
      });
      for (var i = 0; i < toRemove.length; i++) {
        if (window.ArgusResourceTracker) window.ArgusResourceTracker.safeDisposeMesh(toRemove[i], 'noaa_alert');
        AG.eventMarkerGroup.remove(toRemove[i]);
      }
      window.eventMarkers = (window.eventMarkers || []).filter(function (m) {
        return !(m.userData && m.userData._noaaMarker);
      });
    }
    weatherOverlayCache.clear();
    _placedIds.clear();
  }

  function refresh() {
    _poll();
  }

  function status() {
    return {
      cacheSize:  weatherOverlayCache.size,
      placed:     _placedIds.size,
      polls:      _audit.polls,
      placed:     _audit.placed,
      removed:    _audit.removed,
      lastPollMs: _audit.lastPollMs,
      lastError:  _audit.lastError,
    };
  }

  // ── Publish globals ───────────────────────────────────────────────────────────
  window.weatherOverlayCache = weatherOverlayCache;

  setTimeout(function () {
    if (window._argusReqCache) {
      start();
    } else {
      setTimeout(function () { if (window._argusReqCache) start(); }, 3000);
    }
  }, 0);

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusNOAA');

  return { start: start, stop: stop, refresh: refresh, status: status };

}());
