'use strict';
// modules/argusGdacs.js
// GDACS global disaster intelligence overlay.
//
// Architecture:
//   GLOBAL DISASTER INTELLIGENCE OVERLAY. Not realtime telemetry. Not static infrastructure.
//   Polls /.netlify/functions/fetch-gdacs every 30 minutes.
//   Consumes the normalized ARGUS event schema from the backend ingestion pipeline.
//   Events are live disaster records — earthquakes, floods, tropical cyclones, wildfires, etc.
//   No animation loops. No continuous rerenders.
//
// Rendering:
//   Two rendering tiers:
//   1. Non-hazard events (volcano, tsunami): ghost mesh + InstancedMesh sphere.
//      Visibility tied to ArgusLayerState.events (E key).
//   2. Hazard events (earthquake, flood, drought, wildfire, tropical_cyclone):
//      Ghost mesh + animated canvas sprite (ArgusWeatherLayer marker classes).
//      tropical_cyclone → CycloneMarker (shared with NOAA NHC pathway).
//      Visibility tied to ArgusLayerState.weather (W key) — same toggle as NOAA weather.
//   Ghost meshes always live in eventMarkerGroup for raycasting. Hazard ghost mesh visibility
//   is controlled by ArgusGDACS.setVisible(), not the E key, to stay in sync with sprites.
//   Diff-based: adds new events, removes evicted ones, never full clear/recreate.
//
// Backward compat:
//   window.ArgusRW.getCountryData(iso3) — country tooltip humanitarian data
//   window._rwData — per-ISO3 disaster index (GDACS events; ReliefWeb + UNHCR via ArgusHumanitarian)
//
// Cache isolation:
//   gdacsEventCache  Map<eventId, normalizedEvent> — isolated from all other caches.
//   localStorage with 30m TTL for offline resilience / cold-start warmup.
//
// Globals:
//   window.gdacsEventCache — Map<eventId, event> per architecture spec
//   window.ArgusGDACS      — { start, stop, refresh, status, setVisible }
//   window.ArgusRW         — { getCountryData, getDisasters } (tooltip compat)
//   window._rwData         — per-ISO3 humanitarian index (GDACS disasters; shared with ArgusHumanitarian)
//
// Load order: after cache.js (window._argusReqCache) and globe init
// UNHCR displacement data is now managed by ArgusHumanitarian (SCRIPT 4b)

