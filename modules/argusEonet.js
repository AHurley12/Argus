'use strict';
// modules/argusEonet.js
// NASA EONET (Earth Observatory Natural Event Tracker) overlay.
//
// Architecture:
//   Polls /.netlify/functions/fetch-eonet every 15 minutes.
//   Each event is correlated against GDACS and NOAA via ArgusEventCorrelation.
//   Correlated events: existing marker enriched with EONET source attribution — no new marker.
//   Unique events: ghost mesh + InstancedMesh (non-hazard) or animated sprite (hazard).
//
// Rendering — ALL EONET events follow the W key (weather toggle):
//   Animated-sprite tier (wildfire / earthquake / flood / drought / tropical_cyclone):
//     Ghost mesh (eventMarkerGroup, raycasting) + animated sprite (weatherSpriteGroup).
//     tropical_cyclone → CycloneMarker (same sprite class as NOAA NHC + GDACS cyclones).
//   InstancedMesh tier (volcano / tsunami / sea_ice / dust_haze / etc.):
//     Ghost mesh (eventMarkerGroup, raycasting) + InstancedMesh sphere.
//   Both tiers: Visibility controlled by ArgusEONET.setVisible(wOn) via W key.
//   EONET does NOT respond to the E key — all content is environmental/disaster data.
//
// Deferred start: 90 seconds — intentionally after GDACS (75s) so correlation
//   has live GDACS data to compare against before the first EONET render pass.
//
// Cache:
//   eonetEventCache Map<id, normalizedEvent> — isolated from all other source caches.
//   localStorage 15m TTL for cold-start warmup.
//
// Globals:
//   window.eonetEventCache — Map<id, event>
//   window.ArgusEONET      — { start, stop, refresh, status, setVisible, setEventsVisible,
//                              tick, diagReport }
//
// Dependencies (globals):
//   window.THREE, window.ArgusGlobe, window.ArgusWeatherLayer
//   window.ArgusEventCorrelation, window.ArgusLayerState, window._argusReqCache
//   window.eventMarkers, window.ArgusResourceTracker, window.ArgusModuleAudit

