'use strict';
// modules/argusGem.js
// Energy Infrastructure Intelligence Layer — unified ingestion pipeline.
//
// Architecture:
//   STATIC INFRASTRUCTURE INTELLIGENCE. Not realtime. Not event-driven.
//   Covers: coal, nuclear, hydro, wind, lng (+ pipeline, solar, oil, gas).
//   Changes rarely — treated as persistent strategic reference data.
//
//   Fetches once on startup (or when cache is stale). Refreshes daily.
//   No polling loops after initial load. No animation. No rerenders.
//
// Visibility:
//   Controlled by window.ArgusLayerState.energy — INDEPENDENT of the
//   E-key event layer (ACLED/GDACS). Energy infra is not event data.
//   Per-type filtering (coal/nuclear/hydro/wind/lng) via setTypeFilter().
//
// Cache:
//   window.energyInfrastructureCache  Map<infraId, EnergyAsset>
//   localStorage with 24h TTL.
//
// Globals:
//   window.energyInfrastructureCache — Map<id, EnergyAsset>
//   window.ArgusGEM                  — { start, stop, refresh, status, setVisible, setTypeFilter, getCountryEnergy }

window.ArgusGEM = (function () {
  'use strict';

  var GEM_FN     = '/.netlify/functions/fetch-gem';
  var CACHE_KEY  = 'argus_gem_v3';
  var CACHE_TS   = 'argus_gem_ts_v3';
  var CACHE_TTL  = 24 * 60 * 60 * 1000;
  var REFRESH_MS = 24 * 60 * 60 * 1000;

  // ── Isolated infrastructure cache ────────────────────────────────────────────
  // Each entry conforms to the EnergyAsset schema:
  //   { id, name, type, country, lat, lon, capacityMW, status, source, _canonType }
  var energyInfrastructureCache = new Map();

  // ── Render state ─────────────────────────────────────────────────────────────
  var _placedIds    = new Set();
  var _rendered     = false;
  var _energyOn     = false;   // mirrors ArgusLayerState.energy

  // ── Per-type filter ───────────────────────────────────────────────────────────
  // Only the 5 canonical types are filterable. Other types (pipeline, solar, oil)
  // always render when the layer is on.
  var _activeTypes = new Set(['coal', 'nuclear', 'hydro', 'wind', 'lng', 'gas', 'solar']);

  // ── Instanced visual mesh ─────────────────────────────────────────────────────
  var _imesh  = null;
  var _iDummy = new THREE.Object3D();
  var _iColor = new THREE.Color();
  var _IMAX   = 3000;

  // ── Audit ────────────────────────────────────────────────────────────────────
  var _audit = { fetches: 0, placed: 0, lastFetchMs: 0, lastError: null };

  // ── Refresh timer ─────────────────────────────────────────────────────────────
  var _refreshTimer = null;

  // ── Type → color ──────────────────────────────────────────────────────────────
  // Canonical color spec:
  //   nuclear → purple   lng → grey    gas → white   coal → dark grey
  //   wind    → white    hydro → light blue           solar → yellow
  var TYPE_COLORS = {
    'lng':            0x999999,  // grey
    'lng terminal':   0x999999,  // grey
    'pipeline':       0xcccccc,  // light grey (infrastructure)
    'gas':            0xffffff,  // white
    'power':          0xffee00,
    'coal':           0x555555,  // dark grey
    'oil':            0xff8800,
    'nuclear':        0xcc44ff,  // purple
    'solar':          0xffdd00,  // yellow
    'wind':           0xeeeeee,  // off-white (distinct from gas pure white)
    'hydro':          0x44aaff,  // light blue
    'infrastructure': 0x88aacc,
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

  // ── Canonical type normalization ──────────────────────────────────────────────
  // Maps raw GEM type strings → filterable canonical type, or null.
  function _canonicalType(raw) {
    var t = (raw || '').toLowerCase();
    if (t.indexOf('lng') >= 0)   return 'lng';     // lng before gas (lng contains no "gas")
    if (t.indexOf('coal') >= 0)  return 'coal';
    if (t.indexOf('nuclear') >= 0 || t.indexOf('atom') >= 0) return 'nuclear';
    if (t.indexOf('hydro') >= 0) return 'hydro';
    if (t.indexOf('wind') >= 0)  return 'wind';
    if (t.indexOf('solar') >= 0) return 'solar';
    if (t.indexOf('gas') >= 0)   return 'gas';
    return null;  // pipeline, oil, power, etc. — non-filterable, always shown when layer on
  }

  // ── Capacity normalization to MW ──────────────────────────────────────────────
  function _toCapacityMW(infra) {
    var cap = parseFloat(infra.capacity);
    if (isNaN(cap) || cap <= 0) return null;
    var unit = (infra.unit || '').toLowerCase();
    if (unit.indexOf('gw') >= 0) return cap * 1000;
    return cap;  // assume MW if no unit or unit is MW/other
  }

  // ── Type-filter visibility check ──────────────────────────────────────────────
  function _isTypeVisible(canonType) {
    if (!canonType) return true;  // non-filterable types always shown when layer is on
    return _activeTypes.has(canonType);
  }

  // ── InstancedMesh rebuild ──────────────────────────────────────────────────────
  function _rebuildInstanced(AG, altR) {
    if (!AG || !AG.eventMarkerGroup) return;

    if (!_imesh) {
      var geo = new THREE.BoxGeometry(0.9, 0.9, 0.9);
      var mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.70 });
      _imesh = new THREE.InstancedMesh(geo, mat, _IMAX);
      _imesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      _imesh.name          = 'ArgusGEMInstanced';
      _imesh.frustumCulled = false;
      _imesh.count         = 0;
      _imesh.visible       = false;

      var cols = new Float32Array(_IMAX * 3);
      for (var ci = 0; ci < _IMAX * 3; ci++) cols[ci] = 1.0;
      _imesh.instanceColor = new THREE.InstancedBufferAttribute(cols, 3);

      AG.eventMarkerGroup.add(_imesh);
    }

    // Zero-scale dummy for unused / filtered-out slots
    _iDummy.scale.set(0, 0, 0);
    _iDummy.position.set(0, 0, 0);
    _iDummy.rotation.set(0, 0, 0);
    _iDummy.updateMatrix();
    var zeroMat = _iDummy.matrix;

    var n = 0;
    energyInfrastructureCache.forEach(function (infra) {
      if (n >= _IMAX) return;

      // Respect per-type filter — zero-scale hidden types rather than skip
      // so instance indices stay stable and count remains accurate.
      if (_energyOn && _isTypeVisible(infra._canonType)) {
        var pos = AG.latLonToVector(infra.lat, infra.lon, altR);
        _iDummy.position.copy(pos);
        _iDummy.scale.set(1, 1, 1);
        _iDummy.updateMatrix();
        _imesh.setMatrixAt(n, _iDummy.matrix);

        _iColor.setHex(_infraColor(infra.type));
        var off = n * 3;
        _imesh.instanceColor.array[off]     = _iColor.r;
        _imesh.instanceColor.array[off + 1] = _iColor.g;
        _imesh.instanceColor.array[off + 2] = _iColor.b;
      } else {
        _imesh.setMatrixAt(n, zeroMat);
      }
      n++;
    });

    _imesh.count = n;
    _imesh.instanceMatrix.needsUpdate = true;
    _imesh.instanceColor.needsUpdate  = true;
    _imesh.visible = _energyOn && n > 0;

    console.log('[ArgusGEM] instanced mesh rebuilt —', n, 'slots, energy layer:', _energyOn ? 'ON' : 'OFF');
  }

  // ── Update ghost mesh visibility after filter change ──────────────────────────
  function _refreshGhostVisibility() {
    var emg = window.ArgusGlobe && window.ArgusGlobe.eventMarkerGroup;
    if (!emg) return;
    emg.children.forEach(function (o) {
      if (!o.userData || !o.userData._gemMarker) return;
      o.visible = _energyOn && _isTypeVisible(o.userData._canonType);
    });
  }

  // ── Rebuild instanced + ghost after any state change ─────────────────────────
  function _refreshVisibility() {
    var AG = window.ArgusGlobe;
    if (!AG) return;
    var altR = (AG.R && AG.R.MARKER) || 101;
    _rebuildInstanced(AG, altR);
    _refreshGhostVisibility();
  }

  // ── Render infrastructure from cache (one-shot, not a loop) ──────────────────
  function _renderInfrastructure() {
    var AG = window.ArgusGlobe;
    if (!AG || !AG.eventMarkerGroup || !AG.latLonToVector) return;
    if (!energyInfrastructureCache.size) return;

    var altR  = (AG.R && AG.R.MARKER) || 101;
    _energyOn = !!(window.ArgusLayerState && window.ArgusLayerState.energy);
    var added = 0;

    // Remove stale markers
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

    // Add ghost meshes for new markers (raycasting only)
    energyInfrastructureCache.forEach(function (infra) {
      if (_placedIds.has(infra.id)) return;

      var col     = _infraColor(infra.type);
      var pos     = AG.latLonToVector(infra.lat, infra.lon, altR);
      var visible = _energyOn && _isTypeVisible(infra._canonType);

      var mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.9, 0.9, 0.9),
        new THREE.MeshBasicMaterial({ color: col, visible: false })
      );
      mesh.position.copy(pos);
      mesh.visible = visible;

      var capacityStr = infra.capacityMW != null
        ? ' · Capacity: ' + infra.capacityMW + ' MW'
        : (infra.capacity ? ' · Capacity: ' + infra.capacity + (infra.unit ? ' ' + infra.unit : '') : '');
      var statusStr = infra.status ? ' · Status: ' + infra.status : '';

      mesh.userData = {
        _gemMarker:   true,
        _gemId:       infra.id,
        _canonType:   infra._canonType,
        type:         infra.type,
        isGEM:        true,
        isCountry:    false,
        // Structured fields for the detail panel
        _gemName:     infra.name     || '',
        _gemCountry:  infra.country  || '',
        _gemFuel:     infra.fuel     || '',
        _gemCapacity: infra.capacityMW != null ? infra.capacityMW : (infra.capacity || null),
        _gemUnit:     infra.capacityMW != null ? 'MW' : (infra.unit || 'MW'),
        _gemStatus:   infra.status   || '',
        _gemOwner:    infra.owner    || '',
        // Legacy flat fields (used by hover tooltip and fallback paths)
        title:        (infra.name || infra.type) + (infra.country ? ' — ' + infra.country : ''),
        impact:       (infra.type || 'Infrastructure') + capacityStr + statusStr +
                      (infra.fuel ? ' · Fuel: ' + infra.fuel : ''),
        source:       'Global Energy Monitor',
        countryCode:  null,
      };

      AG.eventMarkerGroup.add(mesh);
      if (window.eventMarkers) window.eventMarkers.push(mesh);
      _placedIds.add(infra.id);
      added++;
    });

    _audit.placed += added;
    _rendered = true;

    _rebuildInstanced(AG, altR);

    if (added > 0 && typeof window.updateNodeCounts === 'function') {
      window.updateNodeCounts();
    }
  }

  // ── Load + normalize response into EnergyAsset schema ────────────────────────
  function _loadResponse(json) {
    if (!json || !Array.isArray(json.infrastructure)) return;

    var incomingIds = new Set();
    for (var i = 0; i < json.infrastructure.length; i++) {
      var raw = json.infrastructure[i];
      if (raw && raw.id && raw.lat != null && raw.lon != null) incomingIds.add(raw.id);
    }

    // Evict removed infrastructure
    energyInfrastructureCache.forEach(function (infra, id) {
      if (!incomingIds.has(id)) energyInfrastructureCache.delete(id);
    });

    // Upsert with normalized EnergyAsset fields
    for (var j = 0; j < json.infrastructure.length; j++) {
      var item = json.infrastructure[j];
      if (!item || !item.id || item.lat == null || item.lon == null) continue;

      // Normalize into EnergyAsset schema
      var asset = {
        id:         item.id,
        name:       item.name || '',
        type:       item.type || 'infrastructure',
        country:    item.country || '',
        lat:        item.lat,
        lon:        item.lon,
        capacityMW: _toCapacityMW(item),
        status:     item.status || null,
        source:     'Global Energy Monitor',
        // Internal fields retained for backward compat
        capacity:   item.capacity,
        unit:       item.unit,
        fuel:       item.fuel,
        _canonType: _canonicalType(item.type),
      };

      energyInfrastructureCache.set(asset.id, asset);
    }
  }

  // ── Fetch ─────────────────────────────────────────────────────────────────────
  function _fetch() {
    var reqCache = window._argusReqCache;
    if (!reqCache) return;

    _audit.fetches++;

    reqCache.fetch(GEM_FN)
      .then(function (json) {
        _audit.lastFetchMs = Date.now();
        _audit.lastError   = null;

        if (json && json.disabled) return;

        _loadResponse(json);

        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify(json));
          localStorage.setItem(CACHE_TS,  String(Date.now()));
        } catch (e) {}

        _renderInfrastructure();
      })
      .catch(function (err) {
        _audit.lastError = err.message;
      });
  }

  // ── Start / stop ─────────────────────────────────────────────────────────────
  function start() {
    if (_refreshTimer) return;

    try {
      var cached = localStorage.getItem(CACHE_KEY);
      var ts     = parseInt(localStorage.getItem(CACHE_TS) || '0');
      if (cached && Date.now() - ts < CACHE_TTL) {
        var parsed = JSON.parse(cached);
        if (parsed && !parsed.disabled) {
          _loadResponse(parsed);
          setTimeout(_renderInfrastructure, 5000);
          _refreshTimer = setInterval(function () {
            if (Date.now() - parseInt(localStorage.getItem(CACHE_TS) || '0') > CACHE_TTL) _fetch();
          }, REFRESH_MS);
          return;
        }
      }
    } catch (e) {}

    setTimeout(_fetch, 60 * 1000);

    _refreshTimer = setInterval(function () {
      if (Date.now() - parseInt(localStorage.getItem(CACHE_TS) || '0') > CACHE_TTL) _fetch();
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
    if (_imesh) _imesh.visible = false;
    _energyOn = false;
    energyInfrastructureCache.clear();
    _placedIds.clear();
    _rendered = false;
  }

  function refresh() { _fetch(); }

  // ── setVisible — called by the energy layer toggle ────────────────────────────
  // Decoupled from ArgusLayerState.events / E key.
  function setVisible(v) {
    _energyOn = !!v;
    _refreshVisibility();
  }

  // ── setTypeFilter — update which canonical types are shown ────────────────────
  // types: Array of strings from ['coal','nuclear','hydro','wind','lng']
  function setTypeFilter(types) {
    _activeTypes = new Set(Array.isArray(types) ? types : []);
    _refreshVisibility();
  }

  // ── getCountryEnergy — aggregate energy assets for a country ──────────────────
  // countryName: display name string (case-insensitive match against infra.country)
  // Returns { coalMW, nuclearMW, hydroMW, windMW, gasMW, lngAssets, solarMW, totalAssets }
  function getCountryEnergy(countryName) {
    var result = { coalMW: 0, nuclearMW: 0, hydroMW: 0, windMW: 0, gasMW: 0, lngAssets: 0, solarMW: 0, totalAssets: 0 };
    if (!countryName) return result;
    var needle = countryName.toLowerCase();
    energyInfrastructureCache.forEach(function (infra) {
      if (!infra.country || infra.country.toLowerCase().indexOf(needle) < 0) return;
      result.totalAssets++;
      var mw = infra.capacityMW;
      switch (infra._canonType) {
        case 'coal':    if (mw) result.coalMW    += mw; break;
        case 'nuclear': if (mw) result.nuclearMW += mw; break;
        case 'hydro':   if (mw) result.hydroMW   += mw; break;
        case 'wind':    if (mw) result.windMW     += mw; break;
        case 'gas':     if (mw) result.gasMW      += mw; break;
        case 'solar':   if (mw) result.solarMW    += mw; break;
        case 'lng':     result.lngAssets++;               break;
      }
    });
    return result;
  }

  function status() {
    return {
      cacheSize:   energyInfrastructureCache.size,
      placed:      _placedIds.size,
      rendered:    _rendered,
      energyOn:    _energyOn,
      activeTypes: Array.from(_activeTypes),
      fetches:     _audit.fetches,
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

  return { start: start, stop: stop, refresh: refresh, status: status, setVisible: setVisible, setTypeFilter: setTypeFilter, getCountryEnergy: getCountryEnergy };

}());
