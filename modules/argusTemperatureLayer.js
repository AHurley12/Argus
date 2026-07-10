'use strict';
// modules/argusTemperatureLayer.js
// Adaptive LOD global temperature heatmap overlay on the Three.js globe.
//
// ── ARCHITECTURE ──────────────────────────────────────────────────────────────
//
//   Single 360×180 canvas texture (1° per pixel) mapped onto a sphere at
//   r=100.5 (128×64 segments). THREE.LinearFilter provides GPU interpolation
//   between adjacent pixels. No JS-side interpolation — Open-Meteo values are
//   painted directly; the GPU smooths transitions.
//
//   LOD TIERS  (camera distance from globe centre, globe radius = 100):
//   ┌────┬─────────────┬──────┬────────────────────┬──────────────────────┐
//   │Tier│ Label       │ Res  │ Camera dist        │ Canvas block         │
//   ├────┼─────────────┼──────┼────────────────────┼──────────────────────┤
//   │  0 │ Global      │ 10°  │ > 280              │ 10×10 px — base only │
//   │  1 │ Continental │  5°  │ 200 < d ≤ 280      │  5×5 px  — tile      │
//   │  2 │ Regional    │  2°  │ 140 < d ≤ 200      │  2×2 px  — tile      │
//   │  3 │ City        │  1°  │      d ≤ 140       │  1×1 px  — tile      │
//   └────┴─────────────┴──────┴────────────────────┴──────────────────────┘
//
//   BASE LAYER — always present:
//     Fetched from /.netlify/functions/fetch-temperature (648 pts, 10°, 2h TTL).
//     Painted as 10×10 px blocks on the 360×180 canvas. Covers the whole globe.
//
//   REFINED TILES — viewport only (LOD 1–3):
//     Fetched from /.netlify/functions/fetch-temperature-tile when the camera
//     settles (600ms debounce) at LOD > 0. Only the visible geographic bounds
//     are requested. Fine samples overwrite the coarser base-layer blocks for
//     that region without touching the rest of the canvas.
//
//   PROGRESSIVE RENDERING:
//     coarse (10°) → continental (5°) → regional (2°) → city (1°)
//     The canvas is updated incrementally on each tile arrival. No full rebuild.
//
// ── CANVAS COORDINATES ────────────────────────────────────────────────────────
//   Pixel (x, y) represents: lon = x − 180,  lat = 90 − y
//   Mapping a sample (lat, lon): x = round(lon + 180),  y = round(90 − lat)
//   Block fill: each sample paints a (res × res) px square centred at (x, y)
//   using half = floor(res / 2), so fillRect(x−half, y−half, res, res).
//   At all resolutions, adjacent blocks tile with zero gaps.
//
// ── SPHERE ────────────────────────────────────────────────────────────────────
//   r=100.5, 128×64 segments. At 128×64 the flat-face centre dip is ≈0.06 units
//   → minimum face radius ≈100.44, safely above globe (r=100) and coord grid
//   (r=100.39). depthWrite:false prevents writing over marker depth values.
//
// ── DIAGNOSTICS ───────────────────────────────────────────────────────────────
//   ArgusTemperatureLayer.status() returns:
//     lod, lodLabel, visibleTiles, samplesLoaded, samplesRendered,
//     lastBbox, lastTileMs, canvasSize, maxOpenMeteoRes,
//     memEstimateKB, tilesInCache, hasBaseData, basePointCount, meshReady
//
// ── GLOBALS ───────────────────────────────────────────────────────────────────
//   window.ArgusTemperatureLayer — { init, toggle, setVisible, refresh, status }
//   Init: call AFTER window.ArgusGlobe is set (index.html does this).
//
// ── DATA ATTRIBUTION ─────────────────────────────────────────────────────────
//   Open-Meteo (https://open-meteo.com) — CC BY 4.0.
//   Non-commercial use only on the free tier.

