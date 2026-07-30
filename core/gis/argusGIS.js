'use strict';
// core/gis/argusGIS.js
// ARGUS GIS Foundation — Phase 1
//
// Provides haversine distance, a 2D KD-tree spatial index, and a named-index
// registry so every data source can publish a queryable spatial layer.
//
// Public API: window.ArgusGIS
//   .haversineKm(lat1, lon1, lat2, lon2)  → number (km)
//   .rebuild(type, points)                 — build/replace named index
//                                            points = [{lat, lon, data}]
//   .within(type, lat, lon, radiusKm)      → data[]   (unordered)
//   .knn(type, lat, lon, k)                → [{distKm, data}] (asc)
//   .getIndex(type)                        → SpatialIndex | null
//   .listTypes()                           → string[]
//   .SpatialIndex                          — constructor (for direct use)
//
// Named index types used in Phase 1:
//   'aircraft'  — live OpenSky aircraft    (rebuilt every ~90s)
//   'ship'      — VesselAPI ships          (rebuilt every ~30min)
//   'ais_vessel'— AISstream WS vessels     (rebuilt every 5s max)
//   'acled'     — ACLED conflict events    (rebuilt on each poll)
//   'gdacs'     — GDACS disaster events    (rebuilt on each poll)
//   'eonet'     — NASA EONET events        (rebuilt on each poll)
//   'gem'       — GEM energy infra assets  (rebuilt on daily fetch)
//
// Dependencies: none (loads immediately after cache.js)