window.ArgusGDACS = (function () {
  'use strict';

  var GDACS_FN  = '/.netlify/functions/fetch-gdacs';
  var POLL_MS   = 30 * 60 * 1000;  // 30 minutes — matches backend cache TTL
  var CACHE_KEY = 'argus_gdacs_v1';
  var CACHE_TS  = 'argus_gdacs_ts_v1';
  var CACHE_TTL = 30 * 60 * 1000;

  // ── Isolated disaster event cache ────────────────────────────────────────────
  // Separate from acledEventCache / weatherOverlayCache / energyInfrastructureCache.
  var gdacsEventCache = new Map();

  // ── Humanitarian data index (ArgusRW compat) ─────────────────────────────────
  // Keyed by ISO3 country code. Populated from GDACS events + UNHCR displacement data.
  var _rwData = window._rwData || {};

  // ── Render state ─────────────────────────────────────────────────────────────
  var _placedIds = new Set();

  // ── Instanced visual mesh ────────────────────────────────────────────────────
  // Ghost meshes (material.visible=false) stay in eventMarkerGroup for raycasting.
  // Single InstancedMesh handles all visual rendering — 100+ draw calls → 1.
  var _imesh  = null;
  var _iDummy = new THREE.Object3D();
  var _iColor = new THREE.Color();
  var _IMAX   = 150;  // pre-allocated capacity (GDACS limit is 100 per fetch)

  // ── Hazard sprites (drought / wildfire / flood / earthquake animated canvas markers) ──
  // Managed independently of InstancedMesh. Ticked via ArgusGDACS.tick() each frame.
  var _hazardSprites = {};   // eventId → DroughtMarker | WildfireMarker | FloodMarker | EarthquakeMarker
  var _lastHazardT   = null; // for delta-time computation in tick()

  // ── Audit ────────────────────────────────────────────────────────────────────
  var _audit = { polls: 0, placed: 0, removed: 0, lastPollMs: 0, lastError: null };

  // ── Poll timer ───────────────────────────────────────────────────────────────
  var _pollTimer = null;

  // ── Disaster category → THREE.js hex color ───────────────────────────────────
  var CATEGORY_COLORS = {
    'earthquake':       0xff5500,   // orange-red — seismic
    'tropical_cyclone': 0xcc44ff,   // purple — cyclones
    'flood':            0x2299ee,   // water blue — floods
    'volcano':          0xff2200,   // deep red — volcanic
    'drought':          0xcc8800,   // amber — drought
    'wildfire':         0xff4400,   // fire orange-red — wildfires
    'tsunami':          0x00ccff,   // cyan — tsunamis
    'other':            0xff9900,   // default orange
  };

  function _categoryColor(category) {
    return CATEGORY_COLORS[category] || CATEGORY_COLORS['other'];
  }

  // ── Severity → ArgusRW legacy severity string ─────────────────────────────────
  function _toRwSev(severity) {
    if (severity === 'red')    return 'CRITICAL';
    if (severity === 'orange') return 'WARNING';
    return 'WATCH';
  }

  // ── GDACS severity → weather-layer severity (for DroughtMarker / WildfireMarker) ──
  function _mapHazardSeverity(gdacsSeverity) {
    if (gdacsSeverity === 'red')    return 'extreme';
    if (gdacsSeverity === 'orange') return 'severe';
    if (gdacsSeverity === 'green')  return 'moderate';
    return 'minor';
  }

  // ── Impact text builder ───────────────────────────────────────────────────────
  // Builds human-readable tooltip content from normalized GDACS event.
  function _buildImpact(ev) {
    var parts = [];
    var sev   = ev.severity || 'unknown';
    parts.push('Alert: ' + sev.charAt(0).toUpperCase() + sev.slice(1));

    if (ev.alertScore != null) parts.push('Score: ' + ev.alertScore.toFixed(1));

    if (ev.description) parts.push(ev.description);

    var m = ev.typeMetrics || {};
    if (m.magnitudeMetric && m.magnitudeMetric.value != null) {
      parts.push('Magnitude ' + m.magnitudeMetric.value.toFixed(1) +
        (m.magnitudeMetric.unit || 'M'));
    }
    if (m.depthMetric && m.depthMetric.value != null) {
      parts.push('Depth ' + m.depthMetric.value + 'km');
    }
    if (m.windMetric && m.windMetric.value != null) {
      parts.push('Wind ' + m.windMetric.value + 'kts');
    }
    if (m.stormClass) parts.push(m.stormClass);
    if (!m.magnitudeMetric && !m.windMetric && m.severityMetric && m.severityMetric.description) {
      parts.push(m.severityMetric.description);
    }
    if (m.populationMetric && m.populationMetric.description) {
      parts.push(m.populationMetric.description);
    }

    if (ev.affectedRegions && ev.affectedRegions.length > 0) parts.push(ev.affectedRegions[0]);
    if (ev.glide) parts.push('GLIDE: ' + ev.glide);

    return parts.join(' · ');
  }

  // ── InstancedMesh rebuild ─────────────────────────────────────────────────────
  // Called after every _renderEvents(). Builds one InstancedMesh for all GDACS events.
  // Ghost meshes above handle raycasting; _imesh handles all visual draw calls (N → 1).
  function _rebuildInstanced(AG, altR, visible) {
    if (!AG || !AG.eventMarkerGroup) return;

    if (!_imesh) {
      var geo = new THREE.SphereGeometry(1.2, 8, 8);
      var mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.80 });
      _imesh = new THREE.InstancedMesh(geo, mat, _IMAX);
      _imesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      _imesh.name          = 'ArgusGDACSInstanced';
      _imesh.frustumCulled = false;
      _imesh.count         = 0;
      _imesh.visible       = false;

      // Pre-allocate instanceColor buffer
      var cols = new Float32Array(_IMAX * 3);
      for (var ci = 0; ci < _IMAX * 3; ci++) cols[ci] = 1.0;
      _imesh.instanceColor = new THREE.InstancedBufferAttribute(cols, 3);

      AG.eventMarkerGroup.add(_imesh);
    }

    _iDummy.scale.set(0, 0, 0);
    _iDummy.position.set(0, 0, 0);
    _iDummy.rotation.set(0, 0, 0);
    _iDummy.updateMatrix();

    var n = 0;
    gdacsEventCache.forEach(function (ev) {
      if (n >= _IMAX) return;
      // Hazard categories have dedicated animated sprite markers — skip instanced sphere
      if (ev.category === 'drought'   || ev.category === 'wildfire' ||
          ev.category === 'flood'     || ev.category === 'earthquake' ||
          ev.category === 'tropical_cyclone') return;
      var pos = AG.latLonToVector(ev.lat, ev.lon, altR);
      _iDummy.position.copy(pos);
      _iDummy.scale.set(1, 1, 1);
      _iDummy.updateMatrix();
      _imesh.setMatrixAt(n, _iDummy.matrix);

      _iColor.setHex(_categoryColor(ev.category));
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

    console.log('[ArgusGDACS] instanced mesh rebuilt —', n, 'events in 1 draw call');
  }

  // ── Diff-based render ─────────────────────────────────────────────────────────
  // Removes ghost meshes for events no longer in cache; adds ghosts for new events.
  // Never clears the entire event layer — only mutates the delta.
  function _renderEvents() {
    var AG = window.ArgusGlobe;
    if (!AG || !AG.eventMarkerGroup || !AG.latLonToVector) return;
    if (!gdacsEventCache.size) return;

    var altR          = (AG.R && AG.R.MARKER) || 101;
    var visible       = !!(window.ArgusLayerState && window.ArgusLayerState.events);
    var hazardVisible = !!(window.ArgusLayerState && window.ArgusLayerState.weather);
    var _HAZARD_CATS  = { drought: 1, wildfire: 1, flood: 1, earthquake: 1, tropical_cyclone: 1 };
    var added   = 0;
    var removed = 0;

    // ── Remove ghost meshes for evicted events ──────────────────────────────────
    var toRemove = [];
    AG.eventMarkerGroup.children.forEach(function (o) {
      if (o.userData && o.userData._gdacsMarker && !gdacsEventCache.has(o.userData._gdacsId)) {
        toRemove.push(o);
      }
    });
    for (var r = 0; r < toRemove.length; r++) {
      var dead = toRemove[r];
      if (window.ArgusResourceTracker) window.ArgusResourceTracker.safeDisposeMesh(dead, 'gdacs_event');
      AG.eventMarkerGroup.remove(dead);
      _placedIds.delete(dead.userData._gdacsId);
      removed++;
    }
    if (removed > 0) {
      window.eventMarkers = (window.eventMarkers || []).filter(function (m) {
        return !(m.userData && m.userData._gdacsMarker && !gdacsEventCache.has(m.userData._gdacsId));
      });
      // Evict hazard sprites for events no longer in cache
      var hazardEvict = [];
      for (var hid in _hazardSprites) {
        if (!gdacsEventCache.has(hid)) hazardEvict.push(hid);
      }
      for (var he = 0; he < hazardEvict.length; he++) {
        _hazardSprites[hazardEvict[he]].dispose();
        delete _hazardSprites[hazardEvict[he]];
      }
    }

    // ── Add ghost meshes for new events (raycasting only — no draw calls) ───────
    // material.visible=false → zero draw calls; InstancedMesh handles non-hazard rendering.
    // Hazard events (earthquake/flood/drought/wildfire) get animated sprites instead.
    // Ghost mesh visibility: hazard events follow W (weather) state; others follow E state.
    gdacsEventCache.forEach(function (ev) {
      if (_placedIds.has(ev.eventId)) return;

      var pos = AG.latLonToVector(ev.lat, ev.lon, altR);
      var col = _categoryColor(ev.category);

      var mesh = new THREE.Mesh(
        new THREE.SphereGeometry(1.2, 8, 8),
        new THREE.MeshBasicMaterial({ color: col, visible: false })
      );
      mesh.position.copy(pos);
      // Hazard ghost meshes track W key; non-hazard ghost meshes track E key
      mesh.visible = _HAZARD_CATS[ev.category] ? hazardVisible : visible;

      mesh.userData = {
        _gdacsMarker: true,
        _gdacsId:     ev.eventId,
        type:         ev.category,
        isGDACS:      true,
        isCountry:    false,
        title:        ev.title || (ev.category + ' event'),
        impact:       _buildImpact(ev),
        source:       'GDACS',
        severity:     ev.severity,
        alertScore:   ev.alertScore,
        countryCode:  null,
      };

      AG.eventMarkerGroup.add(mesh);
      if (window.eventMarkers) window.eventMarkers.push(mesh);
      _placedIds.add(ev.eventId);
      added++;
    });

    // ── Hazard sprites (drought/wildfire/flood/earthquake/tropical_cyclone) ──────
    // Separate loop, not gated by _placedIds — checked every render cycle so late
    // ArgusWeatherLayer init is handled gracefully.
    gdacsEventCache.forEach(function (ev) {
      var isHazard = ev.category === 'drought'          || ev.category === 'wildfire' ||
                     ev.category === 'flood'            || ev.category === 'earthquake' ||
                     ev.category === 'tropical_cyclone';
      if (!isHazard || _hazardSprites[ev.eventId]) return;
      if (!AG.weatherSpriteGroup) return;
      if (!window.ArgusWeatherLayer || !window.ArgusWeatherLayer.EarthquakeMarker) return;
      var hsev  = _mapHazardSeverity(ev.severity);
      var hpos  = AG.latLonToVector(ev.lat, ev.lon, altR + 0.5);
      var hmark;
      if      (ev.category === 'drought')          hmark = new window.ArgusWeatherLayer.DroughtMarker(AG.weatherSpriteGroup, hpos, hsev);
      else if (ev.category === 'wildfire')         hmark = new window.ArgusWeatherLayer.WildfireMarker(AG.weatherSpriteGroup, hpos, hsev);
      else if (ev.category === 'earthquake')       hmark = new window.ArgusWeatherLayer.EarthquakeMarker(AG.weatherSpriteGroup, hpos, hsev);
      else if (ev.category === 'tropical_cyclone') hmark = new window.ArgusWeatherLayer.CycloneMarker(AG.weatherSpriteGroup, hpos, hsev);
      else                                          hmark = new window.ArgusWeatherLayer.FloodMarker(AG.weatherSpriteGroup, hpos, hsev, true);  // isGdacs=true → _HAZARD_SCALE
      hmark.setVisible(hazardVisible);
      _hazardSprites[ev.eventId] = hmark;
    });

    _audit.placed  += added;
    _audit.removed += removed;

    if (added > 0 || removed > 0) {
      if (typeof window.updateNodeCounts === 'function') window.updateNodeCounts();
    }

    _rebuildInstanced(AG, altR, visible);
  }

  // ── Populate ArgusRW _rwData from normalized events ───────────────────────────
  // Maintains backward compat for the country tooltip system (ArgusRW.getCountryData).
  function _populateRwData(events) {
    // Clear prior GDACS entries from _rwData (stale eviction)
    Object.keys(_rwData).forEach(function (iso3) {
      if (_rwData[iso3] && _rwData[iso3].disasters) {
        _rwData[iso3].disasters = _rwData[iso3].disasters.filter(function (d) {
          return d.source !== 'GDACS';
        });
      }
    });

    events.forEach(function (ev) {
      // ISO3 country code — from rawSourceMetadata if available
      var iso3 = null;
      var raw  = ev.rawSourceMetadata || {};
      if (raw.iso3)     iso3 = String(raw.iso3).toUpperCase();
      else if (raw.iso) iso3 = String(raw.iso).toUpperCase();

      // Fallback: scan tags for a 3-letter code that isn't an event type or alert level
      if (!iso3 && Array.isArray(ev.tags)) {
        var eventTypeCodes = { EQ:1, TC:1, FL:1, VO:1, DR:1, WF:1, TS:1 };
        var alertLevels    = { RED:1, ORANGE:1, GREEN:1, GLIDE:1 };
        for (var i = 0; i < ev.tags.length; i++) {
          var t = ev.tags[i];
          if (t && t.length === 3 && !eventTypeCodes[t] && !alertLevels[t]) {
            iso3 = t;
            break;
          }
        }
      }
      if (!iso3) return;  // cannot place in _rwData without country code

      if (!_rwData[iso3]) _rwData[iso3] = { disasters: [], sitreps: [], displaced: null, refugees: null };

      _rwData[iso3].disasters.push({
        name:   ev.title || (ev.category + ' event'),
        types:  [raw.eventtype || ev.category.toUpperCase()],
        sev:    _toRwSev(ev.severity),
        date:   ev.startTime ? ev.startTime.slice(0, 10) : '',
        lat:    ev.lat,
        lon:    ev.lon,
        url:    ev.sourceUrl || '',
        source: 'GDACS',
      });
    });
  }

  // ── Load API response into event cache (diff-aware) ───────────────────────────
  function _loadResponse(json) {
    if (!json || !Array.isArray(json.events)) return;

    var incomingIds = new Set();
    for (var i = 0; i < json.events.length; i++) {
      var ev = json.events[i];
      if (ev && ev.eventId && ev.lat != null && ev.lon != null) incomingIds.add(ev.eventId);
    }

    // Evict events absent from new response
    gdacsEventCache.forEach(function (ev, id) {
      if (!incomingIds.has(id)) gdacsEventCache.delete(id);
    });

    // Upsert new / updated events
    for (var j = 0; j < json.events.length; j++) {
      var evt = json.events[j];
      if (!evt || !evt.eventId || evt.lat == null || evt.lon == null) continue;
      gdacsEventCache.set(evt.eventId, evt);
    }

    // Sync _rwData for tooltip system
    _populateRwData(Array.from(gdacsEventCache.values()));
    // Notify ArgusHumanitarian for GLIDE cross-reference correlation
    if (window.ArgusHumanitarian && typeof window.ArgusHumanitarian._onGdacsLoad === 'function') {
      window.ArgusHumanitarian._onGdacsLoad(Array.from(gdacsEventCache.values()));
    }
  }

  // ── Poll ─────────────────────────────────────────────────────────────────────
  function _poll() {
    var reqCache = window._argusReqCache;
    if (!reqCache) return;

    _audit.polls++;

    reqCache.fetch(GDACS_FN)
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
        // Silent — GDACS is supplemental intelligence, not critical path
      });
  }

  // ── Tick ──────────────────────────────────────────────────────────────────────
  // Pool-based hazard sprites (drought/wildfire/flood/earthquake) are driven by
  // ArgusWeatherLayer.tick() via HazardTexturePool and do not need per-instance calls.
  // CycloneMarker has its own per-instance canvas textures — tick() must be called directly.
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
        setTimeout(_renderEvents, 4500);
        _pollTimer = setInterval(_poll, POLL_MS);
        return;
      }
    } catch (e) { /* corrupt cache — fall through to network */ }

    // Initial fetch deferred 75s — lowest priority in the sparse intel stack
    // (ACLED: 30s, NOAA: 45s, GEM: 60s, GDACS: 75s)
    // UNHCR displacement data is managed by ArgusHumanitarian (SCRIPT 4b)
    setTimeout(_poll, 75 * 1000);

    _pollTimer = setInterval(_poll, POLL_MS);
  }

  function stop() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }

    var AG = window.ArgusGlobe;
    if (AG && AG.eventMarkerGroup) {
      var toRemove = [];
      AG.eventMarkerGroup.children.forEach(function (o) {
        if (o.userData && o.userData._gdacsMarker) toRemove.push(o);
      });
      for (var i = 0; i < toRemove.length; i++) {
        if (window.ArgusResourceTracker) window.ArgusResourceTracker.safeDisposeMesh(toRemove[i], 'gdacs_event');
        AG.eventMarkerGroup.remove(toRemove[i]);
      }
      window.eventMarkers = (window.eventMarkers || []).filter(function (m) {
        return !(m.userData && m.userData._gdacsMarker);
      });
    }

    if (_imesh) _imesh.visible = false;
    for (var hid in _hazardSprites) { _hazardSprites[hid].dispose(); }
    _hazardSprites = {};
    gdacsEventCache.clear();
    _placedIds.clear();
  }

  function refresh() {
    _poll();
  }

  // Called by W-key (_toggleWeatherLayer) to show/hide hazard sprites + their ghost meshes.
  // Non-hazard InstancedMesh is NOT controlled here — it responds to E key separately.
  function setVisible(v) {
    var vis = !!v;
    // Animated hazard sprites (weatherSpriteGroup)
    for (var hid in _hazardSprites) { _hazardSprites[hid].setVisible(vis); }
    // Hazard ghost meshes (eventMarkerGroup) — must stay in sync with sprites
    // so hover/select always matches what the user can see.
    var hazardCats = { drought: 1, wildfire: 1, flood: 1, earthquake: 1, tropical_cyclone: 1 };
    if (window.eventMarkers) {
      window.eventMarkers.forEach(function (m) {
        if (m.userData && m.userData.isGDACS && hazardCats[m.userData.type]) {
          m.visible = vis;
        }
      });
    }
  }

  function status() {
    return {
      cacheSize:  gdacsEventCache.size,
      placed:     _placedIds.size,
      polls:      _audit.polls,
      placed:     _audit.placed,
      removed:    _audit.removed,
      lastPollMs: _audit.lastPollMs,
      lastError:  _audit.lastError,
    };
  }

  // ── Publish globals ───────────────────────────────────────────────────────────
  window.gdacsEventCache = gdacsEventCache;
  window._rwData         = _rwData;

  // ArgusRW backward compat — country tooltip system reads this
  window.ArgusRW = {
    getCountryData: function (iso3) { return _rwData[iso3] || null; },
    getDisasters:   function ()     { return _rwData; },
  };

  // Auto-start deferred one tick — allow all modules to complete init first
  setTimeout(function () {
    if (window._argusReqCache) {
      start();
    } else {
      setTimeout(function () { if (window._argusReqCache) start(); }, 3000);
    }
  }, 0);

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusGDACS');

  return { start: start, stop: stop, refresh: refresh, status: status, setVisible: setVisible, tick: tick };

}());