window.ArgusEONET = (function () {
  'use strict';

  // ── Config ─────────────────────────────────────────────────────────────────
  var EONET_FN  = '/.netlify/functions/fetch-eonet';
  var POLL_MS   = 15 * 60 * 1000;  // 15 minutes — matches NOAA cadence
  var CACHE_KEY = 'argus_eonet_v1';
  var CACHE_TS  = 'argus_eonet_ts_v1';
  var CACHE_TTL = 15 * 60 * 1000;

  // ── State ──────────────────────────────────────────────────────────────────
  var eonetEventCache = new Map();  // id → normalizedEvent
  var _placedIds      = new Set();  // ids whose ghost meshes are in eventMarkerGroup
  var _pollTimer      = null;

  // ── Tick state ────────────────────────────────────────────────────────────
  var _lastHazardT = null;

  // ── InstancedMesh (non-hazard events) ─────────────────────────────────────
  var _imesh  = null;
  var _iDummy = new THREE.Object3D();
  var _iColor = new THREE.Color();
  var _IMAX   = 200;  // EONET typically returns 50–150 open events

  // ── Hazard sprites (wildfire / earthquake / flood / drought) ───────────────
  // Reuses ArgusWeatherLayer marker classes — same animated canvas sprites as GDACS.
  var _hazardSprites = {};  // id → WildfireMarker | EarthquakeMarker | FloodMarker | DroughtMarker

  // ── Diagnostics ────────────────────────────────────────────────────────────
  var _audit = {
    polls:               0,
    fetched:             0,
    normalized:          0,
    correlated:          0,
    duplicatesPrevented: 0,
    rendered:            0,
    removed:             0,
    lastPollMs:          0,
    lastError:           null,
  };

  // ── Category constants ─────────────────────────────────────────────────────
  // Hazard categories: animated sprites, W key visibility — mirrors GDACS split.
  // tropical_cyclone uses CycloneMarker (same as GDACS + NOAA NHC pathway).
  var _HAZARD_CATS = { wildfire: 1, earthquake: 1, flood: 1, drought: 1, tropical_cyclone: 1 };

  // Non-unique EONET categories that may overlap GDACS (handled by correlation)
  // Listed here for reference only — actual dedup logic lives in argusEventCorrelation.js.
  // 'sea_ice', 'dust_haze', 'landslide', 'snow', 'temperature', 'water_color', 'manmade'
  // have no known overlap and always render as unique EONET markers.

  // Category → hex color
  var _COLORS = {
    wildfire:         0xff4400,   // fire orange-red
    earthquake:       0xff5500,   // seismic orange-red
    flood:            0x2299ee,   // water blue
    drought:          0xcc8800,   // amber
    volcano:          0xff2200,   // deep red
    tropical_cyclone: 0xcc44ff,   // purple
    tsunami:          0x00ccff,   // cyan
    sea_ice:          0x88ddff,   // ice blue
    dust_haze:        0xccaa55,   // sandy
    landslide:        0xaa7733,   // earthy brown
    snow:             0xddeeff,   // pale blue-white
    temperature:      0xff8833,   // amber-orange
    water_color:      0x00ccaa,   // teal
    manmade:          0xff9900,   // default orange
  };

  function _color(cat) {
    return _COLORS[cat] || _COLORS.manmade;
  }

  // EONET severity → ArgusWeatherLayer severity string
  function _hazardSeverity(ev) {
    var s = ev.severity || 'moderate';
    if (s === 'extreme') return 'extreme';
    if (s === 'severe')  return 'severe';
    if (s === 'minor')   return 'minor';
    return 'moderate';
  }

  // ── Impact text for tooltip ────────────────────────────────────────────────
  function _buildImpact(ev) {
    var parts = [];
    var sev = ev.severity || 'moderate';
    parts.push('Severity: ' + sev.charAt(0).toUpperCase() + sev.slice(1));
    if (ev.magnitude != null) {
      parts.push('Mag ' + ev.magnitude + (ev.magnitudeUnit || ''));
    }
    if (ev.timestamp) parts.push(ev.timestamp.slice(0, 10));
    if (Array.isArray(ev.sources) && ev.sources.length > 0) {
      parts.push('Via: ' + ev.sources.map(function (s) { return s.id; }).join(', '));
    }
    return parts.join(' · ');
  }

  // ── InstancedMesh rebuild ──────────────────────────────────────────────────
  // One draw call for all non-hazard EONET events.
  // Correlated events are excluded — they are rendered by their source module.
  function _rebuildInstanced(AG, altR, visible) {
    if (!AG || !AG.eventMarkerGroup) return;

    if (!_imesh) {
      var geo = new THREE.SphereGeometry(1.2, 8, 8);
      var mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.80 });
      _imesh = new THREE.InstancedMesh(geo, mat, _IMAX);
      _imesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      _imesh.name          = 'ArgusEONETInstanced';
      _imesh.frustumCulled = false;
      _imesh.count         = 0;
      _imesh.visible       = false;

      var cols = new Float32Array(_IMAX * 3);
      for (var ci = 0; ci < _IMAX * 3; ci++) cols[ci] = 1.0;
      _imesh.instanceColor = new THREE.InstancedBufferAttribute(cols, 3);

      AG.eventMarkerGroup.add(_imesh);
    }

    // Zero all slots before rebuilding
    _iDummy.scale.set(0, 0, 0);
    _iDummy.position.set(0, 0, 0);
    _iDummy.rotation.set(0, 0, 0);
    _iDummy.updateMatrix();

    var n = 0;
    eonetEventCache.forEach(function (ev) {
      if (n >= _IMAX)           return;
      if (_HAZARD_CATS[ev.category]) return;  // animated sprites handle these
      if (ev._correlated)       return;       // rendered by the correlated source

      var pos = AG.latLonToVector(ev.lat, ev.lon, altR);
      _iDummy.position.copy(pos);
      _iDummy.scale.set(1, 1, 1);
      _iDummy.updateMatrix();
      _imesh.setMatrixAt(n, _iDummy.matrix);

      _iColor.setHex(_color(ev.category));
      var off = n * 3;
      _imesh.instanceColor.array[off]     = _iColor.r;
      _imesh.instanceColor.array[off + 1] = _iColor.g;
      _imesh.instanceColor.array[off + 2] = _iColor.b;
      n++;
    });

    _imesh.count = n;
    _imesh.instanceMatrix.needsUpdate = true;
    _imesh.instanceColor.needsUpdate  = true;
    _imesh.visible = !!(visible && n > 0);

    if (n > 0) {
      console.log('[ArgusEONET] instanced mesh rebuilt —', n, 'unique non-hazard events');
    }
  }

  // ── Diff-based render ──────────────────────────────────────────────────────
  // Adds ghost meshes for new unique events, removes ghosts for evicted events.
  // Never clears and recreates the full layer — only mutates the delta.
  function _renderEvents() {
    var AG = window.ArgusGlobe;
    if (!AG || !AG.eventMarkerGroup || !AG.latLonToVector) return;
    if (!eonetEventCache.size) return;

    var altR          = (AG.R && AG.R.MARKER) || 101;
    var evVisible     = !!(window.ArgusLayerState && window.ArgusLayerState.events);
    var hazardVisible = !!(window.ArgusLayerState && window.ArgusLayerState.weather);
    var added         = 0;
    var removed       = 0;

    // ── Remove ghost meshes for events no longer in cache ────────────────────
    var toRemove = [];
    AG.eventMarkerGroup.children.forEach(function (o) {
      if (o.userData && o.userData._eonetMarker &&
          !eonetEventCache.has(o.userData._eonetId)) {
        toRemove.push(o);
      }
    });
    for (var r = 0; r < toRemove.length; r++) {
      var dead = toRemove[r];
      if (window.ArgusResourceTracker) {
        window.ArgusResourceTracker.safeDisposeMesh(dead, 'eonet_event');
      }
      AG.eventMarkerGroup.remove(dead);
      _placedIds.delete(dead.userData._eonetId);
      removed++;
    }

    if (removed > 0) {
      window.eventMarkers = (window.eventMarkers || []).filter(function (m) {
        return !(m.userData && m.userData._eonetMarker &&
                 !eonetEventCache.has(m.userData._eonetId));
      });
      // Dispose hazard sprites for removed events
      var toDisposeSprites = [];
      for (var hid in _hazardSprites) {
        if (!eonetEventCache.has(hid)) toDisposeSprites.push(hid);
      }
      for (var d = 0; d < toDisposeSprites.length; d++) {
        _hazardSprites[toDisposeSprites[d]].dispose();
        delete _hazardSprites[toDisposeSprites[d]];
      }
    }

    // ── Add ghost meshes for new unique events ────────────────────────────────
    // material.visible=false — ghost mesh is invisible; InstancedMesh or sprite
    // handles visual rendering. Ghost enables raycasting for hover/click/tooltip.
    eonetEventCache.forEach(function (ev) {
      if (_placedIds.has(ev.id)) return;
      if (ev._correlated)        return;  // duplicate — do not render separately

      var pos = AG.latLonToVector(ev.lat, ev.lon, altR);
      var col = _color(ev.category);

      var mesh = new THREE.Mesh(
        new THREE.SphereGeometry(1.2, 8, 8),
        new THREE.MeshBasicMaterial({ color: col, visible: false })
      );
      mesh.position.copy(pos);
      // ALL EONET ghosts follow W key — EONET is an environmental/disaster source
      mesh.visible = hazardVisible;

      mesh.userData = {
        _eonetMarker: true,
        _eonetId:     ev.id,
        type:         ev.category,
        isEONET:      true,
        isCountry:    false,
        title:        ev.title,
        impact:       _buildImpact(ev),
        source:       'EONET',
        sources:      ['EONET'],
        severity:     ev.severity,
        link:         ev.link,
        eonetMeta: {
          id:            ev.id,
          link:          ev.link,
          sources:       ev.sources,
          timestamp:     ev.timestamp,
          magnitude:     ev.magnitude,
          magnitudeUnit: ev.magnitudeUnit,
        },
      };

      AG.eventMarkerGroup.add(mesh);
      if (window.eventMarkers) window.eventMarkers.push(mesh);
      _placedIds.add(ev.id);
      added++;
      _audit.rendered++;
    });

    // ── Hazard animated sprites (second pass, separate from _placedIds) ───────
    // Checked every render cycle so late ArgusWeatherLayer init is handled gracefully.
    eonetEventCache.forEach(function (ev) {
      if (!_HAZARD_CATS[ev.category]) return;
      if (ev._correlated)             return;
      if (_hazardSprites[ev.id])      return;  // already created
      if (!AG.weatherSpriteGroup)     return;
      if (!window.ArgusWeatherLayer || !window.ArgusWeatherLayer.EarthquakeMarker) return;

      var hsev  = _hazardSeverity(ev);
      var hpos  = AG.latLonToVector(ev.lat, ev.lon, altR + 0.5);
      var hmark;
      if      (ev.category === 'wildfire')         hmark = new window.ArgusWeatherLayer.WildfireMarker(AG.weatherSpriteGroup, hpos, hsev);
      else if (ev.category === 'earthquake')       hmark = new window.ArgusWeatherLayer.EarthquakeMarker(AG.weatherSpriteGroup, hpos, hsev);
      else if (ev.category === 'flood')            hmark = new window.ArgusWeatherLayer.FloodMarker(AG.weatherSpriteGroup, hpos, hsev, true);
      else if (ev.category === 'tropical_cyclone') hmark = new window.ArgusWeatherLayer.CycloneMarker(AG.weatherSpriteGroup, hpos, hsev);
      else                                          hmark = new window.ArgusWeatherLayer.DroughtMarker(AG.weatherSpriteGroup, hpos, hsev);

      hmark.setVisible(hazardVisible);
      _hazardSprites[ev.id] = hmark;
    });

    _audit.removed += removed;

    if (added > 0 || removed > 0) {
      if (typeof window.updateNodeCounts === 'function') window.updateNodeCounts();
    }

    _rebuildInstanced(AG, altR, hazardVisible);
  }

  // ── Load response into cache (diff-aware + correlation) ───────────────────
  function _loadResponse(json) {
    if (!json || !Array.isArray(json.events)) return;

    var correlation = window.ArgusEventCorrelation;
    var incomingIds = new Set();

    for (var i = 0; i < json.events.length; i++) {
      var ev = json.events[i];
      if (ev && ev.id && ev.lat != null && ev.lon != null) incomingIds.add(ev.id);
    }

    // Evict events no longer in the EONET open-events response
    eonetEventCache.forEach(function (ev, id) {
      if (!incomingIds.has(id)) eonetEventCache.delete(id);
    });

    // Upsert with correlation check
    for (var j = 0; j < json.events.length; j++) {
      var evt = json.events[j];
      if (!evt || !evt.id || evt.lat == null || evt.lon == null) continue;

      if (correlation) {
        var result = correlation.checkAndEnrich(evt);
        evt._correlated     = result.isDuplicate;
        evt._correlatedWith = result.matchedSource || null;
        evt._confidence     = result.confidence   || 0;
        if (result.isDuplicate) {
          _audit.correlated++;
          _audit.duplicatesPrevented++;
        }
      } else {
        evt._correlated = false;
      }

      eonetEventCache.set(evt.id, evt);
    }

    _audit.normalized = eonetEventCache.size;
    _audit.fetched    = json.count || json.events.length;
  }

  // ── Poll ──────────────────────────────────────────────────────────────────
  function _poll() {
    var reqCache = window._argusReqCache;
    if (!reqCache) return;

    _audit.polls++;

    reqCache.fetch(EONET_FN)
      .then(function (json) {
        _audit.lastPollMs = Date.now();
        _audit.lastError  = null;
        if (json && json.disabled) return;

        _loadResponse(json);

        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify(json));
          localStorage.setItem(CACHE_TS,  String(Date.now()));
        } catch (e) { /* localStorage full */ }

        _renderEvents();
      })
      .catch(function (err) {
        _audit.lastError = err.message;
        // Silent — EONET is supplemental, not critical path
      });
  }

  // ── Start ─────────────────────────────────────────────────────────────────
  function start() {
    if (_pollTimer) return;

    // Warm from localStorage if cache is fresh
    try {
      var cached = localStorage.getItem(CACHE_KEY);
      var ts     = parseInt(localStorage.getItem(CACHE_TS) || '0');
      if (cached && Date.now() - ts < CACHE_TTL) {
        _loadResponse(JSON.parse(cached));
        // Render deferred 5s — globe must be ready and correlation caches must exist
        setTimeout(_renderEvents, 5000);
        _pollTimer = setInterval(_poll, POLL_MS);
        return;
      }
    } catch (e) { /* corrupt cache — fall through to network */ }

    // Initial fetch at 90s — intentionally after GDACS (75s) so correlation has
    // live GDACS data before EONET compares against it.
    setTimeout(_poll, 90 * 1000);
    _pollTimer = setInterval(_poll, POLL_MS);
  }

  // ── Stop ──────────────────────────────────────────────────────────────────
  function stop() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }

    var AG = window.ArgusGlobe;
    if (AG && AG.eventMarkerGroup) {
      var toRemove = [];
      AG.eventMarkerGroup.children.forEach(function (o) {
        if (o.userData && o.userData._eonetMarker) toRemove.push(o);
      });
      for (var i = 0; i < toRemove.length; i++) {
        if (window.ArgusResourceTracker) {
          window.ArgusResourceTracker.safeDisposeMesh(toRemove[i], 'eonet_event');
        }
        AG.eventMarkerGroup.remove(toRemove[i]);
      }
      window.eventMarkers = (window.eventMarkers || []).filter(function (m) {
        return !(m.userData && m.userData._eonetMarker);
      });
    }

    if (_imesh) _imesh.visible = false;
    for (var hid in _hazardSprites) { _hazardSprites[hid].dispose(); }
    _hazardSprites = {};
    eonetEventCache.clear();
    _placedIds.clear();
  }

  function refresh() { _poll(); }

  // ── Visibility ────────────────────────────────────────────────────────────
  // setVisible(wOn) — W key: controls ALL EONET markers (sprites + InstancedMesh + ghosts).
  // All EONET content is environmental/disaster data — it lives on the weather toggle.
  function setVisible(wOn) {
    var vis = !!wOn;
    // Hazard animated sprites
    for (var hid in _hazardSprites) { _hazardSprites[hid].setVisible(vis); }
    // Non-hazard InstancedMesh
    if (_imesh) _imesh.visible = !!(vis && _imesh.count > 0);
    // All EONET ghost meshes
    if (window.eventMarkers) {
      window.eventMarkers.forEach(function (m) {
        if (m.userData && m.userData.isEONET) m.visible = vis;
      });
    }
  }

  // setEventsVisible — no-op. EONET does not respond to the E key.
  // Kept for API stability only.
  function setEventsVisible() {}

  // Tick — pool-based hazard sprites are driven by ArgusWeatherLayer.tick().
  // CycloneMarker has per-instance canvas textures and requires direct tick() calls.
  function tick() {
    var now = Date.now();
    var dt  = _lastHazardT ? Math.min((now - _lastHazardT) / 1000, 0.1) : 0.016;
    _lastHazardT = now;
    var AG     = window.ArgusGlobe;
    var camPos = AG && AG.camera ? AG.camera.position : null;
    var LOD    = 350;
    for (var id in _hazardSprites) {
      var m = _hazardSprites[id];
      if (!m || !m.tick) continue;
      if (camPos && m.group && m.group.position.distanceTo(camPos) > LOD) continue;
      m.tick(dt);
    }
  }

  // ── Status ────────────────────────────────────────────────────────────────
  function status() {
    return {
      cacheSize:           eonetEventCache.size,
      placed:              _placedIds.size,
      polls:               _audit.polls,
      fetched:             _audit.fetched,
      normalized:          _audit.normalized,
      correlated:          _audit.correlated,
      duplicatesPrevented: _audit.duplicatesPrevented,
      rendered:            _audit.rendered,
      removed:             _audit.removed,
      lastPollMs:          _audit.lastPollMs,
      lastError:           _audit.lastError,
    };
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────
  function diagReport() {
    var s = status();
    console.group('%c[ArgusEONET Diagnostic]', 'color:#00ff88;font-weight:bold');
    console.log('── Ingestion ──────────────────────────────────────────');
    console.log('  EONET fetched         :', s.fetched);
    console.log('  Normalized (cache)    :', s.normalized);
    console.log('  Correlated (dupes)    :', s.correlated);
    console.log('  Duplicate markers     :', s.duplicatesPrevented);
    console.log('  Unique rendered       :', s.rendered);
    console.log('  Events removed        :', s.removed);
    console.log('── State ──────────────────────────────────────────────');
    console.log('  Cache size            :', s.cacheSize);
    console.log('  Placed ghosts         :', s.placed);
    console.log('  Poll count            :', s.polls);
    console.log('  Last poll             :', s.lastPollMs
      ? new Date(s.lastPollMs).toISOString() : 'never');
    console.log('  Last error            :', s.lastError || 'none');
    console.log('── Category breakdown ─────────────────────────────────');
    var cats  = {};
    var corrN = 0;
    eonetEventCache.forEach(function (ev) {
      cats[ev.category] = (cats[ev.category] || 0) + 1;
      if (ev._correlated) corrN++;
    });
    Object.keys(cats).sort().forEach(function (c) {
      console.log('  ' + c + ':', cats[c]);
    });
    console.log('  Correlated (hidden)   :', corrN);
    console.groupEnd();
    if (window.ArgusEventCorrelation) window.ArgusEventCorrelation.diagReport();
  }

  // ── Publish globals ───────────────────────────────────────────────────────
  window.eonetEventCache = eonetEventCache;

  // Auto-start — deferred one tick so all prior modules finish initializing
  setTimeout(function () {
    if (window._argusReqCache) {
      start();
    } else {
      setTimeout(function () { if (window._argusReqCache) start(); }, 3000);
    }
  }, 0);

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusEONET');

  return {
    start:             start,
    stop:              stop,
    refresh:           refresh,
    status:            status,
    setVisible:        setVisible,       // W key — all EONET markers
    setEventsVisible:  setEventsVisible, // no-op — EONET is weather-only
    tick:              tick,
    diagReport:        diagReport,
  };

}());
