'use strict';
// workers/temperature-idw-worker.js
// IDW spatial interpolation worker.
// Runs off the main thread. Receives station data + viewport region,
// outputs RGBA pixel array and raw temperature grid.
//
// Message IN:  { stations, xMin, yMin, w, h, idwP, idwN }
//   stations  — [{lat, lon, t}, ...]  all available data points
//   xMin/yMin — top-left canvas pixel of the region to compute
//   w/h       — region dimensions in canvas pixels
//   idwP      — IDW power (default 2)
//   idwN      — neighbor count (default 8)
//
// Message OUT: { pixels, temps, xMin, yMin, w, h }
//   pixels — Uint8Array (RGBA, w×h), transferred
//   temps  — Float32Array (w×h), transferred (NaN = no data)

// ── Color scale ───────────────────────────────────────────────────────────────
// Perceptually uniform anchor points for temperature (°C → RGB).
// Duplicated from main module so the worker is fully self-contained.

// Classic rainbow: violet (cold) → blue → cyan → green → yellow → orange → red (hot)
var COLOR_STOPS = [
  { t: -50, r: 148, g:   0, b: 211 },  // violet
  { t: -30, r:   0, g:   0, b: 255 },  // blue
  { t: -10, r:   0, g: 255, b: 255 },  // cyan
  { t:  10, r:   0, g: 255, b:   0 },  // green
  { t:  25, r: 255, g: 255, b:   0 },  // yellow
  { t:  35, r: 255, g: 127, b:   0 },  // orange
  { t:  50, r: 255, g:   0, b:   0 },  // red
];

function tempToRGBA(t) {
  if (t !== t || t === null) return { r: 30, g: 30, b: 50, a: 0 }; // NaN → transparent
  var s = COLOR_STOPS;
  if (t <= s[0].t)   return { r: s[0].r,                       g: s[0].g,                       b: s[0].b,                       a: 210 };
  var last = s[s.length - 1];
  if (t >= last.t)   return { r: last.r,                        g: last.g,                        b: last.b,                        a: 210 };
  for (var i = 0; i < s.length - 1; i++) {
    if (t <= s[i + 1].t) {
      var f = (t - s[i].t) / (s[i + 1].t - s[i].t);
      return {
        r: Math.round(s[i].r + f * (s[i + 1].r - s[i].r)),
        g: Math.round(s[i].g + f * (s[i + 1].g - s[i].g)),
        b: Math.round(s[i].b + f * (s[i + 1].b - s[i].b)),
        a: 210,
      };
    }
  }
  return { r: last.r, g: last.g, b: last.b, a: 210 };
}

// ── KD-tree ───────────────────────────────────────────────────────────────────
// 2D KD-tree alternating on lat (axis 0) and lon (axis 1).
// Supports k-nearest-neighbor search with a max-heap of size k.

function buildKDTree(pts, depth) {
  if (!pts.length) return null;
  var axis = depth & 1; // 0 = lat, 1 = lon
  pts.sort(axis === 0
    ? function (a, b) { return a.lat - b.lat; }
    : function (a, b) { return a.lon - b.lon; }
  );
  var mid = pts.length >> 1;
  return {
    p: pts[mid],
    L: buildKDTree(pts.slice(0, mid),      depth + 1),
    R: buildKDTree(pts.slice(mid + 1), depth + 1),
  };
}

// k-NN search. `heap` is maintained as a max-heap (worst at index 0) of
// size ≤ k, keyed on squared Euclidean distance in degree space.
// For k ≤ 8, keeping it sorted after each insert is effectively O(1).
function knnSearch(node, qlat, qlon, k, depth, heap) {
  if (!node) return;
  var axis  = depth & 1;
  var dlat  = qlat - node.p.lat;
  var dlon  = qlon - node.p.lon;
  var d2    = dlat * dlat + dlon * dlon;

  if (heap.length < k) {
    heap.push({ d2: d2, t: node.p.t });
    if (heap.length === k) heap.sort(_cmpDesc);
  } else if (d2 < heap[0].d2) {
    heap[0] = { d2: d2, t: node.p.t };
    heap.sort(_cmpDesc);
  }

  var diff = axis === 0 ? dlat : dlon;
  var near = diff < 0 ? node.L : node.R;
  var far  = diff < 0 ? node.R : node.L;

  knnSearch(near, qlat, qlon, k, depth + 1, heap);

  var worstD2 = heap.length >= k ? heap[0].d2 : Infinity;
  if (diff * diff < worstD2) {
    knnSearch(far, qlat, qlon, k, depth + 1, heap);
  }
}

function _cmpDesc(a, b) { return b.d2 - a.d2; }

// ── IDW ───────────────────────────────────────────────────────────────────────
// wi = 1 / d^p = 1 / (d2^(p/2)). With p=2: wi = 1/d2.

function idwInterpolate(qlat, qlon, kRoot, k, p) {
  var heap = [];
  knnSearch(kRoot, qlat, qlon, k, 0, heap);
  if (!heap.length) return NaN;

  var wSum = 0, tSum = 0;
  for (var i = 0; i < heap.length; i++) {
    var n = heap[i];
    if (n.d2 === 0) return n.t;  // exact hit on a station
    var w = 1 / Math.pow(n.d2, p / 2);
    wSum += w;
    tSum += w * n.t;
  }
  return wSum > 0 ? tSum / wSum : NaN;
}

// ── Worker message handler ────────────────────────────────────────────────────

self.onmessage = function (e) {
  var msg = e.data;

  var stations = msg.stations;
  var xMin     = msg.xMin;
  var yMin     = msg.yMin;
  var w        = msg.w;
  var h        = msg.h;
  var idwP     = msg.idwP    || 2;
  var idwN     = msg.idwN    || 8;

  if (!stations || !stations.length || w <= 0 || h <= 0) {
    self.postMessage({ error: 'no stations or zero region' });
    return;
  }

  // ── Build KD-tree from all stations ──────────────────────────────────────
  var validStations = [];
  for (var si = 0; si < stations.length; si++) {
    var s = stations[si];
    if (s.t !== null && s.t !== undefined && s.t === s.t) {
      validStations.push({ lat: s.lat, lon: s.lon, t: s.t });
    }
  }

  if (!validStations.length) {
    self.postMessage({ error: 'no valid stations' });
    return;
  }

  var kdRoot = buildKDTree(validStations.slice(), 0);

  // ── Compute IDW temperature for each pixel in the region ─────────────────
  var temps   = new Float32Array(w * h);  // NaN = no data
  var pixels  = new Uint8Array(w * h * 4);

  for (var row = 0; row < h; row++) {
    var lat = 89.5 - (yMin + row);
    for (var col = 0; col < w; col++) {
      var lon = (xMin + col) - 179.5;
      var t   = idwInterpolate(lat, lon, kdRoot, idwN, idwP);
      temps[row * w + col] = t;

      var rgba = tempToRGBA(t);
      var idx  = (row * w + col) * 4;
      pixels[idx]     = rgba.r;
      pixels[idx + 1] = rgba.g;
      pixels[idx + 2] = rgba.b;
      pixels[idx + 3] = rgba.a;
    }
  }

  // ── Transfer buffers back to main thread ──────────────────────────────────
  self.postMessage({
    pixels: pixels,
    temps:  temps,
    xMin:   xMin,
    yMin:   yMin,
    w:      w,
    h:      h,
  }, [pixels.buffer, temps.buffer]);
};
