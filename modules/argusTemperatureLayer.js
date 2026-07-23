'use strict';
// modules/argusTemperatureLayer.js
// Adaptive LOD global temperature heatmap with IDW interpolation.
//
// ── ARCHITECTURE ──────────────────────────────────────────────────────────────
//
//   360×180 canvas texture (1°/pixel) mapped to a sphere at r=100.5.
//   All interpolation math runs in a Web Worker (temperature-idw-worker.js).
//   The main thread only handles rendering: putImageData.
//
//   INTERPOLATION ENGINE (Web Worker):
//     Inverse Distance Weighting — T(x,y) = Σ(Ti/di^p) / Σ(1/di^p)
//     Power p=2 (configurable). k=8 nearest neighbors via KD-tree.
//     Every canvas pixel gets its own IDW estimate from all current stations.
//     Result: fully continuous temperature field with no blocky artifacts.
//
//   HOVER TOOLTIP:
//     Raycast from mouse position → sphere UV → lat/lon.
//     Brute-force IDW from _allStations (≤2500 pts) on main thread.
//     Shows "Observed" if hover is within half a grid step of a station.
//
//   LOD TIERS (camera distance, globe radius=100):
//     Global      dist > 280  10° base only      648 pts
//     Continental dist > 200   5° tile + base     ~800 pts
//     Regional    dist > 140   2° tile + base     ~1000 pts
//     City        dist ≤ 140   1° tile + base     ~2000 pts
//
//   COLOR SCALE (perceptually uniform, 12 anchors):
//     −40°C #2D004B → −30 #0C1078 → −20 #2166AC → −10 #67A9CF →
//     0 #B2E2E2 → 10 #A1D99B → 20 #FFFFBF → 25 #FEE08B →
//     30 #FDAE61 → 35 #F46D43 → 40 #D73027 → 45+ #67001F
//
// ── DATA ATTRIBUTION ─────────────────────────────────────────────────────────
//   Open-Meteo (https://open-meteo.com) — CC BY 4.0.

