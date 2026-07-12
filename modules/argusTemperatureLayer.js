'use strict';
// modules/argusTemperatureLayer.js
// Adaptive LOD global temperature heatmap overlay on the Three.js globe.
//
// ── ARCHITECTURE ──────────────────────────────────────────────────────────────
//
//   Single 360×180 canvas texture (1° per pixel) mapped onto a sphere at
//   r=100.5 (128×64 segments). Every pixel is computed by JS-side bilinear
//   interpolation and written via ImageData.putImageData — one GPU upload.
//   THREE.LinearFilter adds a final anti-alias pass on the GPU.
//   Result: a completely smooth, continuously-refined scalar field with
//   no visible squares, no grid artefacts, no tile seams.
//
//   LOD TIERS  (camera distance from globe centre, globe radius = 100):
//   ┌────┬─────────────┬──────┬─────────────────────────────────────────┐
//   │Tier│ Label       │ Res  │ Camera dist                             │
//   ├────┼─────────────┼──────┼─────────────────────────────────────────┤
//   │  0 │ Global      │ 10°  │ > 280   base only                       │
//   │  1 │ Continental │  5°  │ 200–280 tile fetched; _updateRegion     │
//   │  2 │ Regional    │  2°  │ 140–200 tile fetched; _updateRegion     │
//   │  3 │ City        │  1°  │ ≤ 140   tile fetched; _updateRegion     │
//   └────┴─────────────┴──────┴─────────────────────────────────────────┘
//
//   BASE LAYER — always present:
//     648 pts at 10°, fetched from fetch-temperature (2h TTL).
//     _rebuildCanvas() writes all 64,800 pixels via bilinear interpolation.
//
//   REFINED TILES — viewport only (LOD 1–3):
//     Fetched from fetch-temperature-tile on camera settle (600ms debounce).
//     _updateRegion() rewrites only the affected canvas region.
//     Smooth-step feathering (_tileRes × 3°) eliminates tile-edge seams.
//
// ── INTERPOLATION ─────────────────────────────────────────────────────────────
//   Base bilinear: latN/latS from 85−10k formula; lonW/lonE from −175+10k.
//   Tile bilinear: latN = ceil(lat/res)*res; lonW = floor(lon/res)*res.
//   Feather: insideDist = min distance to any tile edge (degrees).
//     insideDist ≥ feather → use tile value
//     0 ≤ insideDist < feather → blend: w = w²(3−2w), mix base→tile
//     insideDist < 0 → use base value
//
// ── SPHERE ────────────────────────────────────────────────────────────────────
//   r=100.5, 128×64 segments. Face centres ≈100.44, above globe (r=100).
//   depthWrite:false prevents overwriting marker depth values.
//
// ── DATA ATTRIBUTION ─────────────────────────────────────────────────────────
//   Open-Meteo (https://open-meteo.com) — CC BY 4.0.

