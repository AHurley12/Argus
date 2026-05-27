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
//   Ghost meshes (material.visible=false) in eventMarkerGroup for raycasting/hover/click.
//   Single InstancedMesh handles all visual draw calls — up to 150 events in 1 draw call.
//   Color-coded by disaster category. Visibility tied to window.ArgusLayerState.events.
//   Diff-based: adds new events, removes evicted ones, never full clear/recreate.
//
// Backward compat:
//   window.ArgusRW.getCountryData(iso3) — country tooltip humanitarian data
//   window._rwData — per-ISO3 disaster index (populated from GDACS events + UNHCR)
//
// Cache isolation:
//   gdacsEventCache  Map<eventId, normalizedEvent> — isolated from all other caches.
//   localStorage with 30m TTL for offline resilience / cold-start warmup.
//
// Globals:
//   window.gdacsEventCache — Map<eventId, event> per architecture spec
//   window.ArgusGDACS      — { start, stop, refresh, status, setVisible }
//   window.ArgusRW         — { getCountryData, getDisasters } (tooltip compat)
//   window._rwData         — per-ISO3 UN humanitarian index
//
// Load order: after cache.js (window._argusReqCache) and globe init

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

  // ── Hazard sprites (drought / wildfire animated canvas markers) ──────────────
  // Managed independently of InstancedMesh. Ticked via ArgusGDACS.tick() each frame.
  var _hazardSprites = {};   // eventId → DroughtMarker | WildfireMarker
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
      // Drought + wildfire have dedicated animated sprite markers — skip instanced sphere
      if (ev.category === 'drought' || ev.category === 'wildfire') return;
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

    var altR    = (AG.R && AG.R.MARKER) || 101;
    var visible = !!(window.ArgusLayerState && window.ArgusLayerState.events);
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
    // material.visible=false → zero draw calls; InstancedMesh handles all rendering.
    gdacsEventCache.forEach(function (ev) {
      if (_placedIds.has(ev.eventId)) return;

      var pos = AG.latLonToVector(ev.lat, ev.lon, altR);
      var col = _categoryColor(ev.category);

      var mesh = new THREE.Mesh(
        new THREE.SphereGeometry(1.2, 8, 8),
        new THREE.MeshBasicMaterial({ color: col, visible: false })
      );
      mesh.position.copy(pos);
      mesh.visible = visible;  // ghost mesh controls raycasting visibility only

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

    // ── Hazard sprites (drought/wildfire) — separate loop, not gated by _placedIds ──
    // Checked every render cycle so late ArgusWeatherLayer init is handled gracefully.
    gdacsEventCache.forEach(function (ev) {
      var isHazard = ev.category === 'drought' || ev.category === 'wildfire';
      if (!isHazard || _hazardSprites[ev.eventId]) return;
      if (!AG.weatherSpriteGroup) return;
      if (!window.ArgusWeatherLayer || !window.ArgusWeatherLayer.DroughtMarker) return;
      var hsev  = _mapHazardSeverity(ev.severity);
      var hpos  = AG.latLonToVector(ev.lat, ev.lon, altR + 0.5);
      var hmark = ev.category === 'drought'
        ? new window.ArgusWeatherLayer.DroughtMarker(AG.weatherSpriteGroup, hpos, hsev)
        : new window.ArgusWeatherLayer.WildfireMarker(AG.weatherSpriteGroup, hpos, hsev);
      hmark.setVisible(visible);
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
  }

  // ── UNHCR displacement fetch ──────────────────────────────────────────────────
  // Secondary fetch — enriches _rwData with displacement figures for country tooltips.
  // Failure is silent — displacement data is supplementary, not critical path.
  function _fetchUnhcr() {
    fetch('https://api.unhcr.org/population/v1/population/?limit=300&dataset=population' +
      '&displayType=totals&columns[]=refugees&columns[]=idps&yearFrom=2023&yearTo=2023&coa_all=true')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (json) {
        if (!json || !json.items) return;
        json.items.forEach(function (row) {
          var iso = (row.coa_iso || '').toUpperCase();
          if (!iso) return;
          if (!_rwData[iso]) _rwData[iso] = { disasters: [], sitreps: [], displaced: null, refugees: null };
          var refs = parseInt(row.refugees) || 0;
          var idps = parseInt(row.idps)     || 0;
          if (refs > 0) _rwData[iso].refugees  = refs;
          if (idps > 0) _rwData[iso].displaced = idps;
        });
        console.log('[ArgusGDACS] UNHCR: displacement indexed for',
          json.items.length, 'countries');
      })
      .catch(function (e) {
        console.warn('[ArgusGDACS] UNHCR fetch failed (non-critical):', e.message);
      });
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

  // ── Tick: advance hazard sprite canvas animations ─────────────────────────────
  // Called every frame from the master animate loop in index.html.
  // Operates independently of ArgusLayerState.weather — drought/wildfire are GDACS
  // events, not NOAA alerts, and must animate whenever the event layer is visible.
  function tick() {
    if (!Object.keys(_hazardSprites).length) return;
    var now = performance.now();
    var dt  = _lastHazardT !== null ? Math.min((now - _lastHazardT) / 1000, 0.1) : 0.016;
    _lastHazardT = now;

    var AG     = window.ArgusGlobe;
    var camPos = AG && AG.camera ? AG.camera.position : null;

    for (var hid in _hazardSprites) {
      var hm = _hazardSprites[hid];
      if (!hm || !hm.sprite || !hm.sprite.parent) continue;
      // LOD: skip redraws for sprites far from camera (matches weather layer threshold)
      if (camPos && hm.sprite.position.distanceTo(camPos) > 350) continue;
      hm.tick(dt);
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
    setTimeout(_poll, 75 * 1000);

    // UNHCR enrichment deferred 90s — fires once after GDACS data is in
    setTimeout(_fetchUnhcr, 90 * 1000);

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

  // Called by index.html event layer toggles (E key, modal close) to show/hide
  // the InstancedMesh. Ghost meshes are managed via window.eventMarkers.forEach().
  function setVisible(v) {
    if (_imesh) _imesh.visible = !!v;
    for (var hid in _hazardSprites) {
      _hazardSprites[hid].setVisible(!!v);
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