window.ArgusTemperatureLayer = (function () {
  'use strict';

  // ── Config ───────────────────────────────────────────────────────────────────

  var CANVAS_W             = 360;
  var CANVAS_H             = 180;
  var SPHERE_R             = 100.5;
  var OPACITY              = 0.72;
  var BASE_URL             = '/.netlify/functions/fetch-temperature';
  var TILE_URL             = '/.netlify/functions/fetch-temperature-tile';
  var WORKER_URL           = '/workers/temperature-idw-worker.js';
  var BASE_REFRESH_MS      = 2 * 60 * 60 * 1000;
  var CAMERA_POLL_MS       = 500;
  var DEBOUNCE_MS          = 400;
  var IDW_P                = 2;       // IDW power parameter
  var IDW_N                = 8;       // IDW neighbor count

  var LOD_TIERS = [
    { lod: 3, res:  1, maxDist: 140, label: 'City'        },
    { lod: 2, res:  2, maxDist: 200, label: 'Regional'    },
    { lod: 1, res:  5, maxDist: 280, label: 'Continental' },
    { lod: 0, res: 10, maxDist: Infinity, label: 'Global' },
  ];

  var MAX_EXTENT = { 5: 75, 2: 55, 1: 38 };

  // Color stops (mirrored in worker — must stay in sync)
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

  // ── Module state ──────────────────────────────────────────────────────────────

  var _mesh          = null;
  var _canvasTex     = null;
  var _canvas        = null;
  var _ctx           = null;
  var _visible       = false;
  var _baseData      = null;   // raw [{lat,lon,t}] from fetch-temperature
  var _tileData      = null;   // raw [{lat,lon,t}] from active fine tile
  var _allStations   = [];     // merged base + tile, fed to worker & hover IDW
  var _tileRes       = 0;      // active fine tile resolution (degrees)
  var _baseTimer     = null;
  var _pollTimer     = null;
  var _debounceTimer = null;
  var _inflight      = {};
  var _tileCache     = {};
  var _currentLod    = 0;
  var _activeTileKey = null;
  var _worker        = null;   // Web Worker instance
  var _workerBusy    = false;  // true while a compute is in flight
  var _pendingMsg    = null;   // most recent un-dispatched message (latest wins)
  var _lastResult    = null;   // cached last worker result for export
  var _tooltip       = null;   // tooltip DOM element
  var _tooltipTimer  = null;   // auto-dismiss timer for touch taps
  var _raycaster     = null;   // THREE.Raycaster for hover
  var _exportBtn     = null;   // export button DOM element

  var _diag = {
    lod: 0, lodLabel: 'Global',
    stationsTotal: 0, lastTileMs: null,
    canvasSize: CANVAS_W + '×' + CANVAS_H,
    tilesInCache: 0, meshReady: false,
  };

  // ── Color helpers (main thread — for legend only) ─────────────────────────────

  function _tempToColorStr(t) {
    var s = COLOR_STOPS;
    if (t <= s[0].t) return 'rgb(' + s[0].r + ',' + s[0].g + ',' + s[0].b + ')';
    var last = s[s.length - 1];
    if (t >= last.t) return 'rgb(' + last.r + ',' + last.g + ',' + last.b + ')';
    for (var i = 0; i < s.length - 1; i++) {
      if (t <= s[i + 1].t) {
        var f = (t - s[i].t) / (s[i + 1].t - s[i].t);
        return 'rgb(' +
          Math.round(s[i].r + f * (s[i + 1].r - s[i].r)) + ',' +
          Math.round(s[i].g + f * (s[i + 1].g - s[i].g)) + ',' +
          Math.round(s[i].b + f * (s[i + 1].b - s[i].b)) + ')';
      }
    }
    return 'rgb(' + last.r + ',' + last.g + ',' + last.b + ')';
  }

  // ── Merge stations (base + tile, dedup by lat_lon key) ────────────────────────

  function _mergeStations() {
    var seen = {};
    var out  = [];
    var src  = [_baseData || [], _tileData || []];
    for (var si = 0; si < src.length; si++) {
      var arr = src[si];
      for (var i = 0; i < arr.length; i++) {
        var p = arr[i];
        var k = p.lat + '_' + p.lon;
        if (!seen[k]) { seen[k] = true; out.push(p); }
      }
    }
    _allStations = out;
    _diag.stationsTotal = out.length;
  }

  // ── Web Worker ────────────────────────────────────────────────────────────────

  function _initWorker() {
    if (typeof Worker === 'undefined') return;
    try {
      _worker = new Worker(WORKER_URL);
      _worker.onmessage  = _onWorkerResult;
      _worker.onerror    = function (e) {
        console.warn('[ArgusTemperatureLayer] worker error:', e.message);
        _workerBusy = false;
        if (_pendingMsg) _flushPending();
      };
    } catch (err) {
      console.warn('[ArgusTemperatureLayer] worker unavailable:', err.message);
    }
  }

  // Dispatch a compute job. If worker is busy, queue latest request (latest wins).
  function _dispatchWorker(xMin, yMin, w, h) {
    var msg = {
      stations: _allStations,
      xMin:     xMin,
      yMin:     yMin,
      w:        w,
      h:        h,
      idwP:     IDW_P,
      idwN:     IDW_N,
    };

    if (!_worker) {
      // Fallback: skip computation when worker is unavailable
      return;
    }

    if (_workerBusy) {
      _pendingMsg = msg; // newest request always wins
      return;
    }

    _workerBusy = true;
    _pendingMsg = null;
    _worker.postMessage(msg);
  }

  function _flushPending() {
    if (!_pendingMsg || !_worker) return;
    var msg = _pendingMsg;
    _pendingMsg  = null;
    _workerBusy  = true;
    _worker.postMessage(msg);
  }

  function _onWorkerResult(e) {
    _workerBusy = false;

    var r = e.data;
    if (r.error) {
      console.warn('[ArgusTemperatureLayer] worker:', r.error);
      if (_pendingMsg) _flushPending();
      return;
    }

    if (!_ctx) return;

    // Write interpolated pixels (use buffer view to avoid data copy)
    var imgData = new ImageData(new Uint8ClampedArray(r.pixels.buffer), r.w, r.h);
    _ctx.putImageData(imgData, r.xMin, r.yMin);

    if (_canvasTex) _canvasTex.needsUpdate = true;

    // Cache result for export
    _lastResult = { temps: r.temps, xMin: r.xMin, yMin: r.yMin, w: r.w, h: r.h, ts: Date.now() };
    if (_exportBtn) _exportBtn.disabled = false;

    if (_pendingMsg) _flushPending();
  }

  // ── Hover tooltip ─────────────────────────────────────────────────────────────

  function _initTooltip() {
    var el = document.createElement('div');
    el.id = 'argus-temp-tooltip';
    el.style.cssText = [
      'position:fixed', 'z-index:9999', 'pointer-events:none',
      'display:none',
      'background:rgba(2,8,20,0.88)',
      'border:1px solid rgba(0,140,200,0.4)',
      'border-radius:3px',
      'padding:5px 9px',
      'font-family:var(--font-mono,monospace)',
      'font-size:10px',
      'letter-spacing:1px',
      'color:#b0cfe0',
      'white-space:nowrap',
      'box-shadow:0 2px 8px rgba(0,0,0,0.6)',
    ].join(';');
    document.body.appendChild(el);
    _tooltip = el;
  }

  function _showTooltip(clientX, clientY, lat, lon, t, observed) {
    if (!_tooltip || !_visible) return;
    var unit  = localStorage.getItem('argus-temp-unit') || 'C';
    var tDisp = t !== null ? (unit === 'F'
      ? (t * 9 / 5 + 32).toFixed(1) + ' °F'
      : t.toFixed(1) + ' °C') : '—';
    var tag   = observed ? '<span style="color:#4af;font-size:8px"> OBS</span>'
                         : '<span style="color:#888;font-size:8px"> EST</span>';
    _tooltip.innerHTML = tDisp + tag +
      '<br><span style="color:#3a6a8a;font-size:8px">' +
      Math.abs(lat).toFixed(2) + (lat >= 0 ? '°N ' : '°S ') +
      Math.abs(lon).toFixed(2) + (lon >= 0 ? '°E' : '°W') + '</span>';
    _tooltip.style.display  = 'block';
    _tooltip.style.left     = (clientX + 14) + 'px';
    _tooltip.style.top      = (clientY - 10) + 'px';
  }

  function _hideTooltip() {
    if (_tooltipTimer) { clearTimeout(_tooltipTimer); _tooltipTimer = null; }
    if (_tooltip) _tooltip.style.display = 'none';
  }

  // ── IDW at a point — main thread (for hover, brute force over ≤2500 pts) ──────

  function _idwAtPoint(lat, lon) {
    if (!_allStations.length) return { t: null, observed: false };

    var k = Math.min(IDW_N, _allStations.length);
    // Simple linear scan — acceptable for k=8, N≤2500 per hover event
    var best = [];
    for (var i = 0; i < _allStations.length; i++) {
      var s    = _allStations[i];
      if (s.t === null || s.t !== s.t) continue;
      var dlat = lat - s.lat;
      var dlon = lon - s.lon;
      var d2   = dlat * dlat + dlon * dlon;
      if (best.length < k) {
        best.push({ d2: d2, t: s.t });
        if (best.length === k) best.sort(function(a,b){return b.d2-a.d2;});
      } else if (d2 < best[0].d2) {
        best[0] = { d2: d2, t: s.t };
        best.sort(function(a,b){return b.d2-a.d2;});
      }
    }

    if (!best.length) return { t: null, observed: false };

    // Exact station hit?
    var threshold = _tileRes > 0 ? (_tileRes * 0.5) * (_tileRes * 0.5) : 25; // (res/2)²
    if (best[best.length - 1].d2 < threshold * 0.01) {
      return { t: best[best.length - 1].t, observed: true };
    }

    var wSum = 0, tSum = 0;
    for (var j = 0; j < best.length; j++) {
      if (best[j].d2 === 0) return { t: best[j].t, observed: true };
      var w = 1 / Math.pow(best[j].d2, IDW_P / 2);
      wSum += w;
      tSum += w * best[j].t;
    }
    return { t: wSum > 0 ? tSum / wSum : null, observed: false };
  }

  // ── Hover raycasting ──────────────────────────────────────────────────────────
  // Desktop: tooltip follows cursor (pointermove). Hides on pointerleave.
  // Mobile:  tooltip appears on tap (pointerdown). Auto-dismisses after 4s.
  //          Touch drag (pointermove with pointerType≠mouse) is ignored to
  //          avoid flickering during globe pan gestures.

  function _initHover() {
    var AG    = window.ArgusGlobe;
    var THREE = window.THREE;
    if (!AG || !AG.renderer || !THREE || !_mesh) {
      // Renderer not ready yet — retry once after a further delay
      setTimeout(_initHover, 1000);
      return;
    }

    _raycaster = new THREE.Raycaster();
    var mouse  = new THREE.Vector2();
    var canvas = AG.renderer.domElement;

    function _hitToTooltip(clientX, clientY) {
      var rect = canvas.getBoundingClientRect();
      mouse.x  =  ((clientX - rect.left) / rect.width)  * 2 - 1;
      mouse.y  = -((clientY - rect.top)  / rect.height) * 2 + 1;

      _raycaster.setFromCamera(mouse, AG.camera);
      var hits = _raycaster.intersectObject(_mesh);
      if (!hits.length) { _hideTooltip(); return; }

      var uv = hits[0].uv;
      // UV maps directly to canvas coordinates:
      //   canvas x = u × 360  →  lon = canvas_x − 180  (approx)
      //   canvas y = v × 180  →  lat = 90 − canvas_y   (v=0 = north pole)
      var lon = uv.x * 360 - 180;
      var lat = 90   - uv.y * 180;

      var res = _idwAtPoint(lat, lon);
      _showTooltip(clientX, clientY, lat, lon, res.t, res.observed);
    }

    // Desktop — follow cursor
    canvas.addEventListener('pointermove', function (e) {
      if (!_visible || !_raycaster || e.pointerType !== 'mouse') return;
      _hitToTooltip(e.clientX, e.clientY);
    });

    // Mobile — show on tap, auto-dismiss after 4 s
    canvas.addEventListener('pointerdown', function (e) {
      if (!_visible || !_raycaster || e.pointerType === 'mouse') return;
      if (_tooltipTimer) { clearTimeout(_tooltipTimer); _tooltipTimer = null; }
      _hitToTooltip(e.clientX, e.clientY);
      _tooltipTimer = setTimeout(_hideTooltip, 4000);
    });

    // Desktop — hide when cursor leaves globe canvas
    canvas.addEventListener('pointerleave', function (e) {
      if (e.pointerType !== 'mouse') return;
      _hideTooltip();
    });
  }

  // ── Worker dispatch helpers ───────────────────────────────────────────────────

  // Full canvas redraw — used for global base refresh or returning to LOD 0.
  function _scheduleFullRedraw() {
    _mergeStations();
    if (!_allStations.length) return;
    _dispatchWorker(0, 0, CANVAS_W, CANVAS_H);
  }

  // Viewport region redraw — used after a fine tile lands.
  function _scheduleRegionRedraw(bbox) {
    _mergeStations();
    if (!_allStations.length) return;
    var feather = (_tileRes || 10) * 3;
    var xMin = Math.max(0,            Math.floor(bbox.lonMin + 179.5 - feather));
    var xMax = Math.min(CANVAS_W - 1, Math.ceil( bbox.lonMax + 179.5 + feather));
    var yMin = Math.max(0,            Math.floor(89.5 - bbox.latMax  - feather));
    var yMax = Math.min(CANVAS_H - 1, Math.ceil( 89.5 - bbox.latMin  + feather));
    var w    = xMax - xMin + 1;
    var h    = yMax - yMin + 1;
    if (w > 0 && h > 0) _dispatchWorker(xMin, yMin, w, h);
  }

  // ── LOD + viewport helpers ────────────────────────────────────────────────────

  function _getLodTier(dist) {
    for (var i = 0; i < LOD_TIERS.length; i++) {
      if (dist <= LOD_TIERS[i].maxDist) return LOD_TIERS[i];
    }
    return LOD_TIERS[LOD_TIERS.length - 1];
  }

  function _getViewportBounds(dist, res) {
    var AG = window.ArgusGlobe;
    if (!AG || !AG.dataGroup) {
      return { latMin: -85, latMax: 85, lonMin: -180, lonMax: 180 };
    }
    var capAngle = Math.asin(Math.min(0.999, 100 / dist)) * 180 / Math.PI;
    var extent   = capAngle * 1.15;
    if (MAX_EXTENT[res] !== undefined && extent > MAX_EXTENT[res]) extent = MAX_EXTENT[res];

    var dg        = AG.dataGroup;
    // dataGroup.rotation.y = -lon×π/180 − π/2, so lon = -(Ry + π/2)×180/π
    var lonCenter = -(dg.rotation.y) * 180 / Math.PI - 90;
    // dataGroup.rotation.x ≈ lat×π/180 (from focusEntity), so lat = Rx×180/π
    var latCenter =  (dg.rotation.x) * 180 / Math.PI;
    lonCenter     = ((lonCenter + 180) % 360 + 360) % 360 - 180;

    return {
      latMin: Math.max(-85,  +(latCenter - extent).toFixed(1)),
      latMax: Math.min( 85,  +(latCenter + extent).toFixed(1)),
      lonMin: Math.max(-180, +(lonCenter - extent).toFixed(1)),
      lonMax: Math.min( 180, +(lonCenter + extent).toFixed(1)),
    };
  }

  function _tileKey(res, bbox) {
    var snap = function (v, r) { return +(Math.round(v / r) * r).toFixed(1); };
    return res + '_' +
      snap(bbox.latMin, res) + '_' + snap(bbox.latMax, res) + '_' +
      snap(bbox.lonMin, res) + '_' + snap(bbox.lonMax, res);
  }

  // ── Tile request ──────────────────────────────────────────────────────────────

  function _requestTile(bbox, res) {
    var key = _tileKey(res, bbox);

    if (_tileCache[key]) {
      var hit    = _tileCache[key];
      _tileData      = hit.grid;
      _tileRes       = hit.resolution;
      _activeTileKey = key;
      _scheduleRegionRedraw(hit.bbox);
      return;
    }

    if (_inflight[key]) return;
    _inflight[key] = true;

    var t0     = Date.now();
    var params = '?latMin=' + bbox.latMin + '&latMax=' + bbox.latMax +
                 '&lonMin=' + bbox.lonMin + '&lonMax=' + bbox.lonMax +
                 '&res='    + res;

    fetch(TILE_URL + params)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        _inflight[key] = false;
        if (!data || !Array.isArray(data.grid)) {
          console.warn('[ArgusTemperatureLayer] unexpected tile response');
          return;
        }
        _tileCache[key] = data;
        _tileData       = data.grid;
        _tileRes        = data.resolution;
        _activeTileKey  = key;
        _diag.tilesInCache = Object.keys(_tileCache).length;
        _diag.lastTileMs   = Date.now() - t0;

        _scheduleRegionRedraw(data.bbox);

        console.log('[ArgusTemperatureLayer] LOD' + _currentLod +
          ' (' + res + '°) ' + data.grid.length + ' pts, ' + _diag.lastTileMs + 'ms');
      })
      .catch(function (err) {
        _inflight[key] = false;
        console.warn('[ArgusTemperatureLayer] tile fetch failed:', err.message);
      });
  }

  // ── Camera poll ───────────────────────────────────────────────────────────────

  function _onCameraPoll() {
    var AG = window.ArgusGlobe;
    if (!AG || !AG.camera || !_visible || !_baseData) return;

    var dist = AG.camera.position.length();
    var tier = _getLodTier(dist);

    _currentLod    = tier.lod;
    _diag.lod      = tier.lod;
    _diag.lodLabel = tier.label;

    if (tier.lod === 0) {
      if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
      if (_tileData) {
        // Returned to global — drop tile, full redraw with base only
        _tileData      = null;
        _tileRes       = 0;
        _activeTileKey = null;
        _scheduleFullRedraw();
      }
      return;
    }

    if (_debounceTimer) clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(function () {
      _debounceTimer = null;
      var bounds = _getViewportBounds(dist, tier.res);
      _requestTile(bounds, tier.res);
    }, DEBOUNCE_MS);
  }

  // ── Export ────────────────────────────────────────────────────────────────────

  function _cToF(c) { return Math.round(c * 9 / 5 + 32); }

  function _distNearestKm(lat, lon) {
    var best = Infinity;
    for (var i = 0; i < _allStations.length; i++) {
      var s    = _allStations[i];
      var dlat = lat - s.lat;
      var dlon = lon - s.lon;
      var d2   = dlat * dlat + dlon * dlon;
      if (d2 < best) best = d2;
    }
    return best === Infinity ? null : +(Math.sqrt(best) * 111.32).toFixed(1);
  }

  function _buildExportGrid() {
    if (!_lastResult) return [];
    var r         = _lastResult;
    var rows      = [];
    var obsThresh = _tileRes > 0 ? _tileRes * 0.5 * 111.32 * 0.1 : 5.57;
    for (var row = 0; row < r.h; row++) {
      var lat = 89.5 - (r.yMin + row);
      for (var col = 0; col < r.w; col++) {
        var lon = (r.xMin + col) - 179.5;
        var t   = r.temps[row * r.w + col];
        if (t !== t) continue; // NaN = no data
        var nearKm  = _distNearestKm(lat, lon);
        var isObs   = nearKm !== null && nearKm < obsThresh;
        rows.push({
          lat:        +lat.toFixed(3),
          lon:        +lon.toFixed(3),
          t_c:        +t.toFixed(2),
          t_f:        +(t * 9 / 5 + 32).toFixed(2),
          type:       isObs ? 'observed' : 'estimated',
          confidence: isObs ? 'HIGH' : 'MEDIUM',
          nearest_km: nearKm,
        });
      }
    }
    return rows;
  }

  function _timestamp() {
    var d = new Date();
    return d.getFullYear() +
      ('0' + (d.getMonth() + 1)).slice(-2) +
      ('0' + d.getDate()).slice(-2) + '_' +
      ('0' + d.getHours()).slice(-2) +
      ('0' + d.getMinutes()).slice(-2) +
      ('0' + d.getSeconds()).slice(-2);
  }

  function _triggerDownload(content, filename, mimeType) {
    var blob = new Blob([content], { type: mimeType });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  function _exportJSON() {
    if (!_lastResult) return;
    var grid    = _buildExportGrid();
    var payload = {
      metadata: {
        generated:   new Date().toISOString(),
        source:      'Open-Meteo CC BY 4.0 (IDW interpolation)',
        stations:    _allStations.length,
        grid_pixels: grid.length,
        region: {
          xMin: _lastResult.xMin, yMin: _lastResult.yMin,
          w:    _lastResult.w,    h:    _lastResult.h,
        },
      },
      stations: _allStations.map(function (s) {
        return { lat: s.lat, lon: s.lon, t_c: s.t,
          t_f: +(s.t * 9 / 5 + 32).toFixed(2) };
      }),
      grid: grid,
    };
    _triggerDownload(JSON.stringify(payload, null, 2),
      'argus_thermal_' + _timestamp() + '.json', 'application/json');
  }

  function _exportMDS() {
    if (!_lastResult) return;
    var grid  = _buildExportGrid();
    var lines = [
      '# ARGUS THERMAL EXPORT',
      '# Generated: '  + new Date().toISOString(),
      '# Source: Open-Meteo CC BY 4.0 (IDW interpolation)',
      '# Stations: '   + _allStations.length,
      '# Grid: ' + _lastResult.w + 'x' + _lastResult.h +
        ' pixels, xMin=' + _lastResult.xMin + ' yMin=' + _lastResult.yMin,
      'LAT,LON,TEMP_C,TEMP_F,TYPE,CONFIDENCE,NEAREST_KM',
    ];
    for (var i = 0; i < grid.length; i++) {
      var g = grid[i];
      lines.push(g.lat + ',' + g.lon + ',' + g.t_c + ',' + g.t_f + ',' +
        g.type + ',' + g.confidence + ',' +
        (g.nearest_km !== null ? g.nearest_km : ''));
    }
    _triggerDownload(lines.join('\n'),
      'argus_thermal_' + _timestamp() + '.mds', 'text/plain');
  }

  function _doExport(format) {
    if (!_lastResult || !_exportBtn) return;
    var label        = _exportBtn.textContent;
    _exportBtn.textContent = 'EXPORTING...';
    _exportBtn.disabled    = true;
    setTimeout(function () {
      try {
        if (format === 'json') _exportJSON();
        else if (format === 'mds') _exportMDS();
      } catch (err) {
        console.warn('[ArgusTemperatureLayer] export failed:', err.message);
      }
      _exportBtn.textContent = label;
      _exportBtn.disabled    = !_lastResult;
    }, 40);
  }

  // ── Legend ────────────────────────────────────────────────────────────────────

  function _buildLegend() {
    var existing = document.getElementById('argus-temp-legend');
    if (existing) existing.remove();
    _exportBtn = null;

    var unit = localStorage.getItem('argus-temp-unit') || 'C';

    var el = document.createElement('div');
    el.id = 'argus-temp-legend';
    el.style.cssText = [
      'position:absolute', 'bottom:44px', 'left:12px',
      'z-index:50', 'pointer-events:none',
      'font-family:var(--font-mono,monospace)', 'font-size:7.5px',
      'letter-spacing:1.2px', 'background:rgba(2,8,20,0.82)',
      'border:1px solid rgba(0,100,160,0.38)', 'border-radius:2px',
      'padding:6px 8px', 'display:none', 'user-select:none',
    ].join(';');

    var hdr = document.createElement('div');
    hdr.style.cssText = 'color:#2a6a8a;margin-bottom:5px;letter-spacing:2px';
    hdr.textContent = 'TEMP (2m °' + unit + ')';
    el.appendChild(hdr);

    // Gradient bar
    var bar = document.createElement('canvas');
    bar.width  = 100; bar.height = 8;
    bar.style.cssText = 'display:block;border-radius:1px;margin-bottom:4px';
    var bctx = bar.getContext('2d');
    var grad = bctx.createLinearGradient(0, 0, 100, 0);
    COLOR_STOPS.forEach(function (s, idx) {
      grad.addColorStop(idx / (COLOR_STOPS.length - 1),
        'rgb(' + s.r + ',' + s.g + ',' + s.b + ')');
    });
    bctx.fillStyle = grad;
    bctx.fillRect(0, 0, 100, 8);
    el.appendChild(bar);

    // Tick labels
    var ticks = document.createElement('div');
    ticks.style.cssText = 'display:flex;justify-content:space-between;width:100px;color:#5a8aa8';
    var labelVals = unit === 'F'
      ? [_cToF(-50) + '°', _cToF(-10) + '°', _cToF(25) + '°', _cToF(50) + '°']
      : ['−50°', '−10°', '25°', '50°'];
    labelVals.forEach(function (txt) {
      var span = document.createElement('span');
      span.textContent = txt;
      ticks.appendChild(span);
    });
    el.appendChild(ticks);

    // Attribution note
    var note = document.createElement('div');
    note.style.cssText = 'color:#2a4a5a;margin-top:4px;font-size:6.5px;letter-spacing:0.8px';
    note.textContent = 'Open-Meteo CC BY 4.0 · IDW interpolation';
    el.appendChild(note);

    // Export row
    var exportRow = document.createElement('div');
    exportRow.style.cssText = 'margin-top:5px;position:relative;pointer-events:all';

    var btn = document.createElement('button');
    btn.textContent = 'EXPORT';
    btn.disabled    = !_lastResult;
    btn.style.cssText = [
      'font-family:var(--font-mono,monospace)',
      'font-size:9px',
      'letter-spacing:2px',
      'text-transform:uppercase',
      'background:transparent',
      'border:1px solid rgba(0,100,160,0.45)',
      'color:#3a6a8a',
      'padding:2px 7px',
      'border-radius:2px',
      'cursor:pointer',
      'transition:border-color 0.15s,color 0.15s,background 0.15s',
      'width:100%',
    ].join(';');
    btn.onmouseover = function () {
      if (!btn.disabled) {
        btn.style.borderColor = '#00aaff';
        btn.style.color       = '#00aaff';
        btn.style.background  = 'rgba(0,170,255,0.08)';
      }
    };
    btn.onmouseout = function () {
      btn.style.borderColor = 'rgba(0,100,160,0.45)';
      btn.style.color       = '#3a6a8a';
      btn.style.background  = 'transparent';
    };

    // Dropdown
    var drop = document.createElement('div');
    drop.style.cssText = [
      'display:none',
      'position:absolute',
      'bottom:calc(100% + 3px)',
      'left:0',
      'background:rgba(2,8,20,0.95)',
      'border:1px solid rgba(0,100,160,0.45)',
      'border-radius:2px',
      'overflow:hidden',
      'min-width:100%',
      'z-index:100',
    ].join(';');

    function _makeDropItem(label, fmt) {
      var item = document.createElement('button');
      item.textContent = label;
      item.style.cssText = [
        'display:block', 'width:100%', 'text-align:left',
        'font-family:var(--font-mono,monospace)',
        'font-size:9px', 'letter-spacing:2px', 'text-transform:uppercase',
        'background:transparent', 'border:none',
        'color:#3a6a8a', 'padding:4px 8px', 'cursor:pointer',
        'transition:color 0.12s,background 0.12s',
      ].join(';');
      item.onmouseover = function () {
        item.style.color      = '#00aaff';
        item.style.background = 'rgba(0,170,255,0.08)';
      };
      item.onmouseout = function () {
        item.style.color      = '#3a6a8a';
        item.style.background = 'transparent';
      };
      item.onclick = function (e) {
        e.stopPropagation();
        drop.style.display = 'none';
        _doExport(fmt);
      };
      return item;
    }

    drop.appendChild(_makeDropItem('JSON', 'json'));
    drop.appendChild(_makeDropItem('MDS',  'mds'));

    btn.onclick = function (e) {
      e.stopPropagation();
      drop.style.display = drop.style.display === 'none' ? 'block' : 'none';
    };

    document.addEventListener('click', function () { drop.style.display = 'none'; });

    exportRow.appendChild(drop);
    exportRow.appendChild(btn);
    el.appendChild(exportRow);

    _exportBtn = btn;

    document.body.appendChild(el);
    return el;
  }

  // ── Init ──────────────────────────────────────────────────────────────────────

  function init() {
    if (_mesh) return;

    var AG    = window.ArgusGlobe;
    var THREE = window.THREE;
    if (!AG || !AG.globeGroup) {
      console.warn('[ArgusTemperatureLayer] ArgusGlobe not ready');
      return;
    }
    if (!THREE) {
      console.warn('[ArgusTemperatureLayer] THREE not available');
      return;
    }

    // ── Canvas + sphere mesh ───────────────────────────────────────────────────
    _canvas        = document.createElement('canvas');
    _canvas.width  = CANVAS_W;
    _canvas.height = CANVAS_H;
    _ctx           = _canvas.getContext('2d');
    _ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    _canvasTex           = new THREE.CanvasTexture(_canvas);
    _canvasTex.minFilter = THREE.LinearFilter;
    _canvasTex.magFilter = THREE.LinearFilter;
    _canvasTex.wrapS     = THREE.RepeatWrapping;

    var mat  = new THREE.MeshBasicMaterial({
      map:         _canvasTex,
      transparent: true,
      opacity:     OPACITY,
      depthWrite:  false,
      side:        THREE.FrontSide,
    });

    _mesh            = new THREE.Mesh(new THREE.SphereGeometry(SPHERE_R, 128, 64), mat);
    _mesh.rotation.y = -Math.PI / 2;
    _mesh.visible    = false;
    AG.globeGroup.add(_mesh);
    _diag.meshReady  = true;

    // ── Worker + tooltip + hover ───────────────────────────────────────────────
    _initWorker();
    _initTooltip();
    // Defer hover init — renderer.domElement may not exist at init() call time.
    // _initHover retries automatically if renderer is still unavailable.
    setTimeout(_initHover, 800);

    // ── Legend ─────────────────────────────────────────────────────────────────
    _buildLegend();
    document.addEventListener('argus-settings-changed', function (e) {
      if (e && e.detail && e.detail.tempUnit) {
        _buildLegend();
        if (_visible) {
          var leg = document.getElementById('argus-temp-legend');
          if (leg) leg.style.display = 'block';
        }
      }
    });

    // ── Timers ─────────────────────────────────────────────────────────────────
    refresh();
    _baseTimer = setInterval(refresh,       BASE_REFRESH_MS);
    _pollTimer = setInterval(_onCameraPoll, CAMERA_POLL_MS);
  }

  // ── Base layer fetch ──────────────────────────────────────────────────────────

  function refresh() {
    fetch(BASE_URL)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!data || !Array.isArray(data.grid)) {
          console.warn('[ArgusTemperatureLayer] unexpected base response');
          return;
        }
        _baseData = data.grid;

        // Full canvas IDW redraw. Worker blends tile data too if still active.
        _scheduleFullRedraw();
      })
      .catch(function (err) {
        console.warn('[ArgusTemperatureLayer] base fetch failed:', err.message);
      });
  }

  // ── Visibility ────────────────────────────────────────────────────────────────

  function setVisible(on) {
    _visible = on;
    if (window.ArgusLayerState) window.ArgusLayerState.temperature = on;
    if (_mesh) _mesh.visible = on;
    var leg = document.getElementById('argus-temp-legend');
    if (leg) leg.style.display = on ? 'block' : 'none';
    var btn = document.getElementById('btn-track-temp');
    if (btn) btn.classList.toggle('is-active', on);
    if (!on) _hideTooltip();
    if (on && !_baseData) refresh();
  }

  function toggle() { setVisible(!_visible); }

  // ── Diagnostics ───────────────────────────────────────────────────────────────

  function status() {
    return {
      lod:            _diag.lod,
      lodLabel:       _diag.lodLabel,
      stationsTotal:  _diag.stationsTotal,
      stationsBase:   _baseData ? _baseData.length : 0,
      stationsTile:   _tileData ? _tileData.length : 0,
      lastTileMs:     _diag.lastTileMs,
      tilesInCache:   _diag.tilesInCache,
      workerReady:    !!_worker,
      workerBusy:     _workerBusy,
      meshReady:      _diag.meshReady,
      canvasSize:     _diag.canvasSize,
    };
  }

  return {
    init:       init,
    toggle:     toggle,
    setVisible: setVisible,
    refresh:    refresh,
    status:     status,
  };

}());
