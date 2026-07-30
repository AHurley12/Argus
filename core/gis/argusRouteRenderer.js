'use strict';
// core/gis/argusRouteRenderer.js
// ARGUS GIS Phase 3 — RouteRenderer
//
// Renders major shipping routes as great-circle paths on the globe.
// Traffic counting via ArgusGIS spatial indexes (ship, ais_vessel).
//
// Public API: window.ArgusRouteRenderer
//   .setVisible(bool)
//   .isVisible()
//   .isReady()
//   .getTraffic(routeId) → { total, bySegment: [{from,to,count}] }
//   .getRoutes() → route array

window.ArgusRouteRenderer = (function () {
  'use strict';

  var _routes   = [];        // raw route definitions from routes.json
  var _group    = null;      // THREE.Group added to ArgusGlobe.dataGroup
  var _visible  = true;
  var _ready    = false;
  var _traffic  = {};        // routeId → { total, bySegment: [...] }
  var _trafficTimer = null;

  var ROUTE_COLOR    = 0x44aaff;
  var DASH_MATERIAL_OPTS = {
    color:       ROUTE_COLOR,
    transparent: true,
    opacity:     0.35,
    dashSize:    6,
    gapSize:     3,
    depthWrite:  false,
  };

  // ── Haversine distance (km) ───────────────────────────────────────────────────
  function _haversineKm(lat1, lon1, lat2, lon2) {
    var R  = 6371;
    var dL = (lat2 - lat1) * Math.PI / 180;
    var dl = (lon2 - lon1) * Math.PI / 180;
    var a  = Math.sin(dL / 2) * Math.sin(dL / 2) +
             Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
             Math.sin(dl / 2) * Math.sin(dl / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ── Great-circle SLERP interpolation ─────────────────────────────────────────
  // Returns array of {lat, lon} points interpolating from A to B along a great circle.
  // N is determined by distance so there is approximately one point every 80 km.
  function _geoSlerp(lat1, lon1, lat2, lon2) {
    var toRad = Math.PI / 180;
    var toDeg = 180 / Math.PI;

    var ax = Math.cos(lat1 * toRad) * Math.cos(lon1 * toRad);
    var ay = Math.cos(lat1 * toRad) * Math.sin(lon1 * toRad);
    var az = Math.sin(lat1 * toRad);

    var bx = Math.cos(lat2 * toRad) * Math.cos(lon2 * toRad);
    var by = Math.cos(lat2 * toRad) * Math.sin(lon2 * toRad);
    var bz = Math.sin(lat2 * toRad);

    var dot = ax * bx + ay * by + az * bz;
    // Clamp to avoid NaN from floating-point drift
    dot = Math.max(-1, Math.min(1, dot));
    var omega = Math.acos(dot);

    var distKm = _haversineKm(lat1, lon1, lat2, lon2);
    var N = Math.max(4, Math.ceil(distKm / 80));

    var pts = [];

    if (Math.abs(omega) < 1e-6) {
      // Nearly identical points — just return endpoints
      pts.push({ lat: lat1, lon: lon1 });
      pts.push({ lat: lat2, lon: lon2 });
      return pts;
    }

    var sinOmega = Math.sin(omega);
    for (var i = 0; i <= N; i++) {
      var t  = i / N;
      var s0 = Math.sin((1 - t) * omega) / sinOmega;
      var s1 = Math.sin(t * omega) / sinOmega;

      var cx = s0 * ax + s1 * bx;
      var cy = s0 * ay + s1 * by;
      var cz = s0 * az + s1 * bz;

      var lat = Math.asin(cz) * toDeg;
      var lon = Math.atan2(cy, cx) * toDeg;
      pts.push({ lat: lat, lon: lon });
    }

    return pts;
  }

  // ── Build all route geometry ──────────────────────────────────────────────────
  function _buildGeometry() {
    var AG = window.ArgusGlobe;
    if (!AG || !AG.dataGroup || !AG.latLonToVector) return false;

    var R    = AG.R || {};
    var altR = (R.MARKER || 101) + 0.5;

    if (!_group) {
      _group = new THREE.Group();
      _group.name    = 'ArgusRouteRenderer';
      _group.visible = _visible;
      AG.dataGroup.add(_group);
    }

    _routes.forEach(function (route) {
      // Enrich waypoints with port metadata if available
      var bm = window.ArgusBoundaryManager;
      if (bm && typeof bm.getPortByName === 'function') {
        route.waypoints.forEach(function (wp) {
          if (wp.port && !wp._portMeta) {
            var pm = bm.getPortByName(wp.label);
            wp._portMeta = pm || null;
          }
        });
      }

      // Build interpolated polyline from all waypoints
      var positions = [];
      var wps = route.waypoints;
      for (var s = 0; s < wps.length - 1; s++) {
        var from = wps[s];
        var to   = wps[s + 1];
        var pts  = _geoSlerp(from.lat, from.lon, to.lat, to.lon);
        // Skip last point of each segment (it's the first of the next)
        for (var p = 0; p < pts.length - 1; p++) {
          var v = AG.latLonToVector(pts[p].lat, pts[p].lon, altR);
          positions.push(v.x, v.y, v.z);
        }
      }
      // Add the final endpoint
      var lastWp = wps[wps.length - 1];
      var lastV  = AG.latLonToVector(lastWp.lat, lastWp.lon, altR);
      positions.push(lastV.x, lastV.y, lastV.z);

      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.computeBoundingSphere();

      var mat  = new THREE.LineDashedMaterial(DASH_MATERIAL_OPTS);
      var line = new THREE.Line(geo, mat);
      line.computeLineDistances();
      line.name     = 'route_' + route.id;
      line.userData = { routeId: route.id, routeName: route.name };
      _group.add(line);

      // Waypoint markers
      var markerMat = new THREE.MeshBasicMaterial({
        color:      ROUTE_COLOR,
        transparent: true,
        opacity:    0.85,
        depthWrite: false,
      });
      wps.forEach(function (wp) {
        var mpos = AG.latLonToVector(wp.lat, wp.lon, (R.MARKER || 101) + 0.5);
        var mGeo = new THREE.SphereGeometry(0.25, 6, 6);
        var mesh = new THREE.Mesh(mGeo, markerMat.clone());
        mesh.position.copy(mpos);
        mesh.name     = 'routeWp_' + route.id + '_' + wp.id;
        mesh.userData = { routeId: route.id, waypointId: wp.id, waypointLabel: wp.label };
        _group.add(mesh);
      });
    });

    console.log('[ArgusRouteRenderer] built ' + _routes.length + ' routes');
    return true;
  }

  // ── Traffic counting ──────────────────────────────────────────────────────────
  // Runs every 60 seconds. Queries ArgusGIS indexes at sample points along each segment.
  function _countTraffic() {
    if (!window.ArgusGIS) return;

    _routes.forEach(function (route) {
      var wps = route.waypoints;
      var routeTotal = 0;
      var bySegment  = [];

      for (var s = 0; s < wps.length - 1; s++) {
        var from = wps[s];
        var to   = wps[s + 1];
        var seen = {};
        var segVessels = [];

        // 5 sample points along segment at t = 0.1, 0.3, 0.5, 0.7, 0.9
        var tValues = [0.1, 0.3, 0.5, 0.7, 0.9];
        var pts = _geoSlerp(from.lat, from.lon, to.lat, to.lon);
        var tLen = pts.length - 1;

        tValues.forEach(function (t) {
          var idx = Math.min(Math.round(t * tLen), tLen);
          var sp  = pts[idx];
          if (!sp) return;

          var hits1 = window.ArgusGIS.within('ship',       sp.lat, sp.lon, 50) || [];
          var hits2 = window.ArgusGIS.within('ais_vessel', sp.lat, sp.lon, 50) || [];
          var combined = hits1.concat(hits2);

          combined.forEach(function (ud) {
            var key = (ud && ud.mmsi) ? String(ud.mmsi) : (ud ? (ud.lat + ',' + ud.lon) : null);
            if (!key || seen[key]) return;
            seen[key] = true;
            segVessels.push(ud);
          });
        });

        var segCount = Object.keys(seen).length;
        routeTotal += segCount;
        bySegment.push({
          from:    from.id,
          to:      to.id,
          count:   segCount,
          vessels: segVessels,
        });
      }

      _traffic[route.id] = {
        total:     routeTotal,
        bySegment: bySegment,
      };
    });
  }

  // ── Poll for ArgusGlobe readiness, then build ─────────────────────────────────
  function _awaitGlobeAndBuild() {
    if (window.ArgusGlobe && window.ArgusGlobe.dataGroup) {
      (window.requestIdleCallback || function (cb) { setTimeout(cb, 200); })(function () {
        var ok = _buildGeometry();
        if (ok) {
          _ready = true;
          _trafficTimer = setInterval(_countTraffic, 60 * 1000);
          // Initial traffic count after a short delay
          setTimeout(_countTraffic, 5000);
        }
      });
    } else {
      setTimeout(_awaitGlobeAndBuild, 500);
    }
  }

  // ── Initialization ────────────────────────────────────────────────────────────
  function _init() {
    fetch('/data/routes.json')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !Array.isArray(data.routes)) return;
        _routes = data.routes;
        _awaitGlobeAndBuild();
      })
      .catch(function (e) {
        console.warn('[ArgusRouteRenderer] failed to load routes.json:', e);
      });
  }

  // Self-initialize on next tick so all globals are set
  setTimeout(_init, 0);

  // ── Public API ────────────────────────────────────────────────────────────────
  function setVisible(v) {
    _visible = !!v;
    if (_group) _group.visible = _visible;
  }

  function isVisible() { return _visible; }
  function isReady()   { return _ready;   }

  function getTraffic(routeId) {
    return _traffic[routeId] || { total: 0, bySegment: [] };
  }

  function getRoutes() { return _routes.slice(); }

  console.log('[ArgusRouteRenderer] initializing');

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusRouteRenderer');

  return {
    setVisible: setVisible,
    isVisible:  isVisible,
    isReady:    isReady,
    getTraffic: getTraffic,
    getRoutes:  getRoutes,
  };

}());
