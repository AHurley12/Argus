'use strict';
// core/gis/argusBoundaryManager.js
// ARGUS GIS Phase 2 — BoundaryManager
//
// Provides runtime geographic boundary queries without re-fetching GeoJSON.
// Wired by index.html which calls _onFeaturesReady() immediately after the
// country GeoJSON fetch resolves and before the globe texture is set.
//
// Public API: window.ArgusBoundaryManager
//   .pointInCountry(lat, lon)    → ISO_A3 string | null
//   .pointInChokepoint(lat, lon) → chokepoint id string | null
//   .isReady()                   → bool
//   ._onFeaturesReady(features)  — called by index.html (not for external use)
//
// Coordinate convention: GeoJSON ring coordinates are [lon, lat].
// All public methods accept (lat, lon) in the standard geographic order.

window.ArgusBoundaryManager = (function () {
  'use strict';

  var _features    = null;   // country GeoJSON features array
  var _bboxes      = null;   // parallel bounding-box array for pre-filtering
  var _cpPolygons  = null;   // Map: chokepointId → { label, ring: [[lon,lat],...] }
  var _cpReady     = false;
  var _geoReady    = false;

  // ── Port zone state ───────────────────────────────────────────────────────────
  var _portById   = new Map();   // portId → port entry
  var _portByName = new Map();   // imf_portwatch_name.toLowerCase() → port entry
  var _portIndex  = null;        // SpatialIndex of all ports

  // ── Point-in-ring — ray casting ───────────────────────────────────────────────
  // Adapted from the standard Haines algorithm. Works for any simple polygon.
  // ring: [[lon, lat], ...] — does not need to be closed (wraps automatically).
  function _pointInRing(lon, lat, ring) {
    var inside = false;
    var n = ring.length;
    var j = n - 1;
    for (var i = 0; i < n; i++) {
      var xi = ring[i][0], yi = ring[i][1];
      var xj = ring[j][0], yj = ring[j][1];
      if ((yi > lat) !== (yj > lat) &&
          lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
        inside = !inside;
      }
      j = i;
    }
    return inside;
  }

  // ── Point-in-geometry (Polygon or MultiPolygon) ───────────────────────────────
  // Handles multi-part countries (islands, exclaves).
  // Holes are handled via the even-odd rule for MultiPolygon.
  // For simplicity we test outer rings only — inner ring (hole) tests are skipped.
  // This produces false positives inside lake polygons (e.g. Lake Victoria) for
  // countries that use holes in their GeoJSON, which is acceptable for Phase 2.
  function _pointInGeometry(lon, lat, geometry) {
    if (!geometry) return false;
    var polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    for (var p = 0; p < polys.length; p++) {
      var rings = polys[p];
      if (!rings || !rings[0]) continue;
      if (_pointInRing(lon, lat, rings[0])) {
        // Check holes (inner rings) — if inside a hole, the point is outside the polygon
        var inHole = false;
        for (var h = 1; h < rings.length; h++) {
          if (_pointInRing(lon, lat, rings[h])) { inHole = true; break; }
        }
        if (!inHole) return true;
      }
    }
    return false;
  }

  // ── Bounding-box computation ──────────────────────────────────────────────────
  // Only outer rings are used (inner rings are within the outer ring's bbox).
  function _computeBBox(geometry) {
    var minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    var polys  = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    for (var p = 0; p < polys.length; p++) {
      var outer = polys[p][0];
      if (!outer) continue;
      for (var i = 0; i < outer.length; i++) {
        var pt = outer[i];
        if (pt[0] < minLon) minLon = pt[0];
        if (pt[0] > maxLon) maxLon = pt[0];
        if (pt[1] < minLat) minLat = pt[1];
        if (pt[1] > maxLat) maxLat = pt[1];
      }
    }
    return { minLon: minLon, maxLon: maxLon, minLat: minLat, maxLat: maxLat };
  }

  // ── pointInCountry ────────────────────────────────────────────────────────────
  // Returns the ISO_A3 country code for the given position, or null if over ocean.
  // Complexity: O(N_features × N_vertices) worst case, reduced by bbox pre-filter.
  function pointInCountry(lat, lon) {
    if (!_geoReady) return null;
    for (var i = 0; i < _features.length; i++) {
      var bb = _bboxes[i];
      if (!bb) continue;
      // Bounding-box pre-filter — skips ~95% of features for any given point
      if (lon < bb.minLon || lon > bb.maxLon || lat < bb.minLat || lat > bb.maxLat) continue;
      if (_pointInGeometry(lon, lat, _features[i].geometry)) {
        var props = _features[i].properties;
        return (props.ISO_A3 && props.ISO_A3 !== '-99')
          ? props.ISO_A3
          : (props.ADM0_A3 || null);
      }
    }
    return null;
  }

  // ── pointInChokepoint ─────────────────────────────────────────────────────────
  // Returns the chokepoint id if the position is inside any defined polygon, else null.
  function pointInChokepoint(lat, lon) {
    if (!_cpReady) return null;
    var ids = Object.keys(_cpPolygons);
    for (var i = 0; i < ids.length; i++) {
      var cp = _cpPolygons[ids[i]];
      if (cp && cp.ring && _pointInRing(lon, lat, cp.ring)) return ids[i];
    }
    return null;
  }

  // ── isReady ───────────────────────────────────────────────────────────────────
  function isReady() {
    return _geoReady && _cpReady;
  }

  // ── Port zone loading ─────────────────────────────────────────────────────────
  // Load port-locations.json and build lookup structures.
  function _loadPorts() {
    fetch('/data/port-locations.json')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !Array.isArray(data.ports)) return;
        var pts = [];
        data.ports.forEach(function (p) {
          _portById.set(p.id, p);
          if (p.imf_portwatch_name)
            _portByName.set(p.imf_portwatch_name.toLowerCase(), p);
          if (p.lat != null && p.lon != null)
            pts.push({ lat: p.lat, lon: p.lon, data: p });
        });
        if (window.ArgusGIS) {
          window.ArgusGIS.rebuild('port', pts);
          _portIndex = window.ArgusGIS.getIndex('port');
        }
        console.log('[ArgusBoundaryManager] ' + data.ports.length + ' port zones loaded');
      })
      .catch(function (e) { console.warn('[ArgusBoundaryManager] port load failed:', e); });
  }

  // ── pointNearPort ─────────────────────────────────────────────────────────────
  // Return the nearest port if within its radius_km, else null.
  function pointNearPort(lat, lon) {
    var idx = _portIndex || (window.ArgusGIS && window.ArgusGIS.getIndex('port'));
    if (!idx) return null;
    var results = idx.knn(lat, lon, 1);
    if (!results.length) return null;
    var r    = results[0];
    var port = r.data;
    if (r.distKm > (port.radius_km || 10)) return null;
    return {
      id:          port.id,
      name:        port.name,
      distance_km: Math.round(r.distKm * 10) / 10,
      country:     port.country,
      region:      port.region,
      chokepoint:  port.chokepoint || null,
    };
  }

  // ── getVesselsNearPort ────────────────────────────────────────────────────────
  // Return vessels near a port from a named ArgusGIS index.
  function getVesselsNearPort(portId, indexType) {
    var port = _portById.get(portId);
    if (!port || !window.ArgusGIS) return { total: 0, byType: {}, list: [] };
    var radius = port.radius_km || 10;
    var items  = window.ArgusGIS.within(indexType || 'ais_vessel', port.lat, port.lon, radius);
    var byType = {};
    items.forEach(function (ud) {
      var t = ud.typeCategory || ud.flightType || ud.type || 'unknown';
      byType[t] = (byType[t] || 0) + 1;
    });
    return { total: items.length, byType: byType, list: items };
  }

  // ── getPortByName ─────────────────────────────────────────────────────────────
  // Look up a port by its IMF PortWatch name (case-insensitive).
  function getPortByName(name) {
    if (!name) return null;
    return _portByName.get(name.toLowerCase()) || null;
  }

  // ── _onFeaturesReady — called by index.html ───────────────────────────────────
  // Receives the country GeoJSON features array immediately after the fetch resolves.
  // Builds bounding boxes, then fetches chokepoint polygons.
  function _onFeaturesReady(features) {
    _features = features;
    _bboxes   = new Array(features.length);

    for (var i = 0; i < features.length; i++) {
      var geom = features[i] && features[i].geometry;
      _bboxes[i] = geom ? _computeBBox(geom) : null;
    }

    _geoReady = true;

    // Load chokepoint polygon definitions
    fetch('/data/chokepoint-polygons.json')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) {
          console.warn('[ArgusBoundaryManager] chokepoint-polygons.json unavailable');
          return;
        }
        _cpPolygons = data;
        _cpReady    = true;
        console.log('[ArgusBoundaryManager] ready — '
          + features.length + ' countries, '
          + Object.keys(data).length + ' chokepoint polygons');
      })
      .catch(function (e) {
        console.warn('[ArgusBoundaryManager] failed to load chokepoint polygons:', e);
        _cpPolygons = {};
        _cpReady    = true;
      });

    // Load port zone definitions
    _loadPorts();
  }

  return {
    pointInCountry:    pointInCountry,
    pointInChokepoint: pointInChokepoint,
    isReady:           isReady,
    _onFeaturesReady:  _onFeaturesReady,
    pointNearPort:     pointNearPort,
    getVesselsNearPort: getVesselsNearPort,
    getPortByName:     getPortByName,
  };
}());

if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusBoundaryManager');
