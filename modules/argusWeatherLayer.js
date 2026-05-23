'use strict';
// modules/argusWeatherLayer.js
// Animated NOAA weather intelligence overlay — pulse + cyclone sprite markers.
//
// Architecture:
//   Animated canvas-texture sprites layered on top of argusNoaa.js static markers.
//   WeatherPulseTexture: concentric ring pulse for flood/severe weather alerts.
//   CycloneMarker: rotating arm + counter-rotating eye group for tropical cyclones.
//   Polls /.netlify/functions/fetch-noaa every 60s (parallel to argusNoaa.js 15m poll).
//
// Marker types:
//   pulse   — flood, tornado, thunderstorm, winter storm, wind alerts
//   cyclone — hurricane, typhoon, tropical storm, tropical depression
//
// Layer:   ArgusLayerState.weather (separate toggle from .events)
// Altitude: R.DISASTER + 0.5 = ~104.0 (above all other markers)
//
// Globals:
//   window.ArgusWeatherLayer — { tick, start, stop, toggle, setVisible, refresh, status }
//
// Load order: after argusNoaa.js, before argusDiagnostics.js

window.ArgusWeatherLayer = (function () {
  'use strict';

  // ── Config ───────────────────────────────────────────────────────────────────

  var POLL_MS    = 60 * 1000;
  var PULSE_SIZE = 72;
  var CYCO_SIZE  = 88;

  var SCALE_PULSE   = 3.0;
  var SCALE_CYCLONE = 3.6;

  // LOD: skip canvas redraws for markers this far from camera
  var LOD_SKIP_DIST = 350;

  // ── Severity animation params ─────────────────────────────────────────────────

  var SEV_PARAMS = {
    minor:    { pulseSpeed: 0.018, ringThick: 0.9,  glowAlpha: 0.55, ringCount: 2 },
    moderate: { pulseSpeed: 0.025, ringThick: 1.1,  glowAlpha: 0.65, ringCount: 2 },
    severe:   { pulseSpeed: 0.035, ringThick: 1.4,  glowAlpha: 0.78, ringCount: 3 },
    extreme:  { pulseSpeed: 0.045, ringThick: 1.7,  glowAlpha: 0.90, ringCount: 3 },
  };

  // ── Colors ───────────────────────────────────────────────────────────────────

  var C_NUCLEUS = '#72eeff';
  var C_INNER   = '#4fc3ff';
  var C_OUTER   = '#0ea5e9';

  var TOOLTIP_SEV_COLORS = {
    minor:    '#0ea5e9',
    moderate: '#4fc3ff',
    severe:   '#72eeff',
    extreme:  '#ffffff',
  };

  // ── Classification sets ───────────────────────────────────────────────────────

  var CYCLONE_TYPES = {
    'Hurricane Warning': 1, 'Hurricane Watch': 1, 'Hurricane Local Statement': 1,
    'Hurricane Force Wind Warning': 1, 'Tropical Storm Warning': 1,
    'Tropical Storm Watch': 1, 'Tropical Storm Local Statement': 1,
    'Typhoon Warning': 1, 'Typhoon Watch': 1, 'Typhoon Local Statement': 1,
    'Extreme Wind Warning': 1, 'Hurricane': 1, 'Major Hurricane': 1,
    'Tropical Storm': 1, 'Typhoon': 1, 'Super Typhoon': 1,
    'Tropical Depression': 1, 'Subtropical Storm': 1, 'Post-Tropical Cyclone': 1,
    'Tropical Cyclone': 1, 'Extratropical Cyclone': 1,
  };

  var PULSE_TYPES = {
    'Flood Warning': 1, 'Flood Watch': 1, 'Flood Advisory': 1,
    'Flash Flood Warning': 1, 'Flash Flood Watch': 1, 'Flash Flood Statement': 1,
    'Coastal Flood Warning': 1, 'Coastal Flood Watch': 1, 'Coastal Flood Advisory': 1,
    'Lakeshore Flood Warning': 1, 'River Flood Warning': 1, 'Areal Flood Warning': 1,
    'Special Weather Statement': 1, 'Severe Thunderstorm Warning': 1,
    'Severe Thunderstorm Watch': 1, 'Tornado Warning': 1, 'Tornado Watch': 1,
    'Dense Fog Advisory': 1, 'High Wind Warning': 1, 'High Wind Watch': 1,
    'Winter Storm Warning': 1, 'Winter Storm Watch': 1, 'Blizzard Warning': 1,
    'Ice Storm Warning': 1, 'Winter Weather Advisory': 1, 'Freezing Rain Advisory': 1,
  };

  function classify(eventType) {
    if (!eventType) return 'pulse';
    if (CYCLONE_TYPES[eventType]) return 'cyclone';
    if (PULSE_TYPES[eventType])   return 'pulse';
    var low = eventType.toLowerCase();
    if (low.indexOf('hurricane') >= 0 || low.indexOf('typhoon') >= 0 ||
        low.indexOf('cyclone') >= 0   || low.indexOf('tropical') >= 0) return 'cyclone';
    return 'pulse';
  }

  function mapSeverity(severity) {
    if (!severity) return 'minor';
    var s = severity.toLowerCase();
    if (s === 'extreme')  return 'extreme';
    if (s === 'severe')   return 'severe';
    if (s === 'moderate') return 'moderate';
    return 'minor';
  }

  // ── Keyword link extraction ───────────────────────────────────────────────────

  var KEYWORD_LINKS = [
    ['hurricane',           'https://www.nhc.noaa.gov/aboutgloss.shtml#H'],
    ['tropical storm',      'https://www.nhc.noaa.gov/aboutgloss.shtml#T'],
    ['typhoon',             'https://www.nhc.noaa.gov/aboutgloss.shtml#TY'],
    ['tropical depression', 'https://www.nhc.noaa.gov/aboutgloss.shtml#TD'],
    ['storm surge',         'https://www.nhc.noaa.gov/surge/'],
    ['cyclone',             'https://www.nhc.noaa.gov/aboutgloss.shtml#C'],
    ['saffir-simpson',      'https://www.nhc.noaa.gov/aboutsshws.php'],
    ['rapid intensification','https://www.nhc.noaa.gov/aboutgloss.shtml#RI'],
    ['flash flood',         'https://www.weather.gov/safety/flood-flash'],
    ['flood warning',       'https://www.weather.gov/safety/flood'],
    ['flood watch',         'https://www.weather.gov/safety/flood-watch-warning'],
    ['coastal flood',       'https://www.weather.gov/safety/flood-coastal'],
    ['river flood',         'https://water.weather.gov/ahps/'],
    ['flood stage',         'https://water.weather.gov/ahps/about/about.php'],
    ['stream gauge',        'https://waterdata.usgs.gov/nwis/'],
    ['inundation',          'https://www.weather.gov/safety/flood'],
    ['nhc',                 'https://www.nhc.noaa.gov/'],
    ['nws',                 'https://www.weather.gov/'],
    ['noaa',                'https://www.noaa.gov/'],
  ];

  function extractKeywords(text) {
    var found = [];
    var lower = (text || '').toLowerCase();
    for (var i = 0; i < KEYWORD_LINKS.length; i++) {
      if (lower.indexOf(KEYWORD_LINKS[i][0]) >= 0) {
        found.push({ word: KEYWORD_LINKS[i][0], url: KEYWORD_LINKS[i][1] });
      }
    }
    return found;
  }

  // ── Canvas helpers ────────────────────────────────────────────────────────────

  function hexAlpha(hex, a) {
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + Math.max(0, Math.min(1, a)).toFixed(3) + ')';
  }

  function makeCanvas(size) {
    var cv = document.createElement('canvas');
    cv.width = cv.height = size;
    return { canvas: cv, ctx: cv.getContext('2d') };
  }

  // ── WeatherPulseTexture ────────────────────────────────────────────────────────
  //
  // Animated canvas texture for non-cyclone weather alerts.
  // Three staggered concentric rings expand and fade, plus angular turbulence
  // streaks and a breathing nucleus point.

  function WeatherPulseTexture(severity) {
    var c = makeCanvas(PULSE_SIZE);
    this.canvas   = c.canvas;
    this.ctx      = c.ctx;
    this.severity = severity || 'minor';
    this.params   = SEV_PARAMS[this.severity] || SEV_PARAMS.minor;
    this.t        = 0;
    this.texture  = new THREE.CanvasTexture(this.canvas);
    this._draw();
    this.texture.needsUpdate = true;
  }

  WeatherPulseTexture.prototype.tick = function (dt) {
    this.t += dt * 60;
    this._draw();
    this.texture.needsUpdate = true;
  };

  WeatherPulseTexture.prototype._draw = function () {
    var ctx      = this.ctx;
    var size     = PULSE_SIZE;
    var cx       = size / 2;
    var cy       = size / 2;
    var p        = this.params;
    var t        = this.t;
    var critical = this.severity === 'severe' || this.severity === 'extreme';

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';

    // Staggered pulse rings
    var phase = (t * p.pulseSpeed) % 1;
    var maxR  = critical ? 26 : 22;
    var ringCs = [C_NUCLEUS, C_INNER, C_OUTER];
    var ringAs = [1.0, 0.7, 0.45];

    for (var i = 0; i < p.ringCount; i++) {
      var rp    = (phase + i * (1 / p.ringCount)) % 1;
      var r     = 6 + rp * maxR;
      var alpha = p.glowAlpha * Math.pow(1 - rp, 2);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = hexAlpha(ringCs[i % 3], alpha * ringAs[i % 3]);
      ctx.lineWidth   = p.ringThick;
      ctx.stroke();
    }

    // Angular turbulence streaks — tactical, not smooth
    var nStreaks    = critical ? 6 : 4;
    var streakSpeed = critical ? 0.008 : 0.004;
    for (var s = 0; s < nStreaks; s++) {
      var ang = (s / nStreaks) * Math.PI * 2 + t * streakSpeed;
      var len = 7 + Math.sin(t * 0.03 + s) * 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * 3,       cy + Math.sin(ang) * 3);
      ctx.lineTo(cx + Math.cos(ang) * (3+len), cy + Math.sin(ang) * (3+len));
      ctx.strokeStyle = hexAlpha(C_INNER, critical ? 0.35 : 0.20);
      ctx.lineWidth   = 0.6;
      ctx.stroke();
    }

    // Nucleus — breathing scale
    var breathe = 1 + Math.sin(t * 0.025) * 0.12;
    ctx.beginPath();
    ctx.arc(cx, cy, 3.5 * breathe, 0, Math.PI * 2);
    ctx.fillStyle = hexAlpha(C_NUCLEUS, critical ? 0.95 : 0.70);
    ctx.fill();

    // Core point — always full opacity
    ctx.beginPath();
    ctx.arc(cx, cy, 1.2, 0, Math.PI * 2);
    ctx.fillStyle = C_NUCLEUS;
    ctx.fill();

    ctx.restore();
  };

  WeatherPulseTexture.prototype.dispose = function () {
    this.texture.dispose();
  };

  // ── CycloneMarker ──────────────────────────────────────────────────────────────
  //
  // THREE.Group with 3 independently animated sprite layers:
  //   armSprite   — 3 segmented rotational arms, rotates clockwise
  //   eyeSprite   — 4 counter-rotating inner shards + dark core, rotates CCW
  //   pulseSprite — eye pulse ring, opacity oscillation only

  function CycloneMarker(scene, position, severity) {
    this.severity    = severity || 'minor';
    this.t           = 0;
    this._outerAngle = 0;
    this._innerAngle = 0;
    this.group       = new THREE.Group();

    var armC   = makeCanvas(CYCO_SIZE);
    var eyeC   = makeCanvas(CYCO_SIZE);
    var pulseC = makeCanvas(CYCO_SIZE);

    this._armCtx   = armC.ctx;
    this._eyeCtx   = eyeC.ctx;
    this._pulseCtx = pulseC.ctx;

    this.armTex   = new THREE.CanvasTexture(armC.canvas);
    this.eyeTex   = new THREE.CanvasTexture(eyeC.canvas);
    this.pulseTex = new THREE.CanvasTexture(pulseC.canvas);

    this.armSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.armTex, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.armSprite.scale.set(SCALE_CYCLONE, SCALE_CYCLONE, 1);

    this.eyeSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.eyeTex, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.eyeSprite.scale.set(SCALE_CYCLONE * 0.4, SCALE_CYCLONE * 0.4, 1);

    this.pulseSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.pulseTex, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.pulseSprite.scale.set(SCALE_CYCLONE * 0.6, SCALE_CYCLONE * 0.6, 1);

    this.group.add(this.armSprite);
    this.group.add(this.eyeSprite);
    this.group.add(this.pulseSprite);
    this.group.position.copy(position);
    scene.add(this.group);

    // Draw initial frame
    var severe = this.severity === 'severe' || this.severity === 'extreme';
    this._drawArms(0, severe);
    this._drawEye(0, severe);
    this._drawPulseRing(severe);
    this.armTex.needsUpdate = this.eyeTex.needsUpdate = this.pulseTex.needsUpdate = true;
  }

  CycloneMarker.prototype.tick = function (dt) {
    this.t += dt * 60;
    var severe = this.severity === 'severe' || this.severity === 'extreme';
    this._outerAngle += severe ? 0.022 : 0.014;
    this._innerAngle -= severe ? 0.016 : 0.010;

    this._drawArms(this._outerAngle, severe);
    this._drawEye(this._innerAngle, severe);
    this._drawPulseRing(severe);

    this.armTex.needsUpdate = this.eyeTex.needsUpdate = this.pulseTex.needsUpdate = true;
  };

  CycloneMarker.prototype._drawArms = function (outerAngle, severe) {
    var ctx    = this._armCtx;
    var size   = CYCO_SIZE;
    var cx     = size / 2;
    var cy     = size / 2;
    var outerR = severe ? 30 : 26;
    var armW   = severe ? 1.4 : 1.0;

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';

    for (var a = 0; a < 3; a++) {
      var baseAngle = outerAngle + (a / 3) * Math.PI * 2;
      ctx.beginPath();
      for (var seg = 0; seg <= 20; seg++) {
        var frac  = seg / 20;
        var r     = 8 + frac * outerR;
        var sweep = frac * Math.PI * 0.85;
        var ang   = baseAngle + sweep;
        var x = cx + Math.cos(ang) * r;
        var y = cy + Math.sin(ang) * r;
        if (seg === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      // Gradient from nucleus color → transparent at tip
      var bx0 = cx + Math.cos(baseAngle) * 8;
      var by0 = cy + Math.sin(baseAngle) * 8;
      var tipAng = baseAngle + Math.PI * 0.85;
      var bx1 = cx + Math.cos(tipAng) * (8 + outerR);
      var by1 = cy + Math.sin(tipAng) * (8 + outerR);
      var grad = ctx.createLinearGradient(bx0, by0, bx1, by1);
      grad.addColorStop(0,   'rgba(114,238,255,' + (severe ? 0.80 : 0.55) + ')');
      grad.addColorStop(0.5, 'rgba(79,195,255,'  + (severe ? 0.56 : 0.38) + ')');
      grad.addColorStop(1,   'rgba(14,165,233,0.04)');
      ctx.strokeStyle = grad;
      ctx.lineWidth   = armW;
      ctx.stroke();

      // Tapered tip chevron indicator
      ctx.beginPath();
      ctx.moveTo(bx1, by1);
      ctx.lineTo(
        cx + Math.cos(tipAng + 0.35) * (8 + outerR - 4),
        cy + Math.sin(tipAng + 0.35) * (8 + outerR - 4)
      );
      ctx.strokeStyle = 'rgba(14,165,233,0.18)';
      ctx.lineWidth   = 0.6;
      ctx.stroke();
    }
    ctx.restore();
  };

  CycloneMarker.prototype._drawEye = function (innerAngle, severe) {
    var ctx  = this._eyeCtx;
    var size = CYCO_SIZE;
    var cx   = size / 2;
    var cy   = size / 2;
    var eyeR = severe ? 5 : 4;

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';

    // 4 counter-rotating inner shards
    for (var a = 0; a < 4; a++) {
      var ang = innerAngle + (a / 4) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * (eyeR - 1),         cy + Math.sin(ang) * (eyeR - 1));
      ctx.lineTo(cx + Math.cos(ang + 0.4) * (eyeR + 1.5), cy + Math.sin(ang + 0.4) * (eyeR + 1.5));
      ctx.strokeStyle = 'rgba(114,238,255,' + (severe ? 0.75 : 0.50) + ')';
      ctx.lineWidth   = 0.7;
      ctx.stroke();
    }

    // Dark core — occludes globe surface beneath eye
    ctx.globalCompositeOperation = 'source-over';
    ctx.beginPath();
    ctx.arc(cx, cy, eyeR * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = '#060e18';
    ctx.fill();

    // Core glow point
    ctx.globalCompositeOperation = 'screen';
    ctx.beginPath();
    ctx.arc(cx, cy, 1.4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(114,238,255,' + (severe ? 0.90 : 0.60) + ')';
    ctx.fill();

    ctx.restore();
  };

  CycloneMarker.prototype._drawPulseRing = function (severe) {
    var ctx   = this._pulseCtx;
    var size  = CYCO_SIZE;
    var cx    = size / 2;
    var cy    = size / 2;
    var eyeR  = severe ? 5 : 4;
    var pulse = 0.5 + Math.sin(this.t * 0.03) * 0.5;

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.beginPath();
    ctx.arc(cx, cy, eyeR + 2, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(79,195,255,' + (0.15 + pulse * 0.20).toFixed(3) + ')';
    ctx.lineWidth   = 1.5;
    ctx.stroke();
    ctx.restore();
  };

  CycloneMarker.prototype.setVisible = function (v) {
    this.group.visible = v;
  };

  CycloneMarker.prototype.dispose = function () {
    this.armTex.dispose();
    this.eyeTex.dispose();
    this.pulseTex.dispose();
    this.armSprite.material.dispose();
    this.eyeSprite.material.dispose();
    this.pulseSprite.material.dispose();
    if (this.group.parent) this.group.parent.remove(this.group);
  };

  // ── PulseMarker (sprite wrapper) ─────────────────────────────────────────────

  function PulseMarker(scene, position, severity) {
    this.severity = severity || 'minor';
    this.texture  = new WeatherPulseTexture(this.severity);
    this.material = new THREE.SpriteMaterial({
      map: this.texture.texture, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
      color: 0x72eeff,
    });
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.scale.setScalar(SCALE_PULSE);
    this.sprite.position.copy(position);
    scene.add(this.sprite);
  }

  PulseMarker.prototype.tick = function (dt) {
    this.texture.tick(dt);
  };

  PulseMarker.prototype.setVisible = function (v) {
    this.sprite.visible = v;
  };

  PulseMarker.prototype.dispose = function () {
    this.texture.dispose();
    this.material.dispose();
    if (this.sprite.parent) this.sprite.parent.remove(this.sprite);
  };

  // ── Geo conversion ────────────────────────────────────────────────────────────

  function latLonToVec3(lat, lon, r) {
    var phi   = (90 - lat) * Math.PI / 180;
    var theta = (lon + 180) * Math.PI / 180;
    return new THREE.Vector3(
      -(r * Math.sin(phi) * Math.cos(theta)),
        r * Math.cos(phi),
        r * Math.sin(phi) * Math.sin(theta)
    );
  }

  // ── Tooltip ───────────────────────────────────────────────────────────────────

  var _tooltipEl = null;

  function _ensureTooltip() {
    if (_tooltipEl) return _tooltipEl;
    _tooltipEl = document.createElement('div');
    _tooltipEl.id = 'argus-weather-tooltip';
    _tooltipEl.style.cssText =
      'position:fixed;z-index:9999;pointer-events:none;display:none;' +
      'max-width:340px;min-width:220px;';
    document.body.appendChild(_tooltipEl);
    return _tooltipEl;
  }

  function _escHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function _linkKeywords(text, keywords) {
    var result = _escHtml(text);
    for (var k = 0; k < keywords.length; k++) {
      var kw  = keywords[k];
      // Simple substring replacement — first occurrence, case-insensitive
      var lo  = result.toLowerCase();
      var idx = lo.indexOf(kw.word);
      if (idx < 0) continue;
      var orig = result.slice(idx, idx + kw.word.length);
      result   = result.slice(0, idx) +
        '<a href="' + kw.url + '" target="_blank" rel="noopener noreferrer" ' +
        'style="color:#4fc3ff;text-decoration:none;border-bottom:0.5px solid #10324a;">' +
        orig + '</a>' +
        result.slice(idx + kw.word.length);
    }
    return result;
  }

  function _buildTooltipHTML(alert) {
    var sev   = alert._wSeverity || 'minor';
    var color = TOOLTIP_SEV_COLORS[sev] || TOOLTIP_SEV_COLORS.minor;
    var mType = alert._wMarkerType || 'pulse';
    var kws   = alert._wKeywords  || [];
    var headline = _linkKeywords(alert.headline || alert.eventType || '', kws);

    var windsHtml = '';
    if (alert._wWindKt) {
      windsHtml = '<div style="font-size:10px;color:#2a6a7a;margin-bottom:4px;">' +
        'WIND: <span style="color:#4fc3ff;">' + Math.round(alert._wWindKt) + ' kt</span>' +
        (alert._wPressHPa
          ? '&nbsp;|&nbsp;PRESSURE: <span style="color:#4fc3ff;">' + Math.round(alert._wPressHPa) + ' hPa</span>'
          : '') +
        '</div>';
    }

    var expires = alert.expires
      ? new Date(alert.expires).toUTCString() + ' (UTC)'
      : 'N/A';

    var noaaUrl = mType === 'cyclone'
      ? 'https://www.nhc.noaa.gov/'
      : 'https://www.weather.gov/';

    return '<div style="' +
      'background:rgba(4,16,28,0.96);' +
      'border:0.5px solid #10324a;' +
      'border-left:2px solid ' + color + ';' +
      'border-radius:4px;padding:10px 14px;' +
      'font-family:\'Courier New\',monospace;pointer-events:auto;">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
        '<span style="font-size:9px;letter-spacing:.1em;color:#2a6a7a;text-transform:uppercase;">' +
          _escHtml(alert.source || 'NOAA') + ' // ' + mType +
        '</span>' +
        '<span style="font-size:9px;letter-spacing:.06em;color:' + color + ';text-transform:uppercase;">' +
          sev +
        '</span>' +
      '</div>' +
      '<div style="font-size:12px;color:#72eeff;margin-bottom:8px;line-height:1.5;">' +
        headline +
      '</div>' +
      windsHtml +
      '<div style="font-size:9px;color:#1a4a5a;margin-top:8px;border-top:0.5px solid #0d2535;padding-top:6px;">' +
        'EXPIRES: ' + _escHtml(expires) + '&nbsp;&nbsp;' +
        '<a href="' + noaaUrl + '" target="_blank" rel="noopener noreferrer" ' +
        'style="color:#0ea5e9;text-decoration:none;">' +
        'NOAA DETAIL &#x2197;</a>' +
      '</div>' +
    '</div>';
  }

  function _showTooltip(alert, screenX, screenY) {
    var el = _ensureTooltip();
    el.innerHTML = _buildTooltipHTML(alert);
    el.style.display = 'block';
    el.style.pointerEvents = 'auto';
    var vw   = window.innerWidth;
    var vh   = window.innerHeight;
    var left = screenX + 16;
    var top  = screenY - 10;
    if (left + 350 > vw) left = screenX - 350;
    if (top  + 220 > vh) top  = vh - 230;
    el.style.left = Math.max(0, left) + 'px';
    el.style.top  = Math.max(0, top)  + 'px';
  }

  function _hideTooltip() {
    if (_tooltipEl) {
      _tooltipEl.style.display = 'none';
      _tooltipEl.style.pointerEvents = 'none';
    }
  }

  // ── Marker state ──────────────────────────────────────────────────────────────

  var _markers      = {};    // id → { marker, mType, alert }
  var _alertCache   = {};    // id → enriched alert
  var _spriteIndex  = [];    // [{ obj: THREE.Sprite, id: String }]
  var _enabled      = false;
  var _altR         = 104.0;
  var _hoveredId    = null;

  function _getAlt() {
    var AG = window.ArgusGlobe;
    if (AG && AG.R && AG.R.DISASTER) return AG.R.DISASTER + 0.5;
    return 104.0;
  }

  function _getScene() {
    var AG = window.ArgusGlobe;
    return AG ? AG.scene : null;
  }

  function _buildUserData(alert) {
    return {
      _weatherLayer: true,
      _weatherId:    alert.id,
      type:          alert.eventType,
      isNOAA:        true,
      isWeather:     true,
      isCountry:     false,
      title:         alert.eventType + (alert.areaDesc ? ' — ' + alert.areaDesc.slice(0, 60) : ''),
      impact:        (alert.headline || alert.eventType || '') +
                     (alert.severity ? '. Severity: ' + alert.severity : '') +
                     (alert.expires  ? '. Expires: ' + new Date(alert.expires).toUTCString() + ' (UTC)' : ''),
      source:        alert.source || 'NOAA',
      countryCode:   null,
    };
  }

  function _addMarker(alert) {
    var scene = _getScene();
    if (!scene) return;

    var mType  = alert._wMarkerType;
    var sev    = alert._wSeverity;
    var pos    = latLonToVec3(alert.lat, alert.lon, _altR);
    var marker;
    var ud     = _buildUserData(alert);

    if (mType === 'cyclone') {
      marker = new CycloneMarker(scene, pos, sev);
      marker.group.userData = ud;
      marker.armSprite.userData   = ud;
      marker.eyeSprite.userData   = ud;
      marker.pulseSprite.userData = ud;
      _spriteIndex.push({ obj: marker.armSprite,   id: alert.id });
      _spriteIndex.push({ obj: marker.eyeSprite,   id: alert.id });
      _spriteIndex.push({ obj: marker.pulseSprite, id: alert.id });
    } else {
      marker = new PulseMarker(scene, pos, sev);
      marker.sprite.userData = ud;
      _spriteIndex.push({ obj: marker.sprite, id: alert.id });
    }

    marker.setVisible(_enabled);
    _markers[alert.id] = { marker: marker, mType: mType, alert: alert };
  }

  function _removeMarker(id) {
    var entry = _markers[id];
    if (!entry) return;
    entry.marker.dispose();
    // Rebuild sprite index without this id
    var next = [];
    for (var i = 0; i < _spriteIndex.length; i++) {
      if (_spriteIndex[i].id !== id) next.push(_spriteIndex[i]);
    }
    _spriteIndex = next;
    delete _markers[id];
    delete _alertCache[id];
    if (_hoveredId === id) { _hoveredId = null; _hideTooltip(); }
  }

  function _updateAllVisibility() {
    for (var id in _markers) {
      _markers[id].marker.setVisible(_enabled);
    }
    if (!_enabled) _hideTooltip();
  }

  // ── Poll & diff render ────────────────────────────────────────────────────────

  var NOAA_FN    = '/.netlify/functions/fetch-noaa';
  var _pollTimer = null;
  var _audit     = { polls: 0, errors: 0 };
  var _ctrl      = null;

  function _enrich(al) {
    var mType = classify(al.eventType);
    var sev   = mapSeverity(al.severity);
    var kws   = extractKeywords((al.headline || '') + ' ' + (al.eventType || ''));

    // Parse wind speed from NHC headline e.g. "Storm Alpha — Tropical Storm, 65 kt winds"
    var wKt = null;
    if (al.headline) {
      var wm = al.headline.match(/(\d+)\s*kt/i);
      if (wm) wKt = parseFloat(wm[1]);
    }

    al._wMarkerType = mType;
    al._wSeverity   = sev;
    al._wKeywords   = kws;
    al._wWindKt     = wKt;
    al._wPressHPa   = null;
    if (!al.url) al.url = mType === 'cyclone' ? 'https://www.nhc.noaa.gov/' : 'https://www.weather.gov/';
    return al;
  }

  function _processAlerts(alerts) {
    var AG  = window.ArgusGlobe;
    if (!AG) return;

    _altR = _getAlt();

    var incomingIds = {};
    var now = Date.now();

    for (var i = 0; i < alerts.length; i++) {
      var al = alerts[i];
      if (!al || !al.id || al.lat == null || al.lon == null) continue;
      if (al.expires && new Date(al.expires).getTime() < now) continue;
      incomingIds[al.id] = _enrich(al);
    }

    // Remove markers that expired or left the feed
    for (var oldId in _markers) {
      if (!incomingIds[oldId]) _removeMarker(oldId);
    }

    // Add new markers
    for (var newId in incomingIds) {
      if (!_markers[newId]) {
        _alertCache[newId] = incomingIds[newId];
        _addMarker(incomingIds[newId]);
      }
    }
  }

  function _poll() {
    if (_ctrl) { try { _ctrl.abort(); } catch (e) { /* ignore */ } }
    _ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    _audit.polls++;

    var opts = _ctrl ? { signal: _ctrl.signal } : {};

    fetch(NOAA_FN, opts)
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (json) {
        if (!json || json.disabled) return;
        if (!Array.isArray(json.alerts)) return;
        _processAlerts(json.alerts);
      })
      .catch(function (err) {
        if (err.name === 'AbortError') return;
        _audit.errors++;
        console.warn('[ArgusWeatherLayer] poll error:', err.message);
      });
  }

  // ── Hover / raycasting ────────────────────────────────────────────────────────

  var _mouseNX    = 0;
  var _mouseNY    = 0;
  var _mouseX     = 0;
  var _mouseY     = 0;
  var _raycaster  = null;
  var _mouseVec2  = null;
  var _hovTicker  = 0;       // only raycast every N ticks (performance)

  function _onMouseMove(e) {
    _mouseX = e.clientX;
    _mouseY = e.clientY;
    var t    = e.currentTarget || e.target;
    var rect = t.getBoundingClientRect ? t.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    _mouseNX = ((e.clientX - rect.left) / rect.width)  * 2 - 1;
    _mouseNY = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
  }

  function _attachMouseListener() {
    var cv = document.getElementById('globe-canvas-container') || document.querySelector('canvas');
    if (!cv) return;
    cv.addEventListener('mousemove', _onMouseMove, { passive: true });
  }

  function _checkHover() {
    if (!_enabled) return;
    if (!_spriteIndex.length) return;

    var AG = window.ArgusGlobe;
    if (!AG || !AG.camera) return;

    if (!_raycaster) _raycaster = new THREE.Raycaster();
    if (!_mouseVec2) _mouseVec2 = new THREE.Vector2();

    _mouseVec2.set(_mouseNX, _mouseNY);
    _raycaster.setFromCamera(_mouseVec2, AG.camera);

    // Build sprite list for intersection test
    var sprites = [];
    for (var i = 0; i < _spriteIndex.length; i++) {
      sprites.push(_spriteIndex[i].obj);
    }

    var hits = _raycaster.intersectObjects(sprites, false);
    if (hits.length > 0) {
      var hitObj = hits[0].object;
      var hitId  = null;
      for (var j = 0; j < _spriteIndex.length; j++) {
        if (_spriteIndex[j].obj === hitObj) { hitId = _spriteIndex[j].id; break; }
      }
      if (hitId && hitId !== _hoveredId) {
        _hoveredId = hitId;
        var al = _alertCache[hitId];
        if (al) _showTooltip(al, _mouseX, _mouseY);
      }
    } else {
      if (_hoveredId !== null) {
        _hoveredId = null;
        _hideTooltip();
      }
    }
  }

  // ── Public tick ───────────────────────────────────────────────────────────────

  var _lastT = null;

  function tick() {
    if (!_enabled) return;

    var now = performance.now();
    var dt  = _lastT !== null ? Math.min((now - _lastT) / 1000, 0.1) : 0.016;
    _lastT  = now;

    var AG     = window.ArgusGlobe;
    var camPos = AG && AG.camera ? AG.camera.position : null;

    for (var id in _markers) {
      var entry    = _markers[id];
      var marker   = entry.marker;

      // LOD — skip canvas redraws for far-away markers
      if (camPos) {
        var mPos = marker.sprite
          ? marker.sprite.position
          : (marker.group ? marker.group.position : null);
        if (mPos && mPos.distanceTo(camPos) > LOD_SKIP_DIST) continue;
      }

      marker.tick(dt);
    }

    // Check hover every 3 frames — raycasting is non-trivial
    _hovTicker++;
    if (_hovTicker % 3 === 0) _checkHover();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  function start() {
    if (_pollTimer) return;
    _attachMouseListener();
    // Deferred first poll: argusNoaa.js fires at 45s, ours at 55s to stagger load
    setTimeout(_poll, 55 * 1000);
    _pollTimer = setInterval(_poll, POLL_MS);
  }

  function stop() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    if (_ctrl) { try { _ctrl.abort(); } catch (e) { /* ignore */ } _ctrl = null; }
    for (var id in _markers) _removeMarker(id);
    _alertCache = {};
    _lastT      = null;
    _hideTooltip();
  }

  function toggle() {
    _enabled = !_enabled;
    if (window.ArgusLayerState) window.ArgusLayerState.weather = _enabled;
    _updateAllVisibility();
    return _enabled;
  }

  function setVisible(v) {
    _enabled = !!v;
    if (window.ArgusLayerState) window.ArgusLayerState.weather = _enabled;
    _updateAllVisibility();
  }

  function refresh() { _poll(); }

  function status() {
    return {
      enabled:  _enabled,
      markers:  Object.keys(_markers).length,
      polls:    _audit.polls,
      errors:   _audit.errors,
    };
  }

  // ── Auto-start ────────────────────────────────────────────────────────────────

  setTimeout(function () {
    if (window.ArgusLayerState) window.ArgusLayerState.weather = false;
    if (window._argusReqCache) {
      start();
    } else {
      setTimeout(function () { if (window._argusReqCache) start(); }, 3000);
    }
  }, 0);

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusWeatherLayer');

  return {
    tick:       tick,
    start:      start,
    stop:       stop,
    toggle:     toggle,
    setVisible: setVisible,
    refresh:    refresh,
    status:     status,
  };

}());
