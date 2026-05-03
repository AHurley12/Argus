(function() {
'use strict';

// ── Deferred localStorage write helper ───────────────────────────────────────
// Schedules writes via setTimeout so serialization runs after the current call
// stack clears. This prevents synchronous main-thread stalls caused by large
// JSON payloads (aircraft ~75 KB every 90 s, GDELT ~150 KB every 25 min).
// API is a drop-in replacement for localStorage.setItem — pass a string or any
// JSON-serializable value. Optional delayMs debounces rapid successive writes.
// NOTE: Do NOT use for session tokens or auth state — those must persist
// immediately. Use synchronous localStorage.setItem for those.
(function() {
  var _timers = {};
  window._lsWrite = function(key, value, delayMs) {
    if (_timers[key]) clearTimeout(_timers[key]);
    _timers[key] = setTimeout(function() {
      delete _timers[key];
      try {
        localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
      } catch(e) {}
    }, delayMs || 0);
  };
}());

// ── Performance monitor ───────────────────────────────────────────────────────
// Tracks timing stats for named operations across the session.
// Call  ArgusPerf.report()  from the browser console at any time.
// Budgets (ms): FRAME_TIME=16.67, SCAN=200, AIRCRAFT_RENDER=200, RAYCAST=10
(function() {
  var _stats = {}; // name → { count, totalMs, maxMs, overBudget }

  function record(name, ms, budgetMs) {
    var s = _stats[name] || (_stats[name] = { count: 0, totalMs: 0, maxMs: 0, overBudget: 0 });
    s.count++;
    s.totalMs += ms;
    if (ms > s.maxMs) s.maxMs = ms;
    if (budgetMs && ms > budgetMs) {
      s.overBudget++;
      console.warn('[ArgusPerf] ' + name + ' ' + ms.toFixed(1) + 'ms (budget ' + budgetMs + 'ms)');
    }
  }

  // Measure a synchronous function and record its duration.
  function measure(name, fn, budgetMs) {
    var t0 = performance.now();
    var r  = fn();
    record(name, performance.now() - t0, budgetMs);
    return r;
  }

  // Print a formatted session report to the browser console.
  function report() {
    var names = Object.keys(_stats).sort();
    if (!names.length) { console.log('[ArgusPerf] No data yet.'); return; }
    console.group('[ArgusPerf] Session Performance Report');
    names.forEach(function(name) {
      var s   = _stats[name];
      var avg = s.count ? (s.totalMs / s.count).toFixed(1) : '—';
      var row = name
        + '  avg='  + avg + 'ms'
        + '  max='  + s.maxMs.toFixed(1) + 'ms'
        + '  n='    + s.count;
      if (s.overBudget) row += '  ⚠ over-budget=' + s.overBudget + '/' + s.count;
      console.log(row);
    });
    console.groupEnd();
  }

  // Long Tasks API — browser fires this automatically for any task > 50 ms.
  // Catches unexpected main-thread stalls with zero manual instrumentation.
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      new PerformanceObserver(function(list) {
        list.getEntries().forEach(function(e) { record('LONG_TASK', e.duration, 50); });
      }).observe({ type: 'longtask', buffered: true });
    } catch(_) {}
  }

  window.ArgusPerf = { record: record, measure: measure, report: report };
}());

// ── Event listener registry ───────────────────────────────────────────────────
// Tracks every addEventListener call made by the globe engine so that all
// handlers can be removed in one pass on beforeunload. Without this, browsers
// may retain the JS heap (including Three.js objects) for the lifetime of the
// tab even after navigation, because live event handlers count as GC roots.
// Usage: evtMgr.add(element, event, handler[, options])
//        evtMgr.removeAll()
(function() {
  function EventManager() {
    // Map<element, Array<{event, handler, options}>>
    this._reg = new Map();
  }
  EventManager.prototype.add = function(element, event, handler, options) {
    if (!this._reg.has(element)) this._reg.set(element, []);
    this._reg.get(element).push({ event: event, handler: handler, options: options });
    element.addEventListener(event, handler, options);
  };
  EventManager.prototype.removeAll = function() {
    this._reg.forEach(function(entries, element) {
      entries.forEach(function(e) {
        element.removeEventListener(e.event, e.handler, e.options);
      });
    });
    this._reg.clear();
  };
  window.ArgusEventManager = EventManager;
}());

// ── Request coalescer / in-flight cache ───────────────────────────────────────
// Deduplicates concurrent fetches to the same URL (e.g. two rapid calls to the
// aircraft or vessel endpoint while a fetch is already in-flight) and caches
// successful responses for `ttlMs` milliseconds so a brief surge of callers
// all get the same payload without hitting the Netlify function again.
// Backed by a plain Map so memory is bounded to open requests + TTL window.
// Usage: window._argusReqCache.fetch(url) → Promise<response>
(function() {
  function RequestCache(ttlMs) {
    this._ttl     = ttlMs || 30000;
    this._cache   = new Map(); // url → { data, ts }
    this._pending = new Map(); // url → Promise
  }
  RequestCache.prototype.fetch = function(url) {
    var self = this;
    // Return cached entry if still fresh
    var cached = this._cache.get(url);
    if (cached && (Date.now() - cached.ts) < this._ttl) {
      return Promise.resolve(cached.data);
    }
    // Coalesce: reuse in-flight promise if one already exists for this URL
    if (this._pending.has(url)) {
      return this._pending.get(url);
    }
    // Issue a new fetch and cache the result
    var promise = fetch(url)
      .then(function(r) {
        if (!r.ok) return Promise.reject('HTTP ' + r.status);
        return r.json();
      })
      .then(function(data) {
        self._cache.set(url, { data: data, ts: Date.now() });
        self._pending.delete(url);
        return data;
      })
      .catch(function(err) {
        self._pending.delete(url);
        return Promise.reject(err);
      });
    this._pending.set(url, promise);
    return promise;
  };
  // Expose a shared singleton; individual callers can also create their own instances.
  window.ArgusRequestCache = RequestCache;
  window._argusReqCache    = new RequestCache(0); // TTL=0 → coalesce only, no extra caching
}());

// ── Anonymous session ID ──────────────────────────────────────────────────────
// Persistent UUID stored in localStorage. Used as user_id in the Netlify AI proxy
// functions (ai-query.js, ai-classify.js) for per-user rate limit tracking.
// Not auth-linked — it identifies a browser profile, not an account. This is
// intentional: combining it with a server-side global hard cap is sufficient to
// prevent financial runaway without requiring a full auth system.
(function() {
  var _UID_KEY = 'argus_uid_v1';
  var uid = localStorage.getItem(_UID_KEY);
  if (!uid || uid.length < 8) {
    // Generate a random UUID v4
    uid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
    localStorage.setItem(_UID_KEY, uid);
  }
  window.ArgusUID = uid;
}());