window.ArgusGIS = (function () {
  'use strict';

  // ── Haversine great-circle distance (km) ──────────────────────────────────────
  // Extracted verbatim from argusNeuralWeb.js:2601.
  // Exposing it globally removes the only other copy from NeuralWeb's private scope.
  // NeuralWeb's internal calls are unaffected (its local function still exists).
  function haversineKm(lat1, lon1, lat2, lon2) {
    var R    = 6371;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var a    = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
               Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
               Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ── KD-tree internals ─────────────────────────────────────────────────────────
  // Ported from workers/temperature-idw-worker.js.
  // Points are {lat, lon, data}. Alternates on lat (axis 0) / lon (axis 1).

  function _buildKDTree(pts, depth) {
    if (!pts.length) return null;
    var axis = depth & 1;  // 0 = lat split, 1 = lon split
    pts.sort(axis === 0
      ? function (a, b) { return a.lat - b.lat; }
      : function (a, b) { return a.lon - b.lon; }
    );
    var mid = pts.length >> 1;
    return {
      p: pts[mid],
      L: _buildKDTree(pts.slice(0, mid),       depth + 1),
      R: _buildKDTree(pts.slice(mid + 1),      depth + 1),
    };
  }

  // Max-heap comparator — worst (largest d²) at index 0.
  function _cmpDesc(a, b) { return b.d2 - a.d2; }

  // k-NN search. heap entries: {d2, distKm, data}.
  // d² is in degree-space (for O(1) pruning); distKm is the true great-circle dist.
  function _knnSearch(node, qlat, qlon, k, depth, heap) {
    if (!node) return;
    var axis = depth & 1;
    var dlat = qlat - node.p.lat;
    var dlon = qlon - node.p.lon;
    var d2   = dlat * dlat + dlon * dlon;
    var dist = haversineKm(qlat, qlon, node.p.lat, node.p.lon);

    if (heap.length < k) {
      heap.push({ d2: d2, distKm: dist, data: node.p.data });
      if (heap.length === k) heap.sort(_cmpDesc);
    } else if (d2 < heap[0].d2) {
      heap[0] = { d2: d2, distKm: dist, data: node.p.data };
      heap.sort(_cmpDesc);
    }

    var diff = axis === 0 ? dlat : dlon;
    var near = diff < 0 ? node.L : node.R;
    var far  = diff < 0 ? node.R : node.L;

    _knnSearch(near, qlat, qlon, k, depth + 1, heap);

    var worstD2 = heap.length >= k ? heap[0].d2 : Infinity;
    if (diff * diff < worstD2) {
      _knnSearch(far, qlat, qlon, k, depth + 1, heap);
    }
  }

  // Range search — collect all points within radiusKm using haversine.
  // Degree-space bounding box (maxDegLat, maxDegLon) prunes subtrees cheaply;
  // haversine provides the exact final filter.
  function _rangeSearch(node, qlat, qlon, radiusKm, maxDegLat, maxDegLon, depth, out) {
    if (!node) return;
    var axis = depth & 1;
    var dlat = qlat - node.p.lat;
    var dlon = qlon - node.p.lon;

    if (Math.abs(dlat) <= maxDegLat && Math.abs(dlon) <= maxDegLon) {
      if (haversineKm(qlat, qlon, node.p.lat, node.p.lon) <= radiusKm) {
        out.push(node.p.data);
      }
    }

    var diff = axis === 0 ? dlat : dlon;
    var maxD = axis === 0 ? maxDegLat : maxDegLon;
    var near = diff < 0 ? node.L : node.R;
    var far  = diff < 0 ? node.R : node.L;

    _rangeSearch(near, qlat, qlon, radiusKm, maxDegLat, maxDegLon, depth + 1, out);

    if (Math.abs(diff) <= maxD) {
      _rangeSearch(far,  qlat, qlon, radiusKm, maxDegLat, maxDegLon, depth + 1, out);
    }
  }

  // ── SpatialIndex — public constructor ─────────────────────────────────────────
  // Usage:
  //   var idx = new ArgusGIS.SpatialIndex([{lat, lon, data}, ...]);
  //   idx.within(lat, lon, 200)   → data[]
  //   idx.knn(lat, lon, 5)        → [{distKm, data}]
  function SpatialIndex(points) {
    this._root = (points && points.length) ? _buildKDTree(points.slice(), 0) : null;
    this.size  = points ? points.length : 0;
  }

  // Returns [{distKm, data}] sorted ascending. At most k results.
  SpatialIndex.prototype.knn = function (lat, lon, k) {
    if (!this._root || k <= 0) return [];
    var heap = [];
    _knnSearch(this._root, lat, lon, k, 0, heap);
    heap.sort(function (a, b) { return a.distKm - b.distKm; });
    return heap;
  };

  // Returns [data] for all points within radiusKm. Order is not guaranteed.
  SpatialIndex.prototype.within = function (lat, lon, radiusKm) {
    if (!this._root || radiusKm <= 0) return [];
    var maxDegLat = radiusKm / 111;
    var cosLat    = Math.cos(lat * Math.PI / 180);
    var maxDegLon = cosLat > 0.001
      ? Math.min(radiusKm / (111 * cosLat), 180)
      : 180;
    var out = [];
    _rangeSearch(this._root, lat, lon, radiusKm, maxDegLat, maxDegLon, 0, out);
    return out;
  };

  // ── Named index registry ──────────────────────────────────────────────────────
  var _indexes = {};  // type → SpatialIndex

  // Build or replace the named index. Called by each data module after refresh.
  function rebuild(type, points) {
    if (!type || !Array.isArray(points)) return;
    _indexes[type] = new SpatialIndex(points);
  }

  // Query the named index for all points within radiusKm.
  function within(type, lat, lon, radiusKm) {
    var idx = _indexes[type];
    return idx ? idx.within(lat, lon, radiusKm) : [];
  }

  // Query the named index for k nearest neighbors.
  function knn(type, lat, lon, k) {
    var idx = _indexes[type];
    return idx ? idx.knn(lat, lon, k) : [];
  }

  // Return the raw SpatialIndex for a named type (null if not yet built).
  function getIndex(type) {
    return _indexes[type] || null;
  }

  // List all currently registered index types.
  function listTypes() {
    return Object.keys(_indexes);
  }

  console.log('[ArgusGIS] ready');

  return {
    haversineKm:  haversineKm,
    rebuild:      rebuild,
    within:       within,
    knn:          knn,
    getIndex:     getIndex,
    listTypes:    listTypes,
    SpatialIndex: SpatialIndex,
  };
}());

if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusGIS');
