'use strict';
// modules/argusTemperatureLayer.js
// Global temperature heatmap overlay on the Three.js globe.
//
// Renders a 36×18 canvas texture on a sphere mesh inside globeGroup, creating
// a smooth color gradient from blue (cold) to red (hot) showing current global
// temperature patterns at 10° resolution.
//
// Architecture:
//   - Data source: Netlify function /.netlify/functions/fetch-temperature
//     (Open-Meteo 10° grid, cached server-side at 2h TTL)
//   - Canvas: 36 cols × 18 rows (one pixel per 10° cell). THREE.LinearFilter
//     on the GPU handles smooth interpolation between pixels.
//   - Sphere: r=100.2, inside globeGroup with rotation.y = -π/2.
//     The -π/2 local rotation cancels globeGroup's +π/2 initial correction,
//     giving zero net world rotation at rest. As the globe rotates, the heatmap
//     stays in sync because dataGroup.rotation.y = globeGroup.rotation.y − π/2,
//     which equals the heatmap sphere's effective world rotation.
//   - The heatmap is positioned at r=100.2, above the globe surface (r=100) but
//     below the coordinate grid (r=100.39) and all other marker layers.
//
// Temperature-to-color mapping (Celsius):
//   ≤ −50°C  →  deep blue-purple
//     −20°C  →  bright blue
//       0°C  →  cyan
//      15°C  →  green
//      25°C  →  yellow
//      35°C  →  orange-red
//   ≥  50°C  →  deep red
//
// Unit display: internally stored in °C; legend labels convert to °F when
//   ArgusSettings tempUnit = 'F'. No re-fetch needed — pure display conversion.
//
// Legend: DOM overlay positioned bottom-left of the globe canvas.
//   Shows a color gradient strip and temperature labels in current unit.
//
// Globals: window.ArgusTemperatureLayer
//   { init, toggle, setVisible, refresh, status }
//
// Init: call ArgusTemperatureLayer.init() AFTER window.ArgusGlobe is set.
//   index.html calls this right after window.ArgusGlobe = {...}.
//
// Data attribution: Open-Meteo (https://open-meteo.com) — CC BY 4.0.
//   Non-commercial use only on the free tier. See fetch-temperature.js for details.