// ── Global marker registries (accessed by data script and GDELT module) ──────
window.eventMarkers      = [];
window.countryMarkers    = [];
window.chokepointMarkers = [];   // unused after refactor, kept for external compat
window.chokepointSpikes  = [];   // rotating prism meshes (isStaticSpike)
window.chokepointRings   = [];   // pulse ring meshes (isPulseRingStatic)

// ── Layer visibility — Single Source of Truth ────────────────────────────────
// All hover detection and tooltip rendering MUST derive from this state.
window.ArgusLayerState = {
  events:      false,
  chokepoints: false,
  countries:   false,
  capitals:    false,
  vessels:     false,
  aircraft:    false,
  aisVessels:  true    // mirrors aisOn default (true) in ArgusAIS
};

document.addEventListener('DOMContentLoaded', function() {

  // ── Globe engine event listener registry ────────────────────────────────────
  // All canvas / window listeners created below are registered through evtMgr
  // so that beforeunload can call evtMgr.removeAll() and release GC roots.
  var evtMgr = new window.ArgusEventManager();

  // ── Renderer ────────────────────────────────────────────────────────────────
  const container = document.getElementById('globe-canvas-container');
  const W = container.clientWidth  || window.innerWidth;
  const H = container.clientHeight || (window.innerHeight - 62);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, precision: 'highp' });
  renderer.setSize(W, H);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x020a15, 1);
  container.appendChild(renderer.domElement);

  // ── Scene & Camera ──────────────────────────────────────────────────────────
  const scene  = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 1000);
  camera.position.z = 225;

  // ── Raycasters ──────────────────────────────────────────────────────────────
  const raycasterClick = new THREE.Raycaster();
  const raycasterHover = new THREE.Raycaster();
  const mouseClick     = new THREE.Vector2();
  const mouseHover     = new THREE.Vector2();

  // ── Globe ───────────────────────────────────────────────────────────────────
  const Globe = new ThreeGlobe();

  // Fetch country polygons (Natural Earth 110m)
  fetch('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson')
    .then(function(r) { return r.json(); })
    .then(function(geo) {
      // ThreeGlobe 2.30 — call setters individually; chaining breaks after polygonStrokeColor
      Globe.polygonsData(geo.features);
      Globe.polygonAltitude(0.008);
      Globe.polygonCapColor(function() { return 'rgba(100,150,200,0.48)'; });
      Globe.polygonSideColor(function() { return 'rgba(0,80,150,0.2)'; });
      Globe.polygonStrokeColor(function() { return '#0f2744'; });
      if (typeof Globe.polygonLabel    === 'function') Globe.polygonLabel(function(d) { return '<b>' + d.properties.ADMIN + '</b>'; });
      if (typeof Globe.onPolygonHover  === 'function') Globe.onPolygonHover(function(h) { document.body.style.cursor = h ? 'pointer' : 'grab'; });
    })
    .catch(function(e) { console.warn('Country polygon fetch failed:', e); });

  Globe
    .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-dark.jpg')
    .bumpImageUrl('https://unpkg.com/three-globe/example/img/earth-topology.png');

  // Globe group — contains ONLY the globe mesh/texture
  const globeGroup = new THREE.Group();
  globeGroup.add(Globe);
  scene.add(globeGroup);
  // Rotate texture to align with data coordinate system (lon+180 formula places lon=0 at +X)
  globeGroup.rotation.y = Math.PI / 2;

  // Data group — contains all markers (events, AIS, flights, chokepoints, countries, grid)
  // Separate from globeGroup so texture can be corrected without affecting marker positions
  const dataGroup = new THREE.Group();
  scene.add(dataGroup);

  // ── Coordinate Grid ─────────────────────────────────────────────────────────
  var coordinateGrid = (function buildGrid() {
    var group   = new THREE.Group();
    var radius = R.GRID;
    var matMinor = new THREE.LineBasicMaterial({ color: 0x0f4a7a, transparent: true, opacity: 0.25 });
    var matMajor = new THREE.LineBasicMaterial({ color: 0x1a6a9a, transparent: true, opacity: 0.40 });

    // Latitude parallels
    for (var lat = -90; lat <= 90; lat += 5) {
      var pts = [];
      for (var lon = -180; lon <= 180; lon += 5) { pts.push(latLonToVector(lat, lon, radius)); }
      var mat = (lat === 0 || lat % 30 === 0) ? matMajor : matMinor;
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
    }
    // Longitude meridians
    for (var lon2 = -180; lon2 < 180; lon2 += 5) {
      var pts2 = [];
      for (var lat2 = -90; lat2 <= 90; lat2 += 5) { pts2.push(latLonToVector(lat2, lon2, radius)); }
      var mat2 = (lon2 === 0 || lon2 === -180 || lon2 % 30 === 0) ? matMajor : matMinor;
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts2), mat2));
    }

    dataGroup.add(group);
    return group;
  })();

  evtMgr.add(window, 'keydown', function(e) {
    // Never fire globe shortcuts while user is typing in any input/textarea/select
    var tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (document.activeElement && document.activeElement.isContentEditable) return;
    // Also block if any modal overlay is open — catches focus on overlay div itself
    if (document.querySelector('#analyst-modal-overlay.is-open')) return;
    if (document.querySelector('#es-modal-overlay.is-open')) return;
    if (document.querySelector('#panel-ai.is-open')) return;
    if (e.key.toLowerCase() === 'g') coordinateGrid.visible = !coordinateGrid.visible;
    if (e.key.toLowerCase() === 't') routeArcLines.forEach(function(l) { l.visible = !l.visible; });
    if (e.key.toLowerCase() === 'c') {
      var cnOn = !(window.ArgusLayerState.countries);
      window.ArgusLayerState.countries = cnOn;
      window.countryMarkers.forEach(function(m) { m.visible = cnOn; });
      if (!cnOn) clearHoverTooltip();
    }
    if (e.key.toLowerCase() === 'v') {
      var capOn = !(window.ArgusLayerState.capitals);
      window.ArgusLayerState.capitals = capOn;
      capitalMarkers.forEach(function(m) { m.visible = capOn; });
      if (!capOn) clearHoverTooltip();
    }
    if (e.key.toLowerCase() === 'e') {
      var evOn = !(window.ArgusLayerState.events);
      window.ArgusLayerState.events = evOn;
      window.eventMarkers.forEach(function(m) { m.visible = evOn; });
      // Also toggle pulse rings (they are NOT in eventMarkers)
      var _emg = window.ArgusGlobe && window.ArgusGlobe.eventMarkerGroup;
      if (_emg) _emg.children.forEach(function(obj) {
        if (obj.userData && obj.userData.isPulseRing) obj.visible = evOn;
      });
      if (!evOn) clearHoverTooltip();
    }
    if (e.key.toLowerCase() === 'k') {
      var cpOn = !(window.ArgusLayerState.chokepoints);
      window.ArgusLayerState.chokepoints = cpOn;
      window.chokepointMarkers.forEach(function(m) { m.visible = cpOn; });
      window.chokepointSpikes.forEach(function(m)  { m.visible = cpOn; });
      window.chokepointRings.forEach(function(m)   { m.visible = cpOn; });
      if (!cpOn) clearHoverTooltip();
    }
  });

  // ── Lights ──────────────────────────────────────────────────────────────────
  scene.add(new THREE.AmbientLight(0x2a4560, 1.6));
  var sun = new THREE.DirectionalLight(0x99aacc, 2.2);
  sun.position.set(5, 3, 5);
  scene.add(sun);
  var fill = new THREE.DirectionalLight(0x001a33, 0.5);
  fill.position.set(-5, -2, -5);
  scene.add(fill);

  // ── Coordinate helpers ───────────────────────────────────────────────────────
  // Layered radii prevent z-fighting between co-planar marker groups.
  // Globe surface = 100. Each layer sits 0.5–3.5 units above it.
  var R = {
    GRID:     100.39,  // coordinate grid lines
    MARKER:   101,     // countries, chokepoints, static routes
    SHIP:     101.5,   // VesselAPI commercial ships
    AIS:      101.3,   // live AIS vessels (below ships, no z-fight)
    AIRCRAFT: 101.8,   // aircraft + capital cities
    CORRIDOR: 101.9,   // flight corridor endpoints
    EVENT:    102,     // dynamic event pins + permanent markers
    DISASTER: 103.5    // GDACS/USGS disaster markers (top layer)
  };

  function latLonToVector(lat, lon, r) {
    r = r || 100;
    var phi   = (90 - lat) * Math.PI / 180;
    var theta = (lon + 180) * Math.PI / 180;
    return new THREE.Vector3(
      -r * Math.sin(phi) * Math.cos(theta),
       r * Math.cos(phi),
       r * Math.sin(phi) * Math.sin(theta)
    );
  }

  // ── Visibility culling (front-hemisphere only) ───────────────────────────────
  function isFacingCamera(mesh) {
    var wp = new THREE.Vector3();
    mesh.getWorldPosition(wp);
    return wp.normalize().dot(camera.position.clone().normalize()) > 0;
  }

  // ── Tooltip ──────────────────────────────────────────────────────────────────
  var tooltip = document.createElement('div');
  tooltip.id = 'argus-tooltip';
  tooltip.style.cssText = [
    'position:absolute', 'background:rgba(10,20,40,0.92)', 'border:1px solid #1a6a9a',
    'color:#00ff88', 'padding:6px 12px', 'border-radius:3px', 'font-family:var(--font-mono)',
    'font-size:10px', 'white-space:nowrap', 'pointer-events:none',
    'z-index:var(--z-tooltip)', 'display:none', 'backdrop-filter:blur(8px)'
  ].join(';');
  document.body.appendChild(tooltip);

  function getDotScreenPos(mesh) {
    var wp = new THREE.Vector3();
    mesh.getWorldPosition(wp);
    var proj = wp.project(camera);
    var rect = renderer.domElement.getBoundingClientRect();
    return {
      x: (proj.x *  0.5 + 0.5) * rect.width  + rect.left,
      y: (proj.y * -0.5 + 0.5) * rect.height + rect.top
    };
  }

  var RISK_CSS = { LOW:'#00ff88', WATCH:'#ffcc00', WARNING:'#ff9933', CRITICAL:'#ff0044' };

  function buildTooltipRow(d) {
    var risk = d.severity || d.risk || 'LOW';
    var col  = RISK_CSS[risk] || '#aaa';
    if (d.isCapitalCity) {
      return '<div style="padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.06)">' +
        '<span style="color:#c5d7e8;font-weight:700;font-size:10px">' + d.city + '</span>' +
        '<span style="color:#4a7da8;font-size:9px;margin-left:6px">CAPITAL</span>' +
        '<span style="color:#5577aa;font-size:9px;margin-left:6px">' + d.country + '</span>' +
        '<div style="color:#4a6080;font-size:8px;margin-top:1px">' + d.lat.toFixed(1) + '°N ' + Math.abs(d.lon).toFixed(1) + '°' + (d.lon >= 0 ? 'E' : 'W') + '</div></div>';
    }
    if (d.isCountry) {
      return '<div style="padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.06)">' +
        '<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">' +
          '<span style="color:' + col + ';font-weight:700;font-size:10px">' + d.label + '</span>' +
          '<span style="color:' + col + ';font-size:8px;letter-spacing:1px">● ' + risk + '</span>' +
        '</div>' +
        '<div style="display:flex;gap:10px">' +
          (d.pop ? '<span style="color:#4a7da8;font-size:8px">POP <span style="color:#c5d7e8">' + d.pop + '</span></span>' : '') +
          (d.gdp ? '<span style="color:#4a7da8;font-size:8px">GDP <span style="color:#c5d7e8">' + d.gdp + '</span></span>' : '') +
          '<span style="color:#4a7da8;font-size:8px">RISK <span style="color:' + col + '">' + d.score + '/100</span></span>' +
        '</div>' +
      '</div>';
    }
    if (d.isChokepoint) {
      return '<div style="padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.06)">' +
        '<span style="color:' + col + ';font-weight:700;font-size:10px">' + d.label + '</span>' +
        '<span style="color:#4a7da8;font-size:9px;margin-left:6px">CHOKEPOINT</span>' +
        '<span style="color:' + col + ';font-size:9px;margin-left:6px">◆ ' + risk + '</span></div>';
    }
    return '<div style="padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.06)">' +
      '<span style="color:' + col + ';font-weight:700;font-size:10px">' + (d.title || 'EVENT') + '</span>' +
      '<span style="color:#4a7da8;font-size:9px;margin-left:6px">' + (d.type || 'EVENT') + '</span>' +
      '<span style="color:' + col + ';font-size:9px;margin-left:6px">✦ ' + risk + '</span></div>';
  }

  // ── Event Locations ──────────────────────────────────────────────────────────
  var eventLocations = [
    { lat: 12.5, lon: 43.3,  type: 'CONFLICT', severity: 'CRITICAL', title: 'Bab-el-Mandeb - Houthi Attacks',    id: 'bab-mandeb' },
    { lat: 29.5, lon: 32.5,  type: 'CONFLICT', severity: 'CRITICAL', title: 'Red Sea - Suez Corridor',           id: 'red-sea'    },
    { lat: 9.0,  lon: -79.5, type: 'DISASTER', severity: 'WATCH',    title: 'Panama Canal - Drought Crisis',     id: 'panama'     },
    { lat: 45.0, lon: 30.5,  type: 'CONFLICT', severity: 'WARNING',  title: 'Black Sea - Corridor Blockade',     id: 'black-sea'  },
    { lat: 24.5, lon: 121.0, type: 'DISASTER', severity: 'WATCH',    title: 'Taiwan Strait - Military Activity', id: 'taiwan'     },
  ];

  var severityColor = { CRITICAL: 0xff0044, WARNING: 0xff9933, WATCH: 0xffcc00, LOW: 0x00ff88 };

  var eventMarkerGroup = new THREE.Group();
  eventLocations.forEach(function(ev) {
    var pos = latLonToVector(ev.lat, ev.lon);
    var col = severityColor[ev.severity];

    var mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1.68, 16, 16),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.39 })
    );
    mesh.position.copy(pos);
    // Source discriminator — required by ArgusHardcodedQueue FIFO logic
    mesh.userData = Object.assign({}, ev, { source: 'HARDCODED', _hcMarker: true, timestamp: Date.now() });
    eventMarkerGroup.add(mesh);
    window.eventMarkers.push(mesh);

    var ring = new THREE.Mesh(
      new THREE.RingGeometry(2.4, 3.6, 32),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
    );
    ring.position.copy(pos);
    ring.lookAt(pos.clone().normalize().multiplyScalar(200));
    ring.userData = { isPulseRing: true, phase: Math.random() * Math.PI * 2, _hcMarker: true };
    eventMarkerGroup.add(ring);
  });
  dataGroup.add(eventMarkerGroup);
  // Hide hardcoded event markers and their pulse rings on first load
  window.eventMarkers.forEach(function(m) { m.visible = false; });
  eventMarkerGroup.children.forEach(function(obj) {
    if (obj.userData && obj.userData.isPulseRing) obj.visible = false;
  });

  // ── Static Data ─ see /data/static-data.js ────────────────────────────────

  var STATIC_RC = { LOW:'#00ff88', WATCH:'#ffcc00', MEDIUM:'#ffaa00', WARNING:'#ff9933', HIGH:'#ff3300', CRITICAL:'#ff0044' };

  var staticMarkerGroup = new THREE.Group();
  var routeArcLines     = [];

  function addStaticMarker(rawLat, rawLon, colorHex, size, userData, withSpike) {
    var pos   = latLonToVector(rawLat, rawLon, R.MARKER);
    var color = new THREE.Color(colorHex);

    // Chokepoints use an invisible hit sphere (no visual bubble, interaction preserved)
    var mesh = new THREE.Mesh(
      new THREE.SphereGeometry(size, 14, 14),
      userData.isChokepoint
        ? new THREE.MeshBasicMaterial({ visible: false })
        : new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.82 })
    );
    mesh.position.copy(pos);
    mesh.userData = userData;
    staticMarkerGroup.add(mesh);
    if (userData.isCountry)    window.countryMarkers.push(mesh);
    if (userData.isChokepoint) window.chokepointMarkers.push(mesh);

    // Pulse ring — chokepoints only; country dots are static for visual clarity
    if (!userData.isCountry) {
      var ring = new THREE.Mesh(
        new THREE.RingGeometry(size * 1.9, size * 2.7, 28),
        new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.45, side: THREE.DoubleSide })
      );
      ring.position.copy(pos);
      ring.lookAt(pos.clone().normalize().multiplyScalar(200));
      ring.userData = { isPulseRingStatic: true, phase: Math.random() * Math.PI * 2 };
      staticMarkerGroup.add(ring);
      if (userData.isChokepoint) window.chokepointRings.push(ring);
    }

    if (withSpike) {
      var spike = new THREE.Mesh(
        new THREE.OctahedronGeometry(size * 1.6, 0),
        new THREE.MeshBasicMaterial({ color: color, wireframe: true, transparent: true, opacity: 0.72 })
      );
      spike.position.copy(pos);
      spike.userData = { isStaticSpike: true };
      staticMarkerGroup.add(spike);
      window.chokepointSpikes.push(spike);
    }
  }

  // ── Spherical linear interpolation between two unit vectors ─────────────────
  // Guarantees the path follows the globe surface (great circle) at every segment,
  // preventing transpacific/transatlantic arcs from cutting through the Earth.
  function slerpVec3(v0, v1, t) {
    var dot = Math.min(1, Math.max(-1, v0.dot(v1)));
    var omega = Math.acos(dot);
    if (Math.abs(omega) < 0.0001) {
      // Vectors are nearly identical — safe to lerp
      return new THREE.Vector3().lerpVectors(v0, v1, t);
    }
    var sinOmega = Math.sin(omega);
    var a = Math.sin((1 - t) * omega) / sinOmega;
    var b = Math.sin(t * omega)       / sinOmega;
    return new THREE.Vector3(
      a * v0.x + b * v1.x,
      a * v0.y + b * v1.y,
      a * v0.z + b * v1.z
    );
  }

  function addRouteArc(rawLat0, rawLon0, rawLat1, rawLon1, colorHex, vol) {
    var r0 = latLonToVector(rawLat0, rawLon0, R.MARKER);
    var r1 = latLonToVector(rawLat1, rawLon1, R.MARKER);
    var u0 = r0.clone().normalize();
    var u1 = r1.clone().normalize();

    var SEGS      = 80;
    var arcLift   = 26 * (vol / 900); // peak altitude above surface at midpoint
    var pts = [];
    for (var i = 0; i <= SEGS; i++) {
      var t    = i / SEGS;
      var sv   = slerpVec3(u0, u1, t);              // great-circle unit vector
      var lift = 101 + arcLift * Math.sin(Math.PI * t); // sine arc, max at midpoint
      pts.push(sv.multiplyScalar(lift));
    }

    var line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: new THREE.Color(colorHex), transparent: true, opacity: 0.38 })
    );
    staticMarkerGroup.add(line);
    routeArcLines.push(line);
  }

  window.countryHitMeshes = [];
  COUNTRIES_DATA.forEach(function(c) {
    addStaticMarker(c.rawLat, c.rawLon, STATIC_RC[c.risk], 1.07, Object.assign({ isCountry: true }, c), false);
    // Invisible hit sphere 30% larger than the marker for expanded hover area
    var hitPos = latLonToVector(c.rawLat, c.rawLon, R.MARKER);
    var hitMesh = new THREE.Mesh(
      new THREE.SphereGeometry(1.07 * 1.3, 8, 8),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    hitMesh.position.copy(hitPos);
    hitMesh.userData = Object.assign({ isCountry: true }, c);
    staticMarkerGroup.add(hitMesh);
    window.countryHitMeshes.push(hitMesh);
  });
  CHOKEPOINTS_DATA.forEach(function(cp) {
    addStaticMarker(cp.rawLat, cp.rawLon, STATIC_RC[cp.risk], 1.3, Object.assign({ isChokepoint: true }, cp), true);
  });
  ROUTES_DATA.forEach(function(rt) {
    var f = COUNTRIES_DATA.find(function(c) { return c.code === rt.from; });
    var t = COUNTRIES_DATA.find(function(c) { return c.code === rt.to; });
    if (f && t) addRouteArc(f.rawLat, f.rawLon, t.rawLat, t.rawLon, STATIC_RC[rt.risk], rt.vol);
  });
  dataGroup.add(staticMarkerGroup);
  // Hide country markers and chokepoint hit spheres/prisms/rings on first load
  window.countryMarkers.forEach(function(m)   { m.visible = false; });
  window.chokepointMarkers.forEach(function(m) { m.visible = false; });
  window.chokepointSpikes.forEach(function(m)  { m.visible = false; });
  window.chokepointRings.forEach(function(m)   { m.visible = false; });

  // Node counter — exposed on window for data script
  window.updateNodeCounts = function() {
    var nodes    = window.eventMarkers
      .filter(function(m) { return !m.userData.isAircraft && !m.userData.isShip; })
      .concat(window.chokepointMarkers);
    var critical = nodes.filter(function(m) {
      return (m.userData.severity || m.userData.risk) === 'CRITICAL';
    }).length;
    document.getElementById('ev-count').textContent   = nodes.length;
    document.getElementById('crit-count').textContent = critical;
  };
  window.updateNodeCounts();


  // ── City icon texture — canvas-drawn once, shared across all capital markers ──
  // Four blocks of ascending heights with blue/cyan gradient + right-face depth cue.
  // Consistent with aircraft/vessel sprite architecture (_acTex, _shTex).
  var _cityTex = (function() {
    var sz = 64;
    var cv = document.createElement('canvas');
    cv.width = cv.height = sz;
    var c = cv.getContext('2d');

    // Base platform glow
    var baseGrad = c.createRadialGradient(32, 57, 1, 32, 57, 22);
    baseGrad.addColorStop(0, 'rgba(0,190,255,0.55)');
    baseGrad.addColorStop(1, 'rgba(0,190,255,0)');
    c.fillStyle = baseGrad;
    c.fillRect(6, 48, 52, 14);

    // Blocks: [left, width, height] — bottom-aligned at y=54, ascending left→peak→step-down
    [[3,9,20],[14,10,33],[26,11,43],[39,9,27]].forEach(function(b) {
      var bx = b[0], bw = b[1], bh = b[2], by = 54 - bh;

      // Main face: cyan top → deep blue bottom
      var g = c.createLinearGradient(bx, by, bx, 54);
      g.addColorStop(0, 'rgba(114,238,255,0.95)');
      g.addColorStop(1, 'rgba(0,80,200,0.92)');
      c.fillStyle = g;
      c.fillRect(bx, by, bw, bh);

      // Right-side darker face — simulates 3D depth without extra geometry
      c.fillStyle = 'rgba(0,40,140,0.4)';
      c.fillRect(bx + bw - 2, by + 2, 2, bh - 2);

      // Top highlight — simulates lit roof
      c.fillStyle = 'rgba(180,248,255,0.88)';
      c.fillRect(bx, by, bw, 2);
    });

    return new THREE.CanvasTexture(cv);
  }());

  var capitalMarkers = [];
  capitalCitiesData.forEach(function(city) {
    var pos = latLonToVector(city.lat, city.lon, R.AIRCRAFT);
    var mat = new THREE.SpriteMaterial({
      map:         _cityTex,
      transparent: true,
      opacity:     0.92,
      depthTest:   false
    });
    var sprite = new THREE.Sprite(mat);
    sprite.position.copy(pos);
    sprite.scale.set(1.68, 1.68, 1);
    sprite.userData = {
      isCapitalCity: true,
      city:          city.capital,
      country:       city.country,
      label:         city.capital + ', ' + city.country,
      lat:           city.lat,
      lon:           city.lon
    };
    eventMarkerGroup.add(sprite);
    capitalMarkers.push(sprite);
  });
  // Hide capital city markers on first load
  capitalMarkers.forEach(function(m) { m.visible = false; });

  // ── Mouse Controls ───────────────────────────────────────────────────────────
  var isDragging = false;
  var prevMouse  = { x: 0, y: 0 };

  evtMgr.add(renderer.domElement, 'mousedown', function(e) {
    isDragging = true;
    prevMouse  = { x: e.clientX, y: e.clientY };
    document.body.classList.add('is-dragging');
  });

  evtMgr.add(renderer.domElement, 'mousemove', function(e) {
    if (isDragging) {
      var dx = e.clientX - prevMouse.x;
      var dy = e.clientY - prevMouse.y;
      globeGroup.rotation.y += dx * 0.005;
      globeGroup.rotation.x += dy * 0.005;
      globeGroup.rotation.x = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, globeGroup.rotation.x));
      // dataGroup has no initial offset, so subtract the fixed PI/2 texture correction
      // to keep globe mesh and data layer in sync during drag.
      dataGroup.rotation.y = globeGroup.rotation.y - Math.PI / 2;
      dataGroup.rotation.x = globeGroup.rotation.x;
      prevMouse = { x: e.clientX, y: e.clientY };
    }
  });

  evtMgr.add(renderer.domElement, 'mouseup',    function() { isDragging = false; document.body.classList.remove('is-dragging'); });
  evtMgr.add(renderer.domElement, 'mouseleave', function() { isDragging = false; document.body.classList.remove('is-dragging'); });
  evtMgr.add(renderer.domElement, 'wheel', function(e) {
    e.preventDefault();
    // Scale zoom speed with distance so close-range scrolling stays granular
    // and far-range scrolling covers ground quickly
    var zoomSpeed = e.deltaY * 0.14375 * (camera.position.z / 225);
    // Zoom range scaled 10% closer across the board (initial 250→225, min 113→102, max 400→360).
    // Globe radius = 100; at z=102 camera is 2 units above surface — no near-plane clipping risk.
    // Coordinate accuracy (latLonToVector) is world-space and unaffected by camera distance.
    camera.position.z = Math.max(102, Math.min(360, camera.position.z + zoomSpeed));
  }, { passive: false });

  // ── Touch Controls — globe rotation on mobile ─────────────────────────────
  // Maps single-finger drag to the same rotation logic as mouse drag.
  // Uses SEPARATE state (_prevTouch, _touchDragged) so mouse and touch can
  // never clobber each other — safe on hybrid touchscreen laptops.
  //
  // Tap (no drag): touchstart is passive so the browser fires the normal
  // compatibility click event after touchend — marker selection still works.
  // Drag: touchmove calls preventDefault() to (a) block page scroll and
  // (b) suppress compatibility mousemove events that would double-rotate.
  // touch-action: none in CSS is also set so the browser yields all touch
  // gestures to JS before attempting native scroll/zoom on the canvas.
  var _prevTouch    = { x: 0, y: 0 };
  var _touchDragged = false;

  evtMgr.add(renderer.domElement, 'touchstart', function(e) {
    if (e.touches.length !== 1) return;          // ignore pinch / multi-touch
    _prevTouch    = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    _touchDragged = false;
    document.body.classList.add('is-dragging');
  }, { passive: true });  // passive: true → browser can still fire click after tap

  evtMgr.add(renderer.domElement, 'touchmove', function(e) {
    if (e.touches.length !== 1) return;
    var dx = e.touches[0].clientX - _prevTouch.x;
    var dy = e.touches[0].clientY - _prevTouch.y;

    // Ignore micro-trembles (< 4px) so a stationary hold doesn't jitter the globe
    if (!_touchDragged && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    _touchDragged = true;

    // Now that we're committed to a drag, prevent page scroll AND suppress
    // the compatibility mousemove events the browser would otherwise synthesise.
    e.preventDefault();

    globeGroup.rotation.y += dx * 0.005;
    globeGroup.rotation.x += dy * 0.005;
    globeGroup.rotation.x  = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, globeGroup.rotation.x));
    dataGroup.rotation.y = globeGroup.rotation.y - Math.PI / 2;
    dataGroup.rotation.x = globeGroup.rotation.x;
    _prevTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, { passive: false });  // passive: false required for e.preventDefault()

  evtMgr.add(renderer.domElement, 'touchend', function() {
    document.body.classList.remove('is-dragging');
    // Reset isDragging in case a compatibility mousedown fired during touchstart
    // (can happen on some Android browsers before touchmove suppresses them).
    isDragging = false;
  }, { passive: true });

  // ── Hover helpers ────────────────────────────────────────────────────────────
  var _activeHoverObj = null;

  // clearHoverTooltip — hides tooltip and resets active hover state.
  // Called on layer toggle, frame reconciliation, and canvas leave.
  function clearHoverTooltip() {
    tooltip.style.display = 'none';
    _activeHoverObj = null;
  }

  // canInteract — centralized visibility gate for ALL interaction paths (hover + click).
  // An object passes only when it is visible, its parent group is visible, and its
  // corresponding layer is enabled in ArgusLayerState.
  // Three.js raycaster does NOT cascade parent group visibility — that check is here.
  function canInteract(obj) {
    if (!obj || !obj.visible) return false;
    if (obj.parent && !obj.parent.visible) return false;
    var ls = window.ArgusLayerState;
    if (!ls) return true;
    var d = obj.userData;
    if (!d) return true;
    if (d.isAircraft)    return ls.aircraft;
    if (d.isAISVessel)   return ls.aisVessels;  // AIS gate — independent of VesselAPI ships
    if (d.isShip)        return ls.vessels;
    if (d.isCountry)     return ls.countries;
    if (d.isCapitalCity) return ls.capitals;
    if (d.isChokepoint)  return ls.chokepoints;
    return ls.events;
  }

  // Clear tooltip when cursor leaves the canvas entirely
  evtMgr.add(renderer.domElement, 'mouseleave', function() {
    clearHoverTooltip();
    if (!isDragging) document.body.style.cursor = 'default';
  });

  // ── Raycast helpers — throttle + frustum pre-filter ──────────────────────────
  // Throttle: max 10 raycasts/sec (100 ms gap). Reduces CPU from ~96k to ~500
  // intersection tests/sec at typical mouse speed.
  var _lastRaycastMs    = 0;
  var _RAYCAST_THROTTLE = 100;
  // Reusable frustum objects — allocated once, updated each raycast frame.
  var _rcFrustum    = new THREE.Frustum();
  var _rcProjMat    = new THREE.Matrix4();
  var _rcWorldPos   = new THREE.Vector3();
  var _rcMouseShift = new THREE.Vector2(); // reused for capital/country ray shifts

  // Filters multiple marker arrays down to objects actually inside the camera frustum.
  // Combining them into one call also lets intersectObjects sort by distance globally.
  function _frustumFilter(arrays) {
    _rcProjMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _rcFrustum.setFromProjectionMatrix(_rcProjMat);
    var out = [];
    arrays.forEach(function(arr) {
      if (!arr || !arr.length) return;
      for (var i = 0; i < arr.length; i++) {
        var m = arr[i];
        if (!m || !m.visible) continue;
        m.getWorldPosition(_rcWorldPos);
        if (_rcFrustum.containsPoint(_rcWorldPos)) out.push(m);
      }
    });
    return out;
  }

  // ── Hover Tooltip ────────────────────────────────────────────────────────────
  evtMgr.add(window, 'mousemove', function(e) {
    var ls = window.ArgusLayerState;

    // Bail immediately if cursor is not directly over the canvas (e.g. over a panel).
    // elementFromPoint returns the topmost element under the cursor — if it isn't the
    // renderer canvas then hover detection must not run and any live tooltip is cleared.
    var topEl = document.elementFromPoint(e.clientX, e.clientY);
    if (topEl !== renderer.domElement) {
      if (tooltip.style.display !== 'none') clearHoverTooltip();
      return;
    }

    // Throttle: skip if called within 100 ms of the last raycast pass.
    var _nowMs = performance.now();
    if (_nowMs - _lastRaycastMs < _RAYCAST_THROTTLE) return;
    _lastRaycastMs = _nowMs;

    mouseHover.x =  (e.clientX / window.innerWidth)  * 2 - 1;
    mouseHover.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycasterHover.setFromCamera(mouseHover, camera);

    // Capital + country markers use the same +24px upward ray shift for consistent hot zones.
    // NDC shift computed once; _rcMouseShift is a module-level Vector2 reused each frame.
    var _yShiftNDC = 24 / window.innerHeight * 2;

    var capitalHits = [];
    if (!ls || ls.capitals) {
      _rcMouseShift.set(mouseHover.x, mouseHover.y + _yShiftNDC);
      raycasterHover.setFromCamera(_rcMouseShift, camera);
      capitalHits = raycasterHover.intersectObjects(capitalMarkers);
      raycasterHover.setFromCamera(mouseHover, camera);
    }

    var countryHits = [];
    if (!ls || ls.countries) {
      _rcMouseShift.set(mouseHover.x, mouseHover.y + _yShiftNDC);
      raycasterHover.setFromCamera(_rcMouseShift, camera);
      raycasterHover.params.Mesh = { threshold: 0 };
      countryHits = raycasterHover.intersectObjects(window.countryHitMeshes || window.countryMarkers);
      raycasterHover.setFromCamera(mouseHover, camera);
    }

    // ── Assemble hits — frustum-filtered candidates reduce intersection tests
    // from 1,600 to typically 20-50 objects. Layer gates keep disabled layers
    // out of the candidate list entirely.
    var _candidates = _frustumFilter([
      (!ls || ls.events)      ? window.eventMarkers            : null,
      (!ls || ls.chokepoints) ? window.chokepointMarkers       : null,
      (!ls || ls.aircraft)    ? (window._aircraftMarkers || []) : null,
      (!ls || ls.vessels)     ? (window._vesselMarkers   || []) : null,
      (!ls || ls.aisVessels)  ? (window._aisSprites      || []) : null,
    ]);
    var allHits = raycasterHover.intersectObjects(_candidates)
      .concat(countryHits)
      .concat(capitalHits)
      .filter(function(h) {
        // isFacingCamera: front-hemisphere cull
        // canInteract: enforces object.visible AND parent group visible AND LayerState
        return isFacingCamera(h.object) && canInteract(h.object);
      });

    var seen   = {};
    var unique = allHits.filter(function(h) {
      var k = h.object.userData.id || h.object.userData.code || h.object.userData.label;
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    });

    if (unique.length > 0) {
      _activeHoverObj = unique[0].object;
      if (window.ArgusSelection) ArgusSelection.onHover(e.clientX, e.clientY);
      var rows = unique.map(function(h) { return buildTooltipRow(h.object.userData); }).join('');
      var hdr  = unique.length > 1 ? '<div style="color:#4a7da8;font-size:8px;letter-spacing:2px;margin-bottom:5px">' + unique.length + ' MARKERS</div>' : '';

      // Re-trigger the pop animation by swapping the node
      var wasHidden = tooltip.style.display === 'none';
      tooltip.innerHTML = hdr + rows;
      if (wasHidden) {
        tooltip.style.display = 'block';
        // Reset animation: clone → replace so @keyframes restarts cleanly
        var fresh = tooltip.cloneNode(true);
        tooltip.parentNode.replaceChild(fresh, tooltip);
        tooltip = fresh;
      }

      var sp = getDotScreenPos(unique[0].object);
      var isCapital = unique[0].object.userData && unique[0].object.userData.isCapitalCity;
      var yOffset   = isCapital ? -24 : 24;
      tooltip.style.left = Math.round(sp.x - tooltip.offsetWidth / 2) + 'px';
      tooltip.style.top  = Math.round(sp.y - tooltip.offsetHeight + yOffset) + 'px';
      document.body.style.cursor = 'pointer';
    } else {
      _activeHoverObj = null;
      // Still run screen-space hover even with no raycast hit — covers congested areas
      // where sprites are missed by 3D raycasting but visible to the user.
      if (window.ArgusSelection) ArgusSelection.onHover(e.clientX, e.clientY);
      tooltip.style.display = 'none';
      if (!isDragging) document.body.style.cursor = 'grab';
    }
  });

  // ── Click Handling ───────────────────────────────────────────────────────────
  evtMgr.add(renderer.domElement, 'click', function(e) {
    if (isDragging) return;
    var rect = renderer.domElement.getBoundingClientRect();
    mouseClick.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
    mouseClick.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
    raycasterClick.setFromCamera(mouseClick, camera);

    // ── Click targets gated by LayerState — mirrors hover assembly pattern.
    // Only layers that are ON enter the raycast; canInteract() re-validates the winner.
    var cls = window.ArgusLayerState;
    var _evTargets = []
      .concat((!cls || cls.events)      ? window.eventMarkers           : [])
      .concat((!cls || cls.aircraft)    ? window._aircraftMarkers || [] : [])
      .concat((!cls || cls.vessels)     ? window._vesselMarkers   || [] : [])
      .concat((!cls || cls.aisVessels)  ? window._aisSprites      || [] : []);
    var evHits = raycasterClick.intersectObjects(_evTargets)
      .filter(function(h) { return isFacingCamera(h.object) && canInteract(h.object); });
    if (evHits.length) {
      var _topHit = evHits[0].object;
      // Vessel/aircraft hits → always route through selection system first.
      // ArgusSelection uses screen-space search which handles dense overlap better
      // than the 3D raycaster's single nearest-in-depth winner.
      if ((_topHit.userData.isAircraft || _topHit.userData.isShip) && window.ArgusSelection) {
        if (ArgusSelection.onClick(e.clientX, e.clientY)) return;
      }
      ArgusUI.showEventDetail(_topHit.userData);
      return;
    }

    // No 3D raycast hit — sprites in congested areas can be missed entirely
    // (multiple sprites at same depth, or cursor between sprite centers).
    // Fall back to screen-space search which catches these cases.
    if (window.ArgusSelection && ((!cls || cls.aircraft) || (!cls || cls.vessels) || (!cls || cls.aisVessels))) {
      if (ArgusSelection.onClick(e.clientX, e.clientY)) return;
    }

    if (!cls || cls.chokepoints) {
      var cpHits = raycasterClick.intersectObjects(window.chokepointMarkers)
        .filter(function(h) { return isFacingCamera(h.object) && canInteract(h.object); });
      if (cpHits.length) { ArgusUI.showStaticDetail(cpHits[0].object.userData); return; }
    }

    if (!cls || cls.countries) {
      var cnHits = raycasterClick.intersectObjects(window.countryMarkers)
        .filter(function(h) { return isFacingCamera(h.object) && canInteract(h.object); });
      if (cnHits.length) { ArgusUI.showStaticDetail(cnHits[0].object.userData); return; }
    }
  });

  // ── Animation Loop ───────────────────────────────────────────────────────────
  var animT        = 0;
  var _frameLast   = 0; // timestamp of previous frame for budget sampling
  var _frameCount  = 0; // frame counter — sample every 60 frames (~1 s at 60 fps)
  function animate() {
    requestAnimationFrame(animate);
    animT += 0.016;

    // Sample frame budget every 60 frames so we detect sustained render stalls
    // without paying measurement overhead on every single frame.
    var _frameNow = performance.now();
    if (_frameLast && ++_frameCount % 60 === 0 && window.ArgusPerf) {
      ArgusPerf.record('FRAME_TIME_MS', _frameNow - _frameLast, 16.67); // 16.67 ms = 60 fps
    }
    _frameLast = _frameNow;

    // Only animate groups that are currently visible — skipping hidden groups
    // eliminates up to 84,000 no-op iterations/sec when layers are toggled off.
    if (eventMarkerGroup.visible) {
      eventMarkerGroup.children.forEach(function(obj) {
        if (obj.userData.isPulseRing) {
          obj.userData.phase += 0.04;
          obj.scale.setScalar(1 + 0.4 * Math.sin(obj.userData.phase));
          obj.material.opacity = 0.4 * (1 - Math.abs(Math.sin(obj.userData.phase)));
        }
      });
    }
    if (staticMarkerGroup.visible) {
      staticMarkerGroup.children.forEach(function(obj) {
        if (obj.userData.isPulseRingStatic) {
          obj.userData.phase += 0.028;
          obj.scale.setScalar(1 + 0.35 * Math.sin(obj.userData.phase));
          obj.material.opacity = 0.38 * (1 - Math.abs(Math.sin(obj.userData.phase)));
        }
        if (obj.userData.isStaticSpike) { obj.rotation.y += 0.016; obj.rotation.x += 0.008; }
      });
    }
    if (routeArcLines.length) {
      routeArcLines.forEach(function(line, i) {
        line.material.opacity = 0.28 + 0.14 * Math.sin(animT + i * 0.6);
      });
    }

    // ── Hover reconciliation — clear stale tooltip if hovered entity is no longer eligible
    if (_activeHoverObj && !canInteract(_activeHoverObj)) {
      clearHoverTooltip();
    }

    if (window.ArgusSelection) ArgusSelection.tick();
    renderer.render(scene, camera);
  }
  animate();

  // ── Resize Handler ───────────────────────────────────────────────────────────
  evtMgr.add(window, 'resize', function() {
    var nW = window.innerWidth;
    var nH = window.innerHeight - 62;
    camera.aspect = nW / nH;
    camera.updateProjectionMatrix();
    renderer.setSize(nW, nH);
  });

  // ── Page unload — dispose Three.js GPU resources + release GC roots ──────────
  // evtMgr.removeAll() runs first so every registered handler reference is
  // cleared before Three.js objects are disposed. Without this, live event
  // handlers closure-capture scene/renderer, keeping them alive past unload.
  // Disposing textures/geometries/materials explicitly keeps per-tab VRAM < 50 MB.
  evtMgr.add(window, 'beforeunload', function() {
    evtMgr.removeAll();
    scene.traverse(function(obj) {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) {
          obj.material.forEach(function(m) { m.dispose(); });
        } else {
          obj.material.dispose();
        }
      }
    });
    renderer.dispose();
  });

  // Expose for external access
  window.ArgusGlobe = { scene: scene, camera: camera, renderer: renderer, globe: Globe, globeGroup: globeGroup, dataGroup: dataGroup, eventMarkerGroup: eventMarkerGroup, latLonToVector: latLonToVector, R: R, clearHover: clearHoverTooltip };

  // ── Hardcoded Event Queue — FIFO bounded, max 40 ─────────────────────────────
  // Scope guard: ONLY events with source === 'HARDCODED' are tracked or evicted.
  // API events (_gdeltMarker, _unMarker, _permanentPin, _analystPin, _manualPin)
  // and user events are never touched by this module.
  window.ArgusHardcodedQueue = (function() {
    var HARDCODED_MAX = 40;

    // ── Selector — all live hardcoded meshes in window.eventMarkers ────────────
    function selectHardcoded() {
      return (window.eventMarkers || []).filter(function(m) {
        return m.userData && m.userData.source === 'HARDCODED';
      });
    }

    // ── removeById — full cleanup: mesh + companion ring + hover + node counter ─
    function removeById(id) {
      var AG = window.ArgusGlobe;
      if (!AG || !AG.eventMarkerGroup) return;

      var markers = window.eventMarkers || [];
      var mesh = null;
      for (var i = 0; i < markers.length; i++) {
        if (markers[i].userData &&
            markers[i].userData.id === id &&
            markers[i].userData.source === 'HARDCODED') {
          mesh = markers[i]; break;
        }
      }
      if (!mesh) return;

      // Setting visible=false before removal lets the animate-loop hover
      // reconciliation detect the change on the next frame and call clearHover()
      // cleanly, without needing direct access to _activeHoverObj.
      mesh.visible = false;

      // Remove companion pulse ring(s) identified by _hcMarker + position proximity
      AG.eventMarkerGroup.children.slice().forEach(function(child) {
        if (child.userData && child.userData._hcMarker &&
            child.userData.isPulseRing &&
            child.position.distanceTo(mesh.position) < 0.5) {
          AG.eventMarkerGroup.remove(child);
        }
      });

      AG.eventMarkerGroup.remove(mesh);
      window.eventMarkers = markers.filter(function(m) { return m !== mesh; });
      if (typeof window.updateNodeCounts === 'function') window.updateNodeCounts();
    }

    // ── enforceHardcodedCap — evict oldest by timestamp until under cap ────────
    function enforceHardcodedCap() {
      var hardcoded = selectHardcoded();
      if (hardcoded.length <= HARDCODED_MAX) return;
      // Oldest = smallest timestamp; fall back to array order if timestamps collide
      var oldest = hardcoded.reduce(function(min, m) {
        return m.userData.timestamp < min.userData.timestamp ? m : min;
      });
      removeById(oldest.userData.id);
    }

    // ── addHardcodedEvent — insert path with automatic cap enforcement ──────────
    // evData: { lat, lon (raw °), type, severity, title, id?, impact?, timestamp? }
    function addHardcodedEvent(evData) {
      var AG = window.ArgusGlobe;
      if (!AG || !AG.eventMarkerGroup || !AG.latLonToVector) return;

      var SEV_COL = { CRITICAL: 0xff0044, WARNING: 0xff9933, WATCH: 0xffcc00, LOW: 0x00ff88 };
      var col = SEV_COL[evData.severity] || 0xffffff;

      var pos = AG.latLonToVector(evData.lat || 0, evData.lon || 0, R.MARKER);

      var mesh = new THREE.Mesh(
        new THREE.SphereGeometry(1.68, 16, 16),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.39 })
      );
      mesh.position.copy(pos);
      mesh.userData = Object.assign({}, evData, {
        source:    'HARDCODED',
        _hcMarker: true,
        timestamp: evData.timestamp || Date.now()
      });
      // Guarantee a stable id for eviction lookups
      if (!mesh.userData.id) {
        mesh.userData.id = 'hc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
      }
      AG.eventMarkerGroup.add(mesh);
      window.eventMarkers = window.eventMarkers || [];
      window.eventMarkers.push(mesh);

      // Respect current layer toggle state
      if (window.ArgusLayerState) mesh.visible = !!window.ArgusLayerState.events;

      var ring = new THREE.Mesh(
        new THREE.RingGeometry(2.4, 3.6, 32),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
      );
      ring.position.copy(pos);
      ring.lookAt(pos.clone().normalize().multiplyScalar(200));
      ring.userData = { isPulseRing: true, phase: Math.random() * Math.PI * 2, _hcMarker: true };
      AG.eventMarkerGroup.add(ring);
      if (window.ArgusLayerState) ring.visible = !!window.ArgusLayerState.events;

      // FIFO cap — evict oldest hardcoded event if now over limit
      enforceHardcodedCap();
      if (typeof window.updateNodeCounts === 'function') window.updateNodeCounts();
    }

    return {
      addHardcodedEvent:   addHardcodedEvent,   // insert + auto-evict
      removeById:          removeById,           // explicit remove by id
      enforceHardcodedCap: enforceHardcodedCap,  // manual cap check
      selectHardcoded:     selectHardcoded,      // read-only selector
      MAX:                 HARDCODED_MAX         // 40
    };
  })();

}); // end DOMContentLoaded
})();