window.ArgusTemperatureLayer = (function () {
  'use strict';

  // ── Config ───────────────────────────────────────────────────────────────────

  var CANVAS_W        = 360;                    // 1° per pixel, longitude axis
  var CANVAS_H        = 180;                    // 1° per pixel, latitude axis
  var SPHERE_R        = 100.5;                  // above globe (100); flat-face centres clear surface
  var OPACITY         = 0.70;
  var BASE_URL        = '/.netlify/functions/fetch-temperature';
  var TILE_URL        = '/.netlify/functions/fetch-temperature-tile';
  var BASE_REFRESH_MS = 2 * 60 * 60 * 1000;    // base layer auto-refresh (2h)
  var CAMERA_POLL_MS  = 500;                    // LOD check cadence (ms)
  var DEBOUNCE_MS     = 600;                    // camera settle time before tile request

  // LOD tiers — checked in order, first match wins (finest-first).
  // maxDist: camera must be ≤ this distance to activate the tier.
  var LOD_TIERS = [
    { lod: 3, res:  1, maxDist: 140, label: 'City'        },
    { lod: 2, res:  2, maxDist: 200, label: 'Regional'    },
    { lod: 1, res:  5, maxDist: 280, label: 'Continental' },
    { lod: 0, res: 10, maxDist: Infinity, label: 'Global' },
  ];

  // Max viewport extent (degrees) per resolution — prevents exceeding server maxPts.
  // At each tier the visible cap is usually smaller than these limits, but edge
  // cases (very tilted globe) can widen the bbox; these caps guard against that.
  var MAX_EXTENT = { 5: 75, 2: 55, 1: 38 };

  // Temperature-to-color stops (°C). Faithful to Open-Meteo readings.
  var COLOR_STOPS = [
    { t: -50, r: 30,  g: 30,  b: 150 },  // deep blue-purple  (polar deep winter)
    { t: -20, r: 0,   g: 80,  b: 255 },  // bright blue       (sub-zero)
    { t:   0, r: 0,   g: 200, b: 255 },  // cyan              (freezing)
    { t:  15, r: 0,   g: 210, b: 80  },  // green             (mild / temperate)
    { t:  25, r: 255, g: 215, b: 0   },  // yellow            (warm)
    { t:  35, r: 255, g: 75,  b: 0   },  // orange-red        (hot)
    { t:  50, r: 180, g: 0,   b: 50  },  // deep red          (extreme heat)
  ];

  // ── Module state ──────────────────────────────────────────────────────────────

  var _mesh          = null;
  var _canvasTex     = null;
  var _canvas        = null;
  var _ctx           = null;
  var _visible       = false;
  var _baseData      = null;    // grid array from last base fetch
  var _baseTimer     = null;
  var _pollTimer     = null;
  var _debounceTimer = null;
  var _inflight      = {};      // tileKey → true while request is in flight
  var _tileCache     = {};      // tileKey → payload (in-memory; avoids re-fetch within session)
  var _currentLod    = 0;
  var _activeTileKey = null;    // key of the most recently rendered fine tile

  // Diagnostics counters
  var _diag = {
    lod:             0,
    lodLabel:        'Global',
    visibleTiles:    1,
    samplesLoaded:   0,
    samplesRendered: 0,
    lastBbox:        null,
    lastTileMs:      null,
    canvasSize:      CANVAS_W + '×' + CANVAS_H,
    maxOpenMeteoRes: '1°',
    memEstimateKB:   0,
  };

  // ── Temperature → color ───────────────────────────────────────────────────────

  function _tempToColorStr(t) {
    if (t === null || t === undefined || !isFinite(t)) {
      return 'rgba(80,80,80,0.25)'; // dim gray for missing cells
    }
    var stops = COLOR_STOPS;
    if (t <= stops[0].t) {
      return 'rgb(' + stops[0].r + ',' + stops[0].g + ',' + stops[0].b + ')';
    }
    var last = stops[stops.length - 1];
    if (t >= last.t) {
      return 'rgb(' + last.r + ',' + last.g + ',' + last.b + ')';
    }
    for (var i = 0; i < stops.length - 1; i++) {
      if (t <= stops[i + 1].t) {
        var frac = (t - stops[i].t) / (stops[i + 1].t - stops[i].t);
        var r    = Math.round(stops[i].r + frac * (stops[i + 1].r - stops[i].r));
        var g    = Math.round(stops[i].g + frac * (stops[i + 1].g - stops[i].g));
        var b    = Math.round(stops[i].b + frac * (stops[i + 1].b - stops[i].b));
        return 'rgb(' + r + ',' + g + ',' + b + ')';
      }
    }
    return 'rgb(' + last.r + ',' + last.g + ',' + last.b + ')';
  }

  // ── Canvas painting ───────────────────────────────────────────────────────────
  // Each sample paints a (res × res) px block centred at its canvas pixel.
  // half = floor(res/2) ensures adjacent blocks tile with no gaps:
  //   res=10 → 10×10 block; res=5 → 5×5; res=2 → 2×2; res=1 → 1×1
  // Returns the number of samples successfully painted.

  function _paintSamples(grid, res) {
    if (!_ctx || !grid || !grid.length) return 0;
    var half    = Math.floor(res / 2);
    var painted = 0;
    for (var i = 0; i < grid.length; i++) {
      var s = grid[i];
      if (s.t === null || s.t === undefined) continue;
      var x = Math.round(s.lon + 180);
      var y = Math.round(90   - s.lat);
      _ctx.fillStyle = _tempToColorStr(s.t);
      _ctx.fillRect(x - half, y - half, res, res);
      painted++;
    }
    if (_canvasTex) _canvasTex.needsUpdate = true;
    return painted;
  }

  // ── LOD tier lookup ───────────────────────────────────────────────────────────

  function _getLodTier(dist) {
    for (var i = 0; i < LOD_TIERS.length; i++) {
      if (dist <= LOD_TIERS[i].maxDist) return LOD_TIERS[i];
    }
    return LOD_TIERS[LOD_TIERS.length - 1]; // fallback: Global
  }

  // ── Viewport geographic bounds ────────────────────────────────────────────────
  // Approximates which geographic region the camera currently sees.
  //
  // The camera is fixed; the globe rotates under it. dataGroup.rotation tracks
  // the geographic face toward the camera:
  //   lon_centre ≈ −dataGroup.rotation.y × (180/π)
  //   lat_centre ≈ −dataGroup.rotation.x × (180/π)
  //
  // The visible angular cap radius = arcsin(globeRadius / cameraDist).
  // A 15% buffer pre-loads tiles just outside the viewport edge.
  // MAX_EXTENT caps the bbox to keep Open-Meteo point counts within server limits.

  function _getViewportBounds(dist, res) {
    var AG = window.ArgusGlobe;
    if (!AG || !AG.dataGroup) {
      return { latMin: -85, latMax: 85, lonMin: -180, lonMax: 180 };
    }

    // Visible half-angle of globe cap at this camera distance (degrees)
    var capAngle = Math.asin(Math.min(0.999, 100 / dist)) * 180 / Math.PI;
    var extent   = capAngle * 1.15;  // 15% buffer

    // Apply per-resolution extent cap to keep point count within server limits
    if (MAX_EXTENT[res] !== undefined && extent > MAX_EXTENT[res]) {
      extent = MAX_EXTENT[res];
    }

    var dg         = AG.dataGroup;
    var lonCenter  = -(dg.rotation.y) * 180 / Math.PI;
    var latCenter  = -(dg.rotation.x) * 180 / Math.PI;

    // Normalise longitude to [−180, 180]
    lonCenter = ((lonCenter + 180) % 360 + 360) % 360 - 180;

    // Clamp to valid geographic bounds (avoid exact poles)
    var latMin = Math.max(-85, +(latCenter - extent).toFixed(1));
    var latMax = Math.min( 85, +(latCenter + extent).toFixed(1));
    var lonMin = Math.max(-180, +(lonCenter - extent).toFixed(1));
    var lonMax = Math.min( 180, +(lonCenter + extent).toFixed(1));

    return { latMin: latMin, latMax: latMax, lonMin: lonMin, lonMax: lonMax };
  }

  // ── Tile cache key ────────────────────────────────────────────────────────────
  // Snap bounds to nearest res multiple to maximise cache hit rate when the
  // camera drifts slightly between polls.

  function _tileKey(res, bbox) {
    var snap = function(v, r) { return +(Math.round(v / r) * r).toFixed(1); };
    return res + '_' +
      snap(bbox.latMin, res) + '_' + snap(bbox.latMax, res) + '_' +
      snap(bbox.lonMin, res) + '_' + snap(bbox.lonMax, res);
  }

  // ── Request a refined tile ────────────────────────────────────────────────────
  // Skips if already in-flight or memory-cached (repaint from cache directly).

  function _requestTile(bbox, res) {
    var key = _tileKey(res, bbox);

    // Already cached in memory — repaint immediately, no network call
    if (_tileCache[key]) {
      var cached = _tileCache[key];
      var repainted = _paintSamples(cached.grid, res);
      _diag.samplesRendered += repainted;
      _diag.lastBbox   = bbox;
      _activeTileKey   = key;
      return;
    }

    if (_inflight[key]) return;  // request already in flight
    _inflight[key] = true;

    var t0     = Date.now();
    var params = '?latMin=' + bbox.latMin + '&latMax=' + bbox.latMax +
                 '&lonMin=' + bbox.lonMin + '&lonMax=' + bbox.lonMax +
                 '&res='    + res;

    fetch(TILE_URL + params)
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function(data) {
        _inflight[key] = false;
        if (!data || !Array.isArray(data.grid)) {
          console.warn('[ArgusTemperatureLayer] unexpected tile response');
          return;
        }

        // Store in memory cache
        _tileCache[key] = data;
        _activeTileKey  = key;

        // Paint fine samples over the base layer
        var painted = _paintSamples(data.grid, res);

        // Update diagnostics
        _diag.samplesLoaded   += data.grid.length;
        _diag.samplesRendered += painted;
        _diag.lastBbox         = bbox;
        _diag.lastTileMs       = Date.now() - t0;
        _diag.visibleTiles     = Object.keys(_tileCache).length + 1;
        _diag.memEstimateKB    = Math.round(
          (_diag.samplesLoaded * 12 + CANVAS_W * CANVAS_H * 4) / 1024
        );

        console.log('[ArgusTemperatureLayer] LOD' + _currentLod +
          ' (' + res + '°) ' + painted + ' samples, ' + _diag.lastTileMs + 'ms');
      })
      .catch(function(err) {
        _inflight[key] = false;
        console.warn('[ArgusTemperatureLayer] tile fetch failed:', err.message);
      });
  }

  // ── Camera poll ───────────────────────────────────────────────────────────────
  // Runs every CAMERA_POLL_MS. Updates LOD diagnostics immediately.
  // For LOD > 0, debounces DEBOUNCE_MS before requesting a refined tile so
  // fast pan/zoom gestures don't fire a tile request per-frame.

  function _onCameraPoll() {
    var AG = window.ArgusGlobe;
    if (!AG || !AG.camera || !_visible || !_baseData) return;

    var dist = AG.camera.position.length();
    var tier = _getLodTier(dist);

    _currentLod      = tier.lod;
    _diag.lod        = tier.lod;
    _diag.lodLabel   = tier.label;

    if (tier.lod === 0) {
      // Global view — base layer is sufficient; cancel any pending fine request
      if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
      return;
    }

    // Fine LOD — debounce before requesting tile
    if (_debounceTimer) clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(function() {
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
    COLOR_STOPS.forEach(function(s, idx) {
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
    ].forEach(function(txt) {
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
    if (_mesh) return; // idempotent

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

    // ── Canvas + texture ───────────────────────────────────────────────────────
    _canvas        = document.createElement('canvas');
    _canvas.width  = CANVAS_W;
    _canvas.height = CANVAS_H;
    _ctx           = _canvas.getContext('2d');
    _ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    _canvasTex           = new THREE.CanvasTexture(_canvas);
    _canvasTex.minFilter = THREE.LinearFilter;
    _canvasTex.magFilter = THREE.LinearFilter;
    _canvasTex.wrapS     = THREE.RepeatWrapping; // seamless antimeridian wrap

    var material = new THREE.MeshBasicMaterial({
      map:         _canvasTex,
      transparent: true,
      opacity:     OPACITY,
      depthWrite:  false,
      side:        THREE.FrontSide,
    });

    // ── Sphere mesh ────────────────────────────────────────────────────────────
    // r=100.5, 128×64 segments. Local rotation.y = −π/2 cancels globeGroup's
    // +π/2 correction so the equirectangular canvas aligns with geo coordinates.
    _mesh            = new THREE.Mesh(new THREE.SphereGeometry(SPHERE_R, 128, 64), material);
    _mesh.rotation.y = -Math.PI / 2;
    _mesh.visible    = false;
    AG.globeGroup.add(_mesh);

    // ── Legend ─────────────────────────────────────────────────────────────────
    _buildLegend();
    document.addEventListener('argus-settings-changed', function(e) {
      if (e && e.detail && e.detail.tempUnit) {
        _buildLegend();
        if (_visible) {
          var leg = document.getElementById('argus-temp-legend');
          if (leg) leg.style.display = 'block';
        }
      }
    });

    // ── Start timers ───────────────────────────────────────────────────────────
    refresh();
    _baseTimer = setInterval(refresh,        BASE_REFRESH_MS);
    _pollTimer = setInterval(_onCameraPoll,  CAMERA_POLL_MS);
  }

  // ── Base layer fetch ──────────────────────────────────────────────────────────
  // Fetches the global 10° grid (648 pts) and paints 10×10 px blocks covering
  // the entire canvas. After painting the base, re-paints the active fine tile
  // (if any) so its detail is not overwritten by the base repaint.

  function refresh() {
    fetch(BASE_URL)
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function(data) {
        if (!data || !Array.isArray(data.grid)) {
          console.warn('[ArgusTemperatureLayer] unexpected base response');
          return;
        }
        _baseData = data.grid;

        // Paint global base
        var painted = _paintSamples(_baseData, 10);
        _diag.samplesLoaded   += _baseData.length;
        _diag.samplesRendered += painted;
        _diag.memEstimateKB    = Math.round(CANVAS_W * CANVAS_H * 4 / 1024);

        // Re-paint active fine tile on top of the freshly painted base
        if (_activeTileKey && _tileCache[_activeTileKey]) {
          var tile = _tileCache[_activeTileKey];
          _paintSamples(tile.grid, tile.resolution);
        } else if (_visible && _currentLod > 0 && window.ArgusGlobe && window.ArgusGlobe.camera) {
          // Trigger a tile request for the current viewport
          var dist  = window.ArgusGlobe.camera.position.length();
          var tier  = _getLodTier(dist);
          var bnds  = _getViewportBounds(dist, tier.res);
          _requestTile(bnds, tier.res);
        }
      })
      .catch(function(err) {
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
      lod:              _diag.lod,
      lodLabel:         _diag.lodLabel,
      visibleTiles:     _diag.visibleTiles,
      samplesLoaded:    _diag.samplesLoaded,
      samplesRendered:  _diag.samplesRendered,
      lastBbox:         _diag.lastBbox,
      lastTileMs:       _diag.lastTileMs,
      canvasSize:       _diag.canvasSize,
      maxOpenMeteoRes:  _diag.maxOpenMeteoRes,
      memEstimateKB:    _diag.memEstimateKB,
      tilesInCache:     Object.keys(_tileCache).length,
      hasBaseData:      !!_baseData,
      basePointCount:   _baseData ? _baseData.length : 0,
      meshReady:        !!_mesh,
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