window.ArgusTemperatureLayer = (function () {
  'use strict';

  // ── Config ───────────────────────────────────────────────────────────────────

  var CANVAS_W        = 360;
  var CANVAS_H        = 180;
  var SPHERE_R        = 100.5;
  var OPACITY         = 0.70;
  var BASE_URL        = '/.netlify/functions/fetch-temperature';
  var TILE_URL        = '/.netlify/functions/fetch-temperature-tile';
  var BASE_REFRESH_MS = 2 * 60 * 60 * 1000;
  var CAMERA_POLL_MS  = 500;
  var DEBOUNCE_MS     = 600;

  var LOD_TIERS = [
    { lod: 3, res:  1, maxDist: 140, label: 'City'        },
    { lod: 2, res:  2, maxDist: 200, label: 'Regional'    },
    { lod: 1, res:  5, maxDist: 280, label: 'Continental' },
    { lod: 0, res: 10, maxDist: Infinity, label: 'Global' },
  ];

  // Max viewport extent per resolution — keeps Open-Meteo point counts safe
  var MAX_EXTENT = { 5: 75, 2: 55, 1: 38 };

  // Temperature-to-color stops (°C)
  var COLOR_STOPS = [
    { t: -50, r: 30,  g: 30,  b: 150 },  // deep blue-purple
    { t: -20, r: 0,   g: 80,  b: 255 },  // bright blue
    { t:   0, r: 0,   g: 200, b: 255 },  // cyan
    { t:  15, r: 0,   g: 210, b: 80  },  // green
    { t:  25, r: 255, g: 215, b: 0   },  // yellow
    { t:  35, r: 255, g: 75,  b: 0   },  // orange-red
    { t:  50, r: 180, g: 0,   b: 50  },  // deep red
  ];

  // ── Module state ──────────────────────────────────────────────────────────────

  var _mesh          = null;
  var _canvasTex     = null;
  var _canvas        = null;
  var _ctx           = null;
  var _visible       = false;
  var _baseData      = null;
  var _baseHash      = null;   // { 'lat_lon': t } — base grid lookup
  var _tileHash      = null;   // { 'lat_lon': t } — active fine tile lookup
  var _tileBbox      = null;   // { latMin, latMax, lonMin, lonMax }
  var _tileRes       = 0;      // active fine tile resolution (degrees)
  var _baseTimer     = null;
  var _pollTimer     = null;
  var _debounceTimer = null;
  var _inflight      = {};
  var _tileCache     = {};
  var _currentLod    = 0;
  var _activeTileKey = null;

  var _diag = {
    lod: 0, lodLabel: 'Global', visibleTiles: 1,
    samplesLoaded: 0, samplesRendered: 0,
    lastBbox: null, lastTileMs: null,
    canvasSize: CANVAS_W + '×' + CANVAS_H,
    maxOpenMeteoRes: '1°', memEstimateKB: 0,
  };

  // ── Temperature → RGB ─────────────────────────────────────────────────────────

  function _tempToRGB(t) {
    if (t === null || t === undefined || !isFinite(t)) {
      return { r: 80, g: 80, b: 80 };
    }
    var stops = COLOR_STOPS;
    if (t <= stops[0].t) return { r: stops[0].r, g: stops[0].g, b: stops[0].b };
    var last = stops[stops.length - 1];
    if (t >= last.t) return { r: last.r, g: last.g, b: last.b };
    for (var i = 0; i < stops.length - 1; i++) {
      if (t <= stops[i + 1].t) {
        var frac = (t - stops[i].t) / (stops[i + 1].t - stops[i].t);
        return {
          r: Math.round(stops[i].r + frac * (stops[i + 1].r - stops[i].r)),
          g: Math.round(stops[i].g + frac * (stops[i + 1].g - stops[i].g)),
          b: Math.round(stops[i].b + frac * (stops[i + 1].b - stops[i].b)),
        };
      }
    }
    return { r: last.r, g: last.g, b: last.b };
  }

  // String form used only by the legend gradient builder
  function _tempToColorStr(t) {
    var rgb = _tempToRGB(t);
    return 'rgb(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ')';
  }

  // ── Grid hash builder ─────────────────────────────────────────────────────────
  // Key: 'lat_lon' — matches the keys produced by bilinear corner lookups below.

  function _buildGridHash(samples) {
    var hash = {};
    for (var i = 0; i < samples.length; i++) {
      var s = samples[i];
      if (s.t !== null && s.t !== undefined) {
        hash[s.lat + '_' + s.lon] = s.t;
      }
    }
    return hash;
  }

  // ── 4-corner bilinear interpolation ──────────────────────────────────────────
  // fLat/fLon clamped to [0,1] so edge pixels extrapolate to nearest value.

  function _bilinear4(lat, lon, latS, latN, lonW, lonE, hash) {
    var tNW = hash[latN + '_' + lonW];
    var tNE = hash[latN + '_' + lonE];
    var tSW = hash[latS + '_' + lonW];
    var tSE = hash[latS + '_' + lonE];

    var fLon = (lonE > lonW)
      ? Math.max(0, Math.min(1, (lon - lonW) / (lonE - lonW))) : 0;
    var fLat = (latN > latS)
      ? Math.max(0, Math.min(1, (lat - latS) / (latN - latS))) : 0;

    if (tNW !== undefined && tNE !== undefined &&
        tSW !== undefined && tSE !== undefined) {
      var tN = tNW + fLon * (tNE - tNW);
      var tS = tSW + fLon * (tSE - tSW);
      return tS + fLat * (tN - tS);
    }

    // Partial corners — average what is available
    var sum = 0, count = 0;
    if (tNW !== undefined) { sum += tNW; count++; }
    if (tNE !== undefined) { sum += tNE; count++; }
    if (tSW !== undefined) { sum += tSW; count++; }
    if (tSE !== undefined) { sum += tSE; count++; }
    return count > 0 ? sum / count : null;
  }

  // ── Base grid bilinear ────────────────────────────────────────────────────────
  // Base lats: 85, 75, 65, …, −85 (step −10); base lons: −175, …, 175 (step 10)

  function _bilinearBase(lat, lon) {
    if (!_baseHash) return null;
    var latIdxN = Math.max(0, Math.min(17, Math.floor((85 - lat) / 10)));
    var latN    = 85 - latIdxN * 10;
    var latS    = Math.max(-85, latN - 10);
    var lonW    = Math.max(-175, Math.floor((lon + 175) / 10) * 10 - 175);
    var lonE    = Math.min( 175, lonW + 10);
    return _bilinear4(lat, lon, latS, latN, lonW, lonE, _baseHash);
  }

  // ── Fine tile bilinear ────────────────────────────────────────────────────────
  // Tile samples are at exact multiples of _tileRes within the tile bbox.

  function _bilinearTile(lat, lon) {
    if (!_tileHash || !_tileRes) return null;
    var res  = _tileRes;
    var latN = Math.ceil(lat  / res) * res;
    var latS = latN - res;
    var lonW = Math.floor(lon / res) * res;
    var lonE = lonW + res;
    return _bilinear4(lat, lon, latS, latN, lonW, lonE, _tileHash);
  }

  // ── Interpolated temperature ──────────────────────────────────────────────────
  // Smooth-step blends tile into base within feather zone at tile boundary.
  // feather = _tileRes × 3 degrees, measured inside the tile edge.

  function _interpolateTemp(lat, lon) {
    var tBase = _bilinearBase(lat, lon);
    if (!_tileBbox || !_tileHash) return tBase;

    var bbox    = _tileBbox;
    var feather = _tileRes * 3;

    // insideDist: positive inside tile, negative outside
    var insideDist = Math.min(
      lon - bbox.lonMin,
      bbox.lonMax - lon,
      lat - bbox.latMin,
      bbox.latMax - lat
    );

    if (insideDist < 0) return tBase;                // outside tile

    var tTile = _bilinearTile(lat, lon);
    if (tTile === null) return tBase;

    if (insideDist >= feather) return tTile;          // deep inside tile

    // Feather blend: smooth-step w = w²(3−2w)
    var w = insideDist / feather;
    w = w * w * (3 - 2 * w);
    return tBase !== null ? tBase + w * (tTile - tBase) : tTile;
  }

  // ── Full canvas rebuild ───────────────────────────────────────────────────────
  // Writes every pixel (64,800) then uploads a single ImageData.
  // Pixel centre: lat = 89.5 − y,  lon = x − 179.5

  function _rebuildCanvas() {
    if (!_ctx || !_baseHash) return;
    var imgData = _ctx.createImageData(CANVAS_W, CANVAS_H);
    var d       = imgData.data;
    for (var y = 0; y < CANVAS_H; y++) {
      var lat = 89.5 - y;
      for (var x = 0; x < CANVAS_W; x++) {
        var lon = x - 179.5;
        var t   = _interpolateTemp(lat, lon);
        var rgb = _tempToRGB(t);
        var idx = (y * CANVAS_W + x) * 4;
        d[idx]     = rgb.r;
        d[idx + 1] = rgb.g;
        d[idx + 2] = rgb.b;
        d[idx + 3] = (t !== null) ? 220 : 64;
      }
    }
    _ctx.putImageData(imgData, 0, 0);
    if (_canvasTex) _canvasTex.needsUpdate = true;
  }

  // ── Partial region update ─────────────────────────────────────────────────────
  // Rewrites only the canvas pixels covering bbox ± featherDeg.
  // Called after a tile loads — avoids a full 64,800-pixel rebuild.

  function _updateRegion(bbox, featherDeg) {
    if (!_ctx || !_baseHash) return;
    var fe   = featherDeg || 0;
    var xMin = Math.max(0,            Math.floor(bbox.lonMin + 179.5 - fe));
    var xMax = Math.min(CANVAS_W - 1, Math.ceil( bbox.lonMax + 179.5 + fe));
    var yMin = Math.max(0,            Math.floor(89.5 - bbox.latMax  - fe));
    var yMax = Math.min(CANVAS_H - 1, Math.ceil( 89.5 - bbox.latMin  + fe));
    var w    = xMax - xMin + 1;
    var h    = yMax - yMin + 1;
    if (w <= 0 || h <= 0) return;

    var imgData = _ctx.createImageData(w, h);
    var d       = imgData.data;
    for (var row = 0; row < h; row++) {
      var lat = 89.5 - (yMin + row);
      for (var col = 0; col < w; col++) {
        var lon = (xMin + col) - 179.5;
        var t   = _interpolateTemp(lat, lon);
        var rgb = _tempToRGB(t);
        var idx = (row * w + col) * 4;
        d[idx]     = rgb.r;
        d[idx + 1] = rgb.g;
        d[idx + 2] = rgb.b;
        d[idx + 3] = (t !== null) ? 220 : 64;
      }
    }
    _ctx.putImageData(imgData, xMin, yMin);
    if (_canvasTex) _canvasTex.needsUpdate = true;
  }

  // ── LOD tier lookup ───────────────────────────────────────────────────────────

  function _getLodTier(dist) {
    for (var i = 0; i < LOD_TIERS.length; i++) {
      if (dist <= LOD_TIERS[i].maxDist) return LOD_TIERS[i];
    }
    return LOD_TIERS[LOD_TIERS.length - 1];
  }

  // ── Viewport geographic bounds ────────────────────────────────────────────────

  function _getViewportBounds(dist, res) {
    var AG = window.ArgusGlobe;
    if (!AG || !AG.dataGroup) {
      return { latMin: -85, latMax: 85, lonMin: -180, lonMax: 180 };
    }
    var capAngle = Math.asin(Math.min(0.999, 100 / dist)) * 180 / Math.PI;
    var extent   = capAngle * 1.15;
    if (MAX_EXTENT[res] !== undefined && extent > MAX_EXTENT[res]) extent = MAX_EXTENT[res];

    var dg        = AG.dataGroup;
    var lonCenter = -(dg.rotation.y) * 180 / Math.PI;
    var latCenter = -(dg.rotation.x) * 180 / Math.PI;
    lonCenter     = ((lonCenter + 180) % 360 + 360) % 360 - 180;

    return {
      latMin: Math.max(-85,  +(latCenter - extent).toFixed(1)),
      latMax: Math.min( 85,  +(latCenter + extent).toFixed(1)),
      lonMin: Math.max(-180, +(lonCenter - extent).toFixed(1)),
      lonMax: Math.min( 180, +(lonCenter + extent).toFixed(1)),
    };
  }

  // ── Tile cache key ────────────────────────────────────────────────────────────

  function _tileKey(res, bbox) {
    var snap = function (v, r) { return +(Math.round(v / r) * r).toFixed(1); };
    return res + '_' +
      snap(bbox.latMin, res) + '_' + snap(bbox.latMax, res) + '_' +
      snap(bbox.lonMin, res) + '_' + snap(bbox.lonMax, res);
  }

  // ── Request a refined tile ────────────────────────────────────────────────────

  function _requestTile(bbox, res) {
    var key = _tileKey(res, bbox);

    // Memory cache hit — activate immediately, redraw region
    if (_tileCache[key]) {
      var hit    = _tileCache[key];
      _tileHash      = _buildGridHash(hit.grid);
      _tileBbox      = hit.bbox;
      _tileRes       = hit.resolution;
      _activeTileKey = key;
      _updateRegion(hit.bbox, res * 3);
      _diag.lastBbox = bbox;
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
        _tileHash       = _buildGridHash(data.grid);
        _tileBbox       = data.bbox;
        _tileRes        = data.resolution;
        _activeTileKey  = key;

        _updateRegion(data.bbox, res * 3);

        _diag.samplesLoaded   += data.grid.length;
        _diag.samplesRendered += data.grid.length;
        _diag.lastBbox         = bbox;
        _diag.lastTileMs       = Date.now() - t0;
        _diag.visibleTiles     = Object.keys(_tileCache).length + 1;
        _diag.memEstimateKB    = Math.round(
          (_diag.samplesLoaded * 12 + CANVAS_W * CANVAS_H * 4) / 1024
        );

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
      // Zoomed back out — discard tile, rebuild base-only canvas
      if (_tileHash) {
        _tileHash      = null;
        _tileBbox      = null;
        _tileRes       = 0;
        _activeTileKey = null;
        _rebuildCanvas();
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

  // ── Legend ────────────────────────────────────────────────────────────────────

  function _cToF(c) { return Math.round(c * 9 / 5 + 32); }

  function _buildLegend() {
    var existing = document.getElementById('argus-temp-legend');
    if (existing) existing.remove();

    var unit = localStorage.getItem('argus-temp-unit') || 'C';

    var el = document.createElement('div');
    el.id = 'argus-temp-legend';
    el.style.cssText = [
      'position:absolute', 'bottom:44px', 'left:12px',
      'z-index:50', 'pointer-events:none',
      'font-family:var(--font-mono,monospace)', 'font-size:7.5px',
      'letter-spacing:1.2px', 'background:rgba(2,8,20,0.78)',
      'border:1px solid rgba(0,100,160,0.38)', 'border-radius:2px',
      'padding:5px 8px', 'display:none', 'user-select:none',
    ].join(';');

    var hdr = document.createElement('div');
    hdr.style.cssText = 'color:#2a6a8a;margin-bottom:4px;letter-spacing:2px';
    hdr.textContent = 'TEMP (2m °' + unit + ')';
    el.appendChild(hdr);

    var bar  = document.createElement('canvas');
    bar.width = 90; bar.height = 7;
    bar.style.cssText = 'display:block;border-radius:1px;margin-bottom:3px';
    var bctx = bar.getContext('2d');
    var grad = bctx.createLinearGradient(0, 0, 90, 0);
    COLOR_STOPS.forEach(function (s, idx) {
      grad.addColorStop(idx / (COLOR_STOPS.length - 1),
        'rgb(' + s.r + ',' + s.g + ',' + s.b + ')');
    });
    bctx.fillStyle = grad;
    bctx.fillRect(0, 0, 90, 7);
    el.appendChild(bar);

    var labels = document.createElement('div');
    labels.style.cssText = 'display:flex;justify-content:space-between;width:90px;color:#5a8aa8';
    [
      unit === 'F' ? _cToF(-50) + '°F' : '−50°C',
      unit === 'F' ? _cToF(0)   + '°F' : '0°C',
      unit === 'F' ? _cToF(50)  + '°F' : '50°C',
    ].forEach(function (txt) {
      var span = document.createElement('span');
      span.textContent = txt;
      labels.appendChild(span);
    });
    el.appendChild(labels);

    var attr = document.createElement('div');
    attr.style.cssText = 'color:#2a4a5a;margin-top:3px;font-size:6.5px;letter-spacing:0.8px';
    attr.textContent = 'Open-Meteo CC BY 4.0';
    el.appendChild(attr);

    document.body.appendChild(el);
    return el;
  }

  // ── Init ──────────────────────────────────────────────────────────────────────

  function init() {
    if (_mesh) return;

    var AG = window.ArgusGlobe;
    if (!AG || !AG.globeGroup) {
      console.warn('[ArgusTemperatureLayer] ArgusGlobe not ready');
      return;
    }
    var THREE = window.THREE;
    if (!THREE) {
      console.warn('[ArgusTemperatureLayer] THREE not available');
      return;
    }

    _canvas        = document.createElement('canvas');
    _canvas.width  = CANVAS_W;
    _canvas.height = CANVAS_H;
    _ctx           = _canvas.getContext('2d');
    _ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    _canvasTex           = new THREE.CanvasTexture(_canvas);
    _canvasTex.minFilter = THREE.LinearFilter;
    _canvasTex.magFilter = THREE.LinearFilter;
    _canvasTex.wrapS     = THREE.RepeatWrapping;

    var material = new THREE.MeshBasicMaterial({
      map:         _canvasTex,
      transparent: true,
      opacity:     OPACITY,
      depthWrite:  false,
      side:        THREE.FrontSide,
    });

    _mesh            = new THREE.Mesh(new THREE.SphereGeometry(SPHERE_R, 128, 64), material);
    _mesh.rotation.y = -Math.PI / 2;
    _mesh.visible    = false;
    AG.globeGroup.add(_mesh);

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

    refresh();
    _baseTimer = setInterval(refresh,       BASE_REFRESH_MS);
    _pollTimer = setInterval(_onCameraPoll, CAMERA_POLL_MS);
  }

  // ── Base layer fetch ──────────────────────────────────────────────────────────
  // Builds _baseHash then calls _rebuildCanvas(), which auto-blends the active
  // tile (if any) via _interpolateTemp — no separate tile repaint needed.

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
        _baseHash = _buildGridHash(_baseData);

        _rebuildCanvas();

        _diag.samplesLoaded   += _baseData.length;
        _diag.samplesRendered += _baseData.length;
        _diag.memEstimateKB    = Math.round(CANVAS_W * CANVAS_H * 4 / 1024);
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
    if (on && !_baseData) refresh();
  }

  function toggle() { setVisible(!_visible); }

  // ── Diagnostics ───────────────────────────────────────────────────────────────

  function status() {
    return {
      lod:             _diag.lod,
      lodLabel:        _diag.lodLabel,
      visibleTiles:    _diag.visibleTiles,
      samplesLoaded:   _diag.samplesLoaded,
      samplesRendered: _diag.samplesRendered,
      lastBbox:        _diag.lastBbox,
      lastTileMs:      _diag.lastTileMs,
      canvasSize:      _diag.canvasSize,
      maxOpenMeteoRes: _diag.maxOpenMeteoRes,
      memEstimateKB:   _diag.memEstimateKB,
      tilesInCache:    Object.keys(_tileCache).length,
      hasBaseData:     !!_baseData,
      basePointCount:  _baseData ? _baseData.length : 0,
      meshReady:       !!_mesh,
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