window.ArgusTemperatureLayer = (function () {
  'use strict';

  // ── Config ───────────────────────────────────────────────────────────────────

  var GRID_ROWS   = 18;   // latitudes: 85, 75, ..., −85
  var GRID_COLS   = 36;   // longitudes: −175, −165, ..., 175
  var SPHERE_R    = 100.2; // just above globe (100), below coord grid (100.39)
  var OPACITY     = 0.70;
  var FETCH_URL   = '/.netlify/functions/fetch-temperature';
  var REFRESH_MS  = 2 * 60 * 60 * 1000; // auto-refresh every 2h

  // Temperature-to-color stops (°C). Covers −50 to +50°C range.
  var COLOR_STOPS = [
    { t: -50, r: 30,  g: 30,  b: 150 },  // deep blue-purple (polar deep winter)
    { t: -20, r: 0,   g: 80,  b: 255 },  // bright blue (sub-zero)
    { t:   0, r: 0,   g: 200, b: 255 },  // cyan (freezing point)
    { t:  15, r: 0,   g: 210, b: 80  },  // green (mild/temperate)
    { t:  25, r: 255, g: 215, b: 0   },  // yellow (warm)
    { t:  35, r: 255, g: 75,  b: 0   },  // orange-red (hot)
    { t:  50, r: 180, g: 0,   b: 50  },  // deep red (extreme heat)
  ];

  // ── Module state ──────────────────────────────────────────────────────────────

  var _mesh        = null;
  var _canvasTex   = null;
  var _canvas      = null;
  var _ctx         = null;
  var _visible     = false;
  var _data        = null;  // cached grid array from last successful fetch
  var _refreshTimer = null;

  // ── Temperature → color ───────────────────────────────────────────────────────

  function _tempToColorStr(t) {
    if (t === null || t === undefined || !isFinite(t)) {
      return 'rgba(80,80,80,0.2)'; // transparent gray for missing data
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
        var r = Math.round(stops[i].r + frac * (stops[i + 1].r - stops[i].r));
        var g = Math.round(stops[i].g + frac * (stops[i + 1].g - stops[i].g));
        var b = Math.round(stops[i].b + frac * (stops[i + 1].b - stops[i].b));
        return 'rgb(' + r + ',' + g + ',' + b + ')';
      }
    }
    return 'rgb(' + last.r + ',' + last.g + ',' + last.b + ')';
  }

  // ── Canvas drawing ────────────────────────────────────────────────────────────
  // One canvas pixel per 10° grid cell. THREE.LinearFilter handles GPU interpolation.
  //
  // Canvas coordinate convention (with THREE.js flipY=true default):
  //   Col 0  ← lon=−175 (near −180° west edge)
  //   Col 35 ← lon=+175 (near +180° east edge)
  //   Row 0  ← lat=+85 (near North Pole)   [flipY maps canvas y=0 → UV v=1 → North]
  //   Row 17 ← lat=−85 (near South Pole)   [flipY maps canvas y=17 → UV v=0 → South]

  function _drawCanvas(grid) {
    if (!_ctx) return;

    // Build lookup map for O(1) access
    var map = {};
    for (var i = 0; i < grid.length; i++) {
      map[grid[i].lat + '_' + grid[i].lon] = grid[i].t;
    }

    for (var row = 0; row < GRID_ROWS; row++) {
      var lat = 85 - row * 10;            // row 0 → lat 85, row 17 → lat −85
      for (var col = 0; col < GRID_COLS; col++) {
        var lon = -175 + col * 10;        // col 0 → lon −175, col 35 → lon 175
        var t = map[lat + '_' + lon];
        _ctx.fillStyle = _tempToColorStr(t !== undefined ? t : null);
        _ctx.fillRect(col, row, 1, 1);
      }
    }

    if (_canvasTex) _canvasTex.needsUpdate = true;
  }

  // ── Legend ────────────────────────────────────────────────────────────────────
  // A compact color-gradient bar with temperature labels. Positioned
  // bottom-left over the globe canvas, hidden when the layer is off.

  function _cToF(c) { return Math.round(c * 9 / 5 + 32); }

  function _buildLegend() {
    var existing = document.getElementById('argus-temp-legend');
    if (existing) existing.remove();

    var unit = (window.ArgusSettings
      ? (localStorage.getItem('argus-temp-unit') || 'C')
      : 'C');

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

    // Header
    var hdr = document.createElement('div');
    hdr.style.cssText = 'color:#2a6a8a;margin-bottom:4px;letter-spacing:2px';
    hdr.textContent = 'TEMP (2m °' + unit + ')';
    el.appendChild(hdr);

    // Gradient bar canvas (gradient drawn in JS)
    var bar = document.createElement('canvas');
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

    // Labels row
    var labels = document.createElement('div');
    labels.style.cssText = 'display:flex;justify-content:space-between;width:90px;color:#5a8aa8';

    var lo = unit === 'F' ? _cToF(-50) + '°F' : '−50°C';
    var mi = unit === 'F' ? _cToF(0)   + '°F' : '0°C';
    var hi = unit === 'F' ? _cToF(50)  + '°F' : '50°C';

    [lo, mi, hi].forEach(function(txt) {
      var span = document.createElement('span');
      span.textContent = txt;
      labels.appendChild(span);
    });
    el.appendChild(labels);

    // Attribution (Open-Meteo CC BY 4.0)
    var attr = document.createElement('div');
    attr.style.cssText = 'color:#2a4a5a;margin-top:3px;font-size:6.5px;letter-spacing:0.8px';
    attr.textContent = 'Open-Meteo CC BY 4.0';
    el.appendChild(attr);

    document.body.appendChild(el);
    return el;
  }

  // ── Init ──────────────────────────────────────────────────────────────────────
  // Called from index.html after window.ArgusGlobe is set.

  function init() {
    if (_mesh) return; // idempotent

    var AG = window.ArgusGlobe;
    if (!AG || !AG.globeGroup) {
      console.warn('[ArgusTemperatureLayer] window.ArgusGlobe not ready; deferred');
      return;
    }

    var THREE = window.THREE;
    if (!THREE) {
      console.warn('[ArgusTemperatureLayer] THREE not available');
      return;
    }

    // ── Canvas + texture ───────────────────────────────────────────────────────
    _canvas = document.createElement('canvas');
    _canvas.width  = GRID_COLS;  // 36
    _canvas.height = GRID_ROWS;  // 18
    _ctx = _canvas.getContext('2d');

    // Fill with transparent until data arrives
    _ctx.clearRect(0, 0, GRID_COLS, GRID_ROWS);

    _canvasTex = new THREE.CanvasTexture(_canvas);
    _canvasTex.minFilter  = THREE.LinearFilter;
    _canvasTex.magFilter  = THREE.LinearFilter;
    _canvasTex.wrapS      = THREE.RepeatWrapping; // seamless antimeridian wrap
    // flipY = true (default) — canvas y=0 → UV v=1 → North Pole ✓

    var material = new THREE.MeshBasicMaterial({
      map:         _canvasTex,
      transparent: true,
      opacity:     OPACITY,
      depthWrite:  false,
      side:        THREE.FrontSide,
    });

    // ── Sphere mesh ────────────────────────────────────────────────────────────
    // Sits at r=100.2, above globe surface (r=100) and below coord grid (r=100.39).
    // Added to globeGroup so it rotates with the globe as the user drags.
    //
    // Local rotation.y = −π/2 cancels globeGroup's initial +π/2 correction so the
    // equirectangular canvas aligns with the data coordinate system at rest.
    // As the globe rotates (globeGroup.rotation.y += drag):
    //   sphere world rotation Y = globeGroup.rotation.y + (−π/2)
    //                           = dataGroup.rotation.y              ✓ stays in sync
    _mesh = new THREE.Mesh(new THREE.SphereGeometry(SPHERE_R, 64, 32), material);
    _mesh.rotation.y = -Math.PI / 2;
    _mesh.visible    = false;
    AG.globeGroup.add(_mesh);

    // ── Legend ─────────────────────────────────────────────────────────────────
    _buildLegend();

    // ── Event listeners ────────────────────────────────────────────────────────
    // Rebuild legend when the user switches °C/°F in Settings
    document.addEventListener('argus-settings-changed', function(e) {
      var unit = e && e.detail && e.detail.tempUnit;
      if (unit) {
        _buildLegend();
        if (_visible) {
          var leg = document.getElementById('argus-temp-legend');
          if (leg) leg.style.display = 'block';
        }
      }
    });

    // ── First fetch + auto-refresh ─────────────────────────────────────────────
    refresh();
    _refreshTimer = setInterval(refresh, REFRESH_MS);
  }

  // ── Fetch ─────────────────────────────────────────────────────────────────────

  function refresh() {
    fetch(FETCH_URL)
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function(data) {
        if (!data || !Array.isArray(data.grid)) {
          console.warn('[ArgusTemperatureLayer] unexpected response shape');
          return;
        }
        _data = data.grid;
        _drawCanvas(_data);
      })
      .catch(function(err) {
        console.warn('[ArgusTemperatureLayer] fetch failed:', err.message);
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
    // If turning on for the first time with no data, trigger a fetch
    if (on && !_data) refresh();
  }

  function toggle() {
    setVisible(!_visible);
  }

  function status() {
    return {
      visible:    _visible,
      hasData:    !!_data,
      pointCount: _data ? _data.length : 0,
      meshReady:  !!_mesh,
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
