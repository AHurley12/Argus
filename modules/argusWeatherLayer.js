'use strict';
// modules/argusWeatherLayer.js
// Animated NOAA weather intelligence overlay — pulse + cyclone sprite markers.
//
// Architecture:
//   Sole visual owner of NOAA NWS/NHC data. argusNoaa.js maintains the data feed
//   and weatherOverlayCache but no longer renders static geometry — this module
//   handles all NOAA marker rendering via canvas-texture THREE.Sprite objects.
//
//   Sprites are added to AG.weatherSpriteGroup, which is a child of AG.dataGroup.
//   This is the REQUIRED parent — latLonToVector outputs coords in dataGroup local
//   space, NOT scene root. Adding to scene directly causes position misalignment.
//   Coordinate conversion uses AG.latLonToVector (authoritative, not a local copy).
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

  var POLL_MS          = 60 * 1000;
  // Safety-net: prune any marker not seen in a fresh feed for this long.
  // Handles the case where consecutive polls fail and retired storms accumulate.
  var GHOST_MAX_AGE_MS = 90 * 60 * 1000;  // 90 minutes
  var GHOST_PRUNE_MS   = 5  * 60 * 1000;  // check every 5 minutes

  var PULSE_SIZE = 56;   // canvas logical px — actual canvas is CANVAS_QUALITY× larger
  var CYCO_SIZE  = 68;   // canvas logical px — actual canvas is CANVAS_QUALITY× larger

  // Supersampling factor applied to all canvas textures.
  // Sprites render at 4.8–7.0 world units vs vessels at 0.89 — a 6× scale mismatch.
  // 3× canvas resolution closes the gap without redesigning any drawing code.
  // Cost: 9× pixels per texture, capped at 20 pool entries = negligible vs the gain.
  var CANVAS_QUALITY = 3;

  var SCALE_PULSE   = 4.8;   // 3.0 × 1.6
  var SCALE_CYCLONE = 9.6;   // 2× SCALE_PULSE — tropical weather systems render larger than standard events

  // LOD: skip canvas redraws for markers this far from camera
  var LOD_SKIP_DIST = 350;

  // Frame-skip by severity — reduces canvas redraws + GPU texture uploads.
  // Lower severity alerts animate slowly enough that skipping frames is invisible.
  // extreme=1 (every frame), severe=2 (~30fps), moderate=3 (~20fps), minor=4 (~15fps)
  var SEV_FRAME_SKIP = {
    extreme:  1,
    severe:   2,
    moderate: 3,
    minor:    4,
  };

  // Severity-based sprite scale — visual hierarchy: extreme events are larger.
  // Applied only to GDACS hazard sprites (NOAA keeps flat SCALE_PULSE).
  var _HAZARD_SCALE = { minor: 3.8, moderate: 4.8, severe: 5.8, extreme: 7.0 };

  // ── Severity animation params ─────────────────────────────────────────────────

  // Matches flood icon speed — slow, deliberate, readable.
  // Single ring minor/moderate; echo ring at severe+ for added depth.
  var SEV_PARAMS = {
    minor:    { pulseSpeed: 0.012, ringThick: 0.9,  glowAlpha: 0.55, echo: false },
    moderate: { pulseSpeed: 0.018, ringThick: 1.1,  glowAlpha: 0.65, echo: false },
    severe:   { pulseSpeed: 0.024, ringThick: 1.3,  glowAlpha: 0.78, echo: true  },
    extreme:  { pulseSpeed: 0.032, ringThick: 1.6,  glowAlpha: 0.90, echo: true  },
  };

  // ── Drought severity animation params ─────────────────────────────────────────
  // ~half the pulse speed of NOAA weather — drought is slow, persistent, creeping.
  var DROUGHT_SEV_PARAMS = {
    minor:    { pulseSpeed: 0.008, ringThick: 0.8, glowAlpha: 0.45, segments: 3, ringCount: 1 },
    moderate: { pulseSpeed: 0.012, ringThick: 1.0, glowAlpha: 0.58, segments: 4, ringCount: 1 },
    severe:   { pulseSpeed: 0.016, ringThick: 1.2, glowAlpha: 0.70, segments: 4, ringCount: 2 },
    extreme:  { pulseSpeed: 0.020, ringThick: 1.5, glowAlpha: 0.85, segments: 5, ringCount: 2 },
  };

  // ── Wildfire severity animation params ────────────────────────────────────────
  // Slightly faster than NOAA weather — wildfires are kinetic, rapid, high-urgency.
  var WILDFIRE_SEV_PARAMS = {
    minor:    { pulseSpeed: 0.022, ringThick: 0.9, glowAlpha: 0.50, flareCount: 4, ringCount: 1 },
    moderate: { pulseSpeed: 0.030, ringThick: 1.1, glowAlpha: 0.65, flareCount: 5, ringCount: 1 },
    severe:   { pulseSpeed: 0.040, ringThick: 1.4, glowAlpha: 0.80, flareCount: 6, ringCount: 2 },
    extreme:  { pulseSpeed: 0.052, ringThick: 1.7, glowAlpha: 0.92, flareCount: 6, ringCount: 2 },
  };

  // ── Flood severity animation params ───────────────────────────────────────────
  // Slower than NOAA weather, calmer than wildfire — floods rise and spread
  // deliberately. Single smooth ring for minor/moderate; echo ring at severe+.
  var FLOOD_SEV_PARAMS = {
    minor:    { pulseSpeed: 0.012, ringThick: 0.9,  glowAlpha: 0.55, echo: false },
    moderate: { pulseSpeed: 0.018, ringThick: 1.1,  glowAlpha: 0.65, echo: false },
    severe:   { pulseSpeed: 0.024, ringThick: 1.3,  glowAlpha: 0.78, echo: true  },
    extreme:  { pulseSpeed: 0.032, ringThick: 1.6,  glowAlpha: 0.90, echo: true  },
  };

  // ── Earthquake severity animation params ──────────────────────────────────────
  // Slower than NOAA pulse, faster than drought — seismic events are acute but
  // not continuous. Fractured segmented ring with power-eased fast-burst expansion.
  // More segments at higher severity = more tectonic fracture detail.
  var EARTHQUAKE_SEV_PARAMS = {
    minor:    { pulseSpeed: 0.010, ringThick: 0.9,  glowAlpha: 0.55, segments: 4, ringCount: 1 },
    moderate: { pulseSpeed: 0.015, ringThick: 1.1,  glowAlpha: 0.68, segments: 4, ringCount: 1 },
    severe:   { pulseSpeed: 0.022, ringThick: 1.3,  glowAlpha: 0.80, segments: 5, ringCount: 2 },
    extreme:  { pulseSpeed: 0.030, ringThick: 1.6,  glowAlpha: 0.92, segments: 6, ringCount: 2 },
  };

  // ── Colors ───────────────────────────────────────────────────────────────────

  var C_NUCLEUS = '#72eeff';
  var C_INNER   = '#4fc3ff';
  var C_OUTER   = '#0ea5e9';

  // ── Drought palette ───────────────────────────────────────────────────────────
  var D_AMBER = '#cc8800';   // base amber — matches GDACS drought category color
  var D_DRY   = '#ff9900';   // dry orange
  var D_HOT   = '#aa5500';   // muted red-orange (extreme escalation)

  // ── Wildfire palette ──────────────────────────────────────────────────────────
  var W_ORANGE = '#ff6600';  // fire orange — base wildfire color
  var W_EMBER  = '#cc3300';  // deep ember red
  var W_HOT    = '#ffaa00';  // hot yellow (flare tips and core)

  // ── Flood palette ─────────────────────────────────────────────────────────────
  var F_CORE = '#66ccee';   // soft aqua nucleus — calm, hydrological
  var F_AQUA = '#44aadd';   // deep cyan primary ring
  var F_CYAN = '#2277bb';   // muted blue echo ring (severe+)

  // ── Earthquake palette ────────────────────────────────────────────────────────
  // Amber → orange → deep red gradient by severity. White seismic core at extreme.
  var EQ_AMBER  = '#dd7700';  // warm amber — minor
  var EQ_ORANGE = '#ee5500';  // orange — moderate/severe escalation
  var EQ_RED    = '#cc2200';  // deep red — severe/extreme
  var EQ_CORE   = '#ffffff';  // white seismic flash — extreme only

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

  // Flood event types — routed to FloodMarker (same icon for NOAA and GDACS floods).
  var FLOOD_TYPES = {
    'Flood Warning': 1, 'Flood Watch': 1, 'Flood Advisory': 1,
    'Flash Flood Warning': 1, 'Flash Flood Watch': 1, 'Flash Flood Statement': 1,
    'Coastal Flood Warning': 1, 'Coastal Flood Watch': 1, 'Coastal Flood Advisory': 1,
    'Lakeshore Flood Warning': 1, 'River Flood Warning': 1, 'Areal Flood Warning': 1,
  };

  var PULSE_TYPES = {
    'Special Weather Statement': 1, 'Severe Thunderstorm Warning': 1,
    'Severe Thunderstorm Watch': 1, 'Tornado Warning': 1, 'Tornado Watch': 1,
    'Dense Fog Advisory': 1, 'High Wind Warning': 1, 'High Wind Watch': 1,
    'Winter Storm Warning': 1, 'Winter Storm Watch': 1, 'Blizzard Warning': 1,
    'Ice Storm Warning': 1, 'Winter Weather Advisory': 1, 'Freezing Rain Advisory': 1,
  };

  function classify(eventType) {
    if (!eventType) return 'pulse';
    if (CYCLONE_TYPES[eventType]) return 'cyclone';
    if (FLOOD_TYPES[eventType])   return 'flood';
    if (PULSE_TYPES[eventType])   return 'pulse';
    var low = eventType.toLowerCase();
    if (low.indexOf('hurricane') >= 0 || low.indexOf('typhoon') >= 0 ||
        low.indexOf('cyclone') >= 0   || low.indexOf('tropical') >= 0) return 'cyclone';
    if (low.indexOf('flood') >= 0) return 'flood';
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
    var cv  = document.createElement('canvas');
    var res = Math.round(size * CANVAS_QUALITY);
    cv.width = cv.height = res;
    var ctx = cv.getContext('2d');
    ctx.scale(CANVAS_QUALITY, CANVAS_QUALITY);
    return { canvas: cv, ctx: ctx };
  }

  // ── HazardTexturePool ──────────────────────────────────────────────────────────
  //
  // Scalability core. All markers of the same (category, severity) share ONE
  // canvas texture. N hazard sprites → max 20 GPU texture uploads per frame cycle
  // (5 types × 4 severities) regardless of event count.
  //
  // Contract:
  //   get(category, severity)              → THREE.CanvasTexture (shared, ref-counted)
  //   release(category, severity)          → decrements ref; disposes texture at zero
  //   register(category, severity, sprite) → registers sprite for LOD checks
  //   unregister(category, severity, sprite)
  //   tick(dt, camPos)                     → redraws active textures (LOD-gated)
  //
  // LOD: a texture is only redrawn when ≥1 registered sprite is within LOD_SKIP_DIST
  // of the camera. Sprites beyond range are frozen — not visible at that distance.
  //
  // Disposal: markers call release() in dispose(). When refs reach 0, the texture
  // object (and its GPU memory) is freed. Pool entry is removed cleanly.

  var _poolEntries = {};  // key: "cat:sev" → { tex: XxxPulseTexture, refs: Number, sprites: Array }

  var HazardTexturePool = {

    get: function (category, severity) {
      var k = category + ':' + severity;
      if (!_poolEntries[k]) {
        var tex;
        if      (category === 'earthquake') tex = new EarthquakePulseTexture(severity);
        else if (category === 'drought')    tex = new DroughtPulseTexture(severity);
        else if (category === 'wildfire')   tex = new WildfirePulseTexture(severity);
        else if (category === 'flood')      tex = new FloodPulseTexture(severity);
        else                                tex = new WeatherPulseTexture(severity);
        _poolEntries[k] = { tex: tex, refs: 0, sprites: [] };
      }
      _poolEntries[k].refs++;
      return _poolEntries[k].tex.texture;  // THREE.CanvasTexture
    },

    release: function (category, severity) {
      var k = category + ':' + severity;
      var e = _poolEntries[k];
      if (!e) return;
      e.refs--;
      if (e.refs <= 0) {
        e.tex.dispose();
        delete _poolEntries[k];
      }
    },

    register: function (category, severity, sprite) {
      var k = category + ':' + severity;
      if (_poolEntries[k]) _poolEntries[k].sprites.push(sprite);
    },

    unregister: function (category, severity, sprite) {
      var k = category + ':' + severity;
      var e = _poolEntries[k];
      if (!e) return;
      var idx = e.sprites.indexOf(sprite);
      if (idx >= 0) e.sprites.splice(idx, 1);
    },

    tick: function (dt, camPos) {
      for (var k in _poolEntries) {
        var e       = _poolEntries[k];
        var sprites = e.sprites;
        if (!sprites.length) continue;
        // LOD: skip redraw when all sprites of this type are beyond camera range
        if (camPos) {
          var near = false;
          for (var i = 0; i < sprites.length; i++) {
            if (sprites[i].position.distanceTo(camPos) <= LOD_SKIP_DIST) { near = true; break; }
          }
          if (!near) continue;
        }
        e.tex.tick(dt);
      }
    },
  };

  // ── WeatherPulseTexture ────────────────────────────────────────────────────────
  //
  // Animated canvas texture for non-cyclone, non-flood NOAA weather alerts.
  // Single smooth expanding ring (Power-2.2 falloff) matching the flood icon's
  // speed and visual weight. Echo ring at severe+ for added urgency. No turbulence
  // streaks — clean, readable, institutionally restrained.

  function WeatherPulseTexture(severity) {
    var c = makeCanvas(PULSE_SIZE);
    this.canvas     = c.canvas;
    this.ctx        = c.ctx;
    this.severity   = severity || 'minor';
    this.params     = SEV_PARAMS[this.severity] || SEV_PARAMS.minor;
    this.t          = 0;
    this._tickCount = 0;
    this._frameSkip = SEV_FRAME_SKIP[this.severity] || 4;
    this.texture    = new THREE.CanvasTexture(this.canvas);
    this._draw();
    this.texture.needsUpdate = true;
  }

  WeatherPulseTexture.prototype.tick = function (dt) {
    this._tickCount++;
    if (this._tickCount % this._frameSkip !== 0) return;
    this.t += dt * 60 * this._frameSkip;  // advance time to match skipped frames
    this._draw();
    this.texture.needsUpdate = true;
  };

  WeatherPulseTexture.prototype._draw = function () {
    var ctx    = this.ctx;
    var size   = PULSE_SIZE;
    var cx     = size / 2;
    var cy     = size / 2;
    var p      = this.params;
    var t      = this.t;
    var severe = this.severity === 'severe' || this.severity === 'extreme';

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';

    // ── Primary ring: single smooth expansion, graceful Power-2.2 falloff ────────
    var maxR  = severe ? 24 : 20;
    var phase = (t * p.pulseSpeed) % 1;
    var r     = 5 + phase * maxR;
    var alpha = p.glowAlpha * Math.pow(1 - phase, 2.2);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = hexAlpha(C_INNER, alpha);
    ctx.lineWidth   = p.ringThick;
    ctx.stroke();

    // ── Echo ring (severe+): trailing 50% behind, adds depth without noise ────────
    if (p.echo) {
      var phase2 = (phase + 0.50) % 1;
      var r2     = 5 + phase2 * maxR;
      var alpha2 = p.glowAlpha * 0.45 * Math.pow(1 - phase2, 2.6);
      ctx.beginPath();
      ctx.arc(cx, cy, r2, 0, Math.PI * 2);
      ctx.strokeStyle = hexAlpha(C_OUTER, alpha2);
      ctx.lineWidth   = p.ringThick * 0.60;
      ctx.stroke();
    }

    // ── Nucleus: slow 8-second breathing cycle ────────────────────────────────────
    var breathe = 1 + Math.sin(t * 0.013) * 0.12;
    ctx.beginPath();
    ctx.arc(cx, cy, 2.6 * breathe, 0, Math.PI * 2);
    ctx.fillStyle = hexAlpha(C_NUCLEUS, severe ? 0.85 : 0.62);
    ctx.fill();

    // ── Core anchor ───────────────────────────────────────────────────────────────
    ctx.beginPath();
    ctx.arc(cx, cy, 1.1, 0, Math.PI * 2);
    ctx.fillStyle = C_NUCLEUS;
    ctx.fill();

    ctx.restore();
  };

  WeatherPulseTexture.prototype.dispose = function () {
    this.texture.dispose();
  };

  // ── CycloneMarker ──────────────────────────────────────────────────────────────
  //
  // THREE.Group with 2 independently animated sprite layers:
  //   armSprite  — 3 segmented rotational arms, rotates clockwise
  //   eyeSprite  — 4 counter-rotating inner shards + dark core nucleus, rotates CCW
  //
  // Design: light blue/cyan palette, semi-3D spiral, bright central eye, additive blending.
  // Size: SCALE_CYCLONE = 2× SCALE_PULSE (double standard event marker size).
  // No pulse ring — clean intelligence-platform aesthetic, no weather-app effects.

  function CycloneMarker(scene, position, severity) {
    this.severity    = severity || 'minor';
    this.t           = 0;
    this._outerAngle = 0;
    this._innerAngle = 0;
    this._tickCount  = 0;
    this._frameSkip  = SEV_FRAME_SKIP[severity] || 4;
    this.group       = new THREE.Group();

    var armC = makeCanvas(CYCO_SIZE);
    var eyeC = makeCanvas(CYCO_SIZE);

    this._armCtx = armC.ctx;
    this._eyeCtx = eyeC.ctx;

    this.armTex = new THREE.CanvasTexture(armC.canvas);
    this.eyeTex = new THREE.CanvasTexture(eyeC.canvas);

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

    this.group.add(this.armSprite);
    this.group.add(this.eyeSprite);
    this.group.position.copy(position);
    scene.add(this.group);

    // Draw initial frame
    var severe = this.severity === 'severe' || this.severity === 'extreme';
    this._drawArms(0, severe);
    this._drawEye(0, severe);
    this.armTex.needsUpdate = this.eyeTex.needsUpdate = true;
  }

  CycloneMarker.prototype.tick = function (dt) {
    this._tickCount++;
    var skip   = this._frameSkip;
    var severe = this.severity === 'severe' || this.severity === 'extreme';

    // Arms + eye: update at severity frame-skip rate
    if (this._tickCount % skip === 0) {
      this.t           += dt * 60 * skip;
      this._outerAngle += (severe ? 0.022 : 0.014) * skip;
      this._innerAngle -= (severe ? 0.016 : 0.010) * skip;
      this._drawArms(this._outerAngle, severe);
      this._drawEye(this._innerAngle, severe);
      this.armTex.needsUpdate = this.eyeTex.needsUpdate = true;
    }
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

  CycloneMarker.prototype.setVisible = function (v) {
    this.group.visible = v;
  };

  CycloneMarker.prototype.dispose = function () {
    this.armTex.dispose();
    this.eyeTex.dispose();
    this.armSprite.material.dispose();
    this.eyeSprite.material.dispose();
    if (this.group.parent) this.group.parent.remove(this.group);
  };

  // ── PulseMarker (sprite wrapper) ─────────────────────────────────────────────
  // Uses HazardTexturePool — all NOAA pulse alerts of the same severity share one
  // canvas texture. tick() is a no-op; pool drives redraws from ArgusWeatherLayer.tick().

  function PulseMarker(scene, position, severity) {
    this._category = 'pulse';
    this.severity  = severity || 'minor';
    this.material  = new THREE.SpriteMaterial({
      map: HazardTexturePool.get('pulse', this.severity), transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
      color: 0xffffff,  // no tint: canvas draws intended colors directly
    });
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.scale.setScalar(SCALE_PULSE);
    this.sprite.position.copy(position);
    scene.add(this.sprite);
    HazardTexturePool.register('pulse', this.severity, this.sprite);
  }

  PulseMarker.prototype.tick = function (dt) { /* no-op: HazardTexturePool.tick() drives this */ };

  PulseMarker.prototype.setVisible = function (v) {
    this.sprite.visible = v;
  };

  PulseMarker.prototype.dispose = function () {
    HazardTexturePool.unregister('pulse', this.severity, this.sprite);
    HazardTexturePool.release('pulse', this.severity);
    this.material.dispose();  // material is per-marker; texture is pool-owned
    if (this.sprite.parent) this.sprite.parent.remove(this.sprite);
  };

  // ── DroughtPulseTexture ────────────────────────────────────────────────────────
  //
  // Animated canvas texture for GDACS drought events.
  // Fractured arc ring (N segments with gaps) expands slowly outward — like cracked
  // earth radiating heat. Faint radial tick marks from the nucleus suggest heat
  // shimmer. Nucleus breathes on a long ~10-second cycle. Total animation speed is
  // roughly half that of NOAA weather — drought is a creeping, geographically
  // expansive threat, not an acute burst event.

  function DroughtPulseTexture(severity) {
    var c = makeCanvas(PULSE_SIZE);
    this.canvas     = c.canvas;
    this.ctx        = c.ctx;
    this.severity   = severity || 'minor';
    this.params     = DROUGHT_SEV_PARAMS[this.severity] || DROUGHT_SEV_PARAMS.minor;
    this.t          = 0;
    this._tickCount = 0;
    this._frameSkip = SEV_FRAME_SKIP[this.severity] || 4;
    this.texture    = new THREE.CanvasTexture(this.canvas);
    this._draw();
    this.texture.needsUpdate = true;
  }

  DroughtPulseTexture.prototype.tick = function (dt) {
    this._tickCount++;
    if (this._tickCount % this._frameSkip !== 0) return;
    this.t += dt * 60 * this._frameSkip;
    this._draw();
    this.texture.needsUpdate = true;
  };

  DroughtPulseTexture.prototype._draw = function () {
    var ctx     = this.ctx;
    var size    = PULSE_SIZE;
    var cx      = size / 2;
    var cy      = size / 2;
    var p       = this.params;
    var t       = this.t;
    var severe  = this.severity === 'severe' || this.severity === 'extreme';
    var extreme = this.severity === 'extreme';

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';

    // ── Fractured ring(s): segmented arcs, very slow outward expansion ─────────
    var maxR     = severe ? 24 : 20;
    var segCount = p.segments;
    var slotSize = (Math.PI * 2) / segCount;
    var segArc   = slotSize * 0.82;  // 18% gap between each segment

    for (var ri = 0; ri < p.ringCount; ri++) {
      var phase   = ((t * p.pulseSpeed) + ri * (1 / p.ringCount)) % 1;
      var r       = 5 + phase * maxR;
      var alpha   = p.glowAlpha * Math.pow(1 - phase, 1.8);
      var baseRot = t * 0.0015 + ri * 0.5;  // very slow rotation — creeping spread

      for (var si = 0; si < segCount; si++) {
        var startAngle = baseRot + si * slotSize;
        ctx.beginPath();
        ctx.arc(cx, cy, r, startAngle, startAngle + segArc);
        ctx.strokeStyle = hexAlpha(extreme ? D_HOT : D_AMBER, alpha);
        ctx.lineWidth   = p.ringThick;
        ctx.stroke();
      }
    }

    // ── Heat shimmer: faint radial tick marks from nucleus ────────────────────
    var nTicks    = severe ? 8 : 6;
    var tickAlpha = severe ? 0.22 : 0.12;
    for (var ti = 0; ti < nTicks; ti++) {
      var ang   = (ti / nTicks) * Math.PI * 2 + t * 0.0008;
      var inner = 2.5;
      var outer = 4.5 + Math.sin(t * 0.018 + ti * 0.9) * 0.7;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * inner, cy + Math.sin(ang) * inner);
      ctx.lineTo(cx + Math.cos(ang) * outer, cy + Math.sin(ang) * outer);
      ctx.strokeStyle = hexAlpha(D_DRY, tickAlpha);
      ctx.lineWidth   = 0.5;
      ctx.stroke();
    }

    // ── Nucleus: slow amber breathing disc (~10-second cycle) ─────────────────
    var breathe = 1 + Math.sin(t * 0.010) * 0.15;
    ctx.beginPath();
    ctx.arc(cx, cy, 3.0 * breathe, 0, Math.PI * 2);
    ctx.fillStyle = hexAlpha(D_AMBER, severe ? 0.88 : 0.62);
    ctx.fill();

    // ── Core dot: always visible anchor point ─────────────────────────────────
    ctx.beginPath();
    ctx.arc(cx, cy, 1.2, 0, Math.PI * 2);
    ctx.fillStyle = D_AMBER;
    ctx.fill();

    ctx.restore();
  };

  DroughtPulseTexture.prototype.dispose = function () {
    this.texture.dispose();
  };

  // ── WildfirePulseTexture ───────────────────────────────────────────────────────
  //
  // Animated canvas texture for GDACS wildfire events.
  // Expanding thermal ring with sharp falloff — faster and more kinetic than drought
  // or NOAA pulse. Angular flare spikes radiate at even intervals with chevron tips,
  // suggesting directional spread. Ember nucleus surges in sync with ring pulse.
  // Operationally restrained — distinct urgency without arcade noise.

  function WildfirePulseTexture(severity) {
    var c = makeCanvas(PULSE_SIZE);
    this.canvas     = c.canvas;
    this.ctx        = c.ctx;
    this.severity   = severity || 'minor';
    this.params     = WILDFIRE_SEV_PARAMS[this.severity] || WILDFIRE_SEV_PARAMS.minor;
    this.t          = 0;
    this._tickCount = 0;
    this._frameSkip = SEV_FRAME_SKIP[this.severity] || 4;
    this.texture    = new THREE.CanvasTexture(this.canvas);
    this._draw();
    this.texture.needsUpdate = true;
  }

  WildfirePulseTexture.prototype.tick = function (dt) {
    this._tickCount++;
    if (this._tickCount % this._frameSkip !== 0) return;
    this.t += dt * 60 * this._frameSkip;
    this._draw();
    this.texture.needsUpdate = true;
  };

  WildfirePulseTexture.prototype._draw = function () {
    var ctx    = this.ctx;
    var size   = PULSE_SIZE;
    var cx     = size / 2;
    var cy     = size / 2;
    var p      = this.params;
    var t      = this.t;
    var severe = this.severity === 'severe' || this.severity === 'extreme';

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';

    // ── Expanding thermal ring — sharper falloff than drought ──────────────────
    var maxR  = severe ? 25 : 21;
    var phase = (t * p.pulseSpeed) % 1;
    var r     = 5 + phase * maxR;
    var alpha = p.glowAlpha * Math.pow(1 - phase, 1.2);  // sharper than drought (1.8)
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = hexAlpha(W_ORANGE, alpha);
    ctx.lineWidth   = p.ringThick;
    ctx.stroke();

    // Trailing ember ring (severe+) — lagged 48% behind primary
    if (p.ringCount > 1) {
      var phase2 = (phase + 0.48) % 1;
      var r2     = 5 + phase2 * maxR;
      var alpha2 = p.glowAlpha * 0.50 * Math.pow(1 - phase2, 1.6);
      ctx.beginPath();
      ctx.arc(cx, cy, r2, 0, Math.PI * 2);
      ctx.strokeStyle = hexAlpha(W_EMBER, alpha2);
      ctx.lineWidth   = p.ringThick * 0.65;
      ctx.stroke();
    }

    // ── Angular flare spikes — N radial spikes with chevron tips ──────────────
    var nFlares  = p.flareCount;
    var rotSpeed = severe ? 0.006 : 0.003;  // slow rotation for operational readability
    var baseLen  = severe ? 7 : 5;
    for (var fi = 0; fi < nFlares; fi++) {
      var baseAng  = (fi / nFlares) * Math.PI * 2 + t * rotSpeed;
      var flutter  = Math.sin(t * 0.040 + fi * 1.1) * 1.8;  // length flicker
      var flareLen = Math.max(2, baseLen + flutter);

      // Spike line
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(baseAng) * 2.5,      cy + Math.sin(baseAng) * 2.5);
      ctx.lineTo(cx + Math.cos(baseAng) * flareLen, cy + Math.sin(baseAng) * flareLen);
      ctx.strokeStyle = hexAlpha(W_HOT, severe ? 0.50 : 0.32);
      ctx.lineWidth   = severe ? 0.85 : 0.65;
      ctx.stroke();

      // Chevron at spike tip — two angled micro-lines
      var tipX = cx + Math.cos(baseAng) * flareLen;
      var tipY = cy + Math.sin(baseAng) * flareLen;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(
        tipX + Math.cos(baseAng + Math.PI * 0.75) * 1.4,
        tipY + Math.sin(baseAng + Math.PI * 0.75) * 1.4
      );
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(
        tipX + Math.cos(baseAng - Math.PI * 0.75) * 1.4,
        tipY + Math.sin(baseAng - Math.PI * 0.75) * 1.4
      );
      ctx.strokeStyle = hexAlpha(W_ORANGE, severe ? 0.30 : 0.18);
      ctx.lineWidth   = 0.5;
      ctx.stroke();
    }

    // ── Ember nucleus: surges in sync with the primary thermal ring ───────────
    var surge   = Math.pow(Math.sin(phase * Math.PI), 2);  // peaks at ring midpoint
    var breathe = 1 + surge * 0.28;
    ctx.beginPath();
    ctx.arc(cx, cy, 3.2 * breathe, 0, Math.PI * 2);
    ctx.fillStyle = hexAlpha(W_ORANGE, severe ? 0.88 : 0.68);
    ctx.fill();

    // Core ember dot
    ctx.beginPath();
    ctx.arc(cx, cy, 1.4, 0, Math.PI * 2);
    ctx.fillStyle = W_HOT;
    ctx.fill();

    ctx.restore();
  };

  WildfirePulseTexture.prototype.dispose = function () {
    this.texture.dispose();
  };

  // ── DroughtMarker (sprite wrapper) ────────────────────────────────────────────
  // Pool-based: all drought sprites of the same severity share one canvas texture.
  // Severity-aware scale via _HAZARD_SCALE. No tint (0xffffff) — canvas colors accurate.

  function DroughtMarker(scene, position, severity) {
    this._category = 'drought';
    this.severity  = severity || 'minor';
    this.material  = new THREE.SpriteMaterial({
      map: HazardTexturePool.get('drought', this.severity), transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
      color: 0xffffff,
    });
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.scale.setScalar(_HAZARD_SCALE[this.severity] || SCALE_PULSE);
    this.sprite.position.copy(position);
    scene.add(this.sprite);
    HazardTexturePool.register('drought', this.severity, this.sprite);
  }

  DroughtMarker.prototype.tick = function (dt) { /* no-op: HazardTexturePool.tick() drives this */ };

  DroughtMarker.prototype.setVisible = function (v) { this.sprite.visible = !!v; };

  DroughtMarker.prototype.dispose = function () {
    HazardTexturePool.unregister('drought', this.severity, this.sprite);
    HazardTexturePool.release('drought', this.severity);
    this.material.dispose();
    if (this.sprite.parent) this.sprite.parent.remove(this.sprite);
  };

  // ── WildfireMarker (sprite wrapper) ───────────────────────────────────────────
  // Pool-based: all wildfire sprites of the same severity share one canvas texture.

  function WildfireMarker(scene, position, severity) {
    this._category = 'wildfire';
    this.severity  = severity || 'minor';
    this.material  = new THREE.SpriteMaterial({
      map: HazardTexturePool.get('wildfire', this.severity), transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
      color: 0xffffff,
    });
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.scale.setScalar(_HAZARD_SCALE[this.severity] || SCALE_PULSE);
    this.sprite.position.copy(position);
    scene.add(this.sprite);
    HazardTexturePool.register('wildfire', this.severity, this.sprite);
  }

  WildfireMarker.prototype.tick = function (dt) { /* no-op: HazardTexturePool.tick() drives this */ };

  WildfireMarker.prototype.setVisible = function (v) { this.sprite.visible = !!v; };

  WildfireMarker.prototype.dispose = function () {
    HazardTexturePool.unregister('wildfire', this.severity, this.sprite);
    HazardTexturePool.release('wildfire', this.severity);
    this.material.dispose();
    if (this.sprite.parent) this.sprite.parent.remove(this.sprite);
  };

  // ── FloodPulseTexture ─────────────────────────────────────────────────────────
  //
  // Unified animated canvas texture for ALL flood events — NOAA NWS flood alerts
  // AND GDACS flood events share this exact same icon, palette, and animation language.
  //
  // Design: single smooth expanding ring (graceful Power-2.2 falloff), no turbulence
  // streaks, no angular noise. At severe+ an echo ring trails 50% behind the primary.
  // Nucleus breathes on a slow ~8-second cycle. Hydrological palette (deep cyan,
  // muted aqua) signals rising water rather than acute burst events.

  function FloodPulseTexture(severity) {
    var c = makeCanvas(PULSE_SIZE);
    this.canvas     = c.canvas;
    this.ctx        = c.ctx;
    this.severity   = severity || 'minor';
    this.params     = FLOOD_SEV_PARAMS[this.severity] || FLOOD_SEV_PARAMS.minor;
    this.t          = 0;
    this._tickCount = 0;
    this._frameSkip = SEV_FRAME_SKIP[this.severity] || 4;
    this.texture    = new THREE.CanvasTexture(this.canvas);
    this._draw();
    this.texture.needsUpdate = true;
  }

  FloodPulseTexture.prototype.tick = function (dt) {
    this._tickCount++;
    if (this._tickCount % this._frameSkip !== 0) return;
    this.t += dt * 60 * this._frameSkip;
    this._draw();
    this.texture.needsUpdate = true;
  };

  FloodPulseTexture.prototype._draw = function () {
    var ctx    = this.ctx;
    var size   = PULSE_SIZE;
    var cx     = size / 2;
    var cy     = size / 2;
    var p      = this.params;
    var t      = this.t;
    var severe = this.severity === 'severe' || this.severity === 'extreme';

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';

    // ── Primary ring: single smooth expansion, very graceful falloff ──────────
    var maxR  = severe ? 24 : 20;
    var phase = (t * p.pulseSpeed) % 1;
    var r     = 5 + phase * maxR;
    var alpha = p.glowAlpha * Math.pow(1 - phase, 2.2);  // gentlest falloff in the set
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = hexAlpha(F_AQUA, alpha);
    ctx.lineWidth   = p.ringThick;
    ctx.stroke();

    // ── Echo ring (severe+): trailing 50% behind — depth and inundation feel ──
    if (p.echo) {
      var phase2 = (phase + 0.50) % 1;
      var r2     = 5 + phase2 * maxR;
      var alpha2 = p.glowAlpha * 0.45 * Math.pow(1 - phase2, 2.6);
      ctx.beginPath();
      ctx.arc(cx, cy, r2, 0, Math.PI * 2);
      ctx.strokeStyle = hexAlpha(F_CYAN, alpha2);
      ctx.lineWidth   = p.ringThick * 0.60;
      ctx.stroke();
    }

    // ── Nucleus: soft aqua, slow 8-second breathing cycle ────────────────────
    var breathe = 1 + Math.sin(t * 0.013) * 0.12;  // ~8s cycle, 12% amplitude
    ctx.beginPath();
    ctx.arc(cx, cy, 2.6 * breathe, 0, Math.PI * 2);
    ctx.fillStyle = hexAlpha(F_CORE, severe ? 0.85 : 0.62);
    ctx.fill();

    // ── Core anchor dot ───────────────────────────────────────────────────────
    ctx.beginPath();
    ctx.arc(cx, cy, 1.1, 0, Math.PI * 2);
    ctx.fillStyle = F_CORE;
    ctx.fill();

    ctx.restore();
  };

  FloodPulseTexture.prototype.dispose = function () {
    this.texture.dispose();
  };

  // ── FloodMarker (sprite wrapper) ──────────────────────────────────────────────
  // Pool-based: NOAA flood alerts + GDACS flood events share one texture per severity.
  // GDACS instances use _HAZARD_SCALE; NOAA uses flat SCALE_PULSE (see isGdacs flag).

  function FloodMarker(scene, position, severity, isGdacs) {
    this._category = 'flood';
    this.severity  = severity || 'minor';
    this.material  = new THREE.SpriteMaterial({
      map: HazardTexturePool.get('flood', this.severity), transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
      color: 0xffffff,
    });
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.scale.setScalar(isGdacs ? (_HAZARD_SCALE[this.severity] || SCALE_PULSE) : SCALE_PULSE);
    this.sprite.position.copy(position);
    scene.add(this.sprite);
    HazardTexturePool.register('flood', this.severity, this.sprite);
  }

  FloodMarker.prototype.tick = function (dt) { /* no-op: HazardTexturePool.tick() drives this */ };

  FloodMarker.prototype.setVisible = function (v) { this.sprite.visible = !!v; };

  FloodMarker.prototype.dispose = function () {
    HazardTexturePool.unregister('flood', this.severity, this.sprite);
    HazardTexturePool.release('flood', this.severity);
    this.material.dispose();
    if (this.sprite.parent) this.sprite.parent.remove(this.sprite);
  };

  // ── EarthquakePulseTexture ────────────────────────────────────────────────────
  //
  // Animated canvas texture for GDACS earthquake events.
  // Visual language: institutional, seismic, structurally destabilizing.
  //
  // Ring geometry: N fractured arc segments (22% gap), angularly static with
  // alternating ±0.04 rad tectonic displacement between adjacent segments.
  // Ring expansion uses Power-0.65 easing — fast initial seismic wave burst that
  // decelerates naturally as energy dissipates outward.
  //
  // Epicenter geometry: 4 faint radial spokes at ×45° to cardinal directions,
  // drifting at 0.0006 rad/tick (ultra-slow tectonic drift). Suggests fault-line
  // intersection without adding visual clutter.
  //
  // Nucleus: jolt-pulse in sync with ring expansion (not smooth breathing).
  // Peaks at ring mid-expansion; falls off sharply — seismic urgency, not drought.
  //
  // Palette: amber (minor) → orange (moderate) → red (severe/extreme).
  // Extreme: white seismic core anchor dot.

  function EarthquakePulseTexture(severity) {
    var c = makeCanvas(PULSE_SIZE);
    this.canvas     = c.canvas;
    this.ctx        = c.ctx;
    this.severity   = severity || 'minor';
    this.params     = EARTHQUAKE_SEV_PARAMS[this.severity] || EARTHQUAKE_SEV_PARAMS.minor;
    this.t          = 0;
    this._tickCount = 0;
    this._frameSkip = SEV_FRAME_SKIP[this.severity] || 4;
    this.texture    = new THREE.CanvasTexture(this.canvas);
    this._draw();
    this.texture.needsUpdate = true;
  }

  EarthquakePulseTexture.prototype.tick = function (dt) {
    this._tickCount++;
    if (this._tickCount % this._frameSkip !== 0) return;
    this.t += dt * 60 * this._frameSkip;
    this._draw();
    this.texture.needsUpdate = true;
  };

  EarthquakePulseTexture.prototype._draw = function () {
    var ctx     = this.ctx;
    var size    = PULSE_SIZE;
    var cx      = size / 2;
    var cy      = size / 2;
    var p       = this.params;
    var t       = this.t;
    var severe  = this.severity === 'severe' || this.severity === 'extreme';
    var extreme = this.severity === 'extreme';

    // Severity-graduated colors: amber → orange → red
    var ringColor = extreme ? EQ_RED    :
                    severe  ? EQ_ORANGE : EQ_AMBER;
    var echoColor = extreme ? EQ_ORANGE : EQ_AMBER;

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';

    // ── Fractured seismic ring(s): segmented arcs, power-eased expansion ─────────
    // Power-0.65: fast initial seismic burst that decelerates as wave propagates.
    // Segments are angularly STATIC (no rotation) — alternating ±0.04 rad offsets
    // simulate tectonic plate displacement along fault boundaries.
    var maxR     = severe ? 25 : 21;
    var segCount = p.segments;
    var slotSize = (Math.PI * 2) / segCount;
    var segArc   = slotSize * 0.78;   // 22% gap — more open fracture than drought

    for (var ri = 0; ri < p.ringCount; ri++) {
      var phase = ((t * p.pulseSpeed) + ri * (1 / p.ringCount)) % 1;
      var r     = 5 + Math.pow(phase, 0.65) * maxR;
      var alpha = p.glowAlpha * Math.pow(1 - phase, 1.5);
      var col   = ri === 0 ? ringColor : echoColor;
      var lw    = p.ringThick * (ri === 0 ? 1.0 : 0.65);
      var al    = alpha * (ri === 0 ? 1.0 : 0.50);

      for (var si = 0; si < segCount; si++) {
        // Alternating jitter: adjacent segments displaced ±0.04 rad (tectonic offset)
        var jitter     = (si % 2 === 0) ? 0.04 : -0.04;
        var startAngle = si * slotSize + jitter;
        ctx.beginPath();
        ctx.arc(cx, cy, r, startAngle, startAngle + segArc);
        ctx.strokeStyle = hexAlpha(col, al);
        ctx.lineWidth   = lw;
        ctx.stroke();
      }
    }

    // ── Tectonic fault cross: faint epicenter marker, ultra-slow drift ────────────
    // 4 spokes at ×45° to cardinal — fault-line geometry at the seismic epicenter.
    // Drift is 0.0006 rad/tick — barely perceptible but alive (no frozen static look).
    var faultLen   = severe ? 5.5 : 4.0;
    var faultAlpha = severe ? 0.22 : 0.14;
    var faultRot   = t * 0.0006;
    for (var fi = 0; fi < 4; fi++) {
      var fang = faultRot + (fi / 4) * Math.PI * 2 + Math.PI * 0.25;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(fang) * 1.6, cy + Math.sin(fang) * 1.6);
      ctx.lineTo(cx + Math.cos(fang) * faultLen, cy + Math.sin(fang) * faultLen);
      ctx.strokeStyle = hexAlpha(ringColor, faultAlpha);
      ctx.lineWidth   = 0.65;
      ctx.stroke();
    }

    // ── Seismic nucleus: jolt-pulse tied to ring expansion, not smooth breathing ──
    // surge = sin²(phase * π) — peaks at ring mid-expansion, sharp falloff.
    // Distinct from drought (slow breathing) — conveys seismic urgency.
    var phase0  = (t * p.pulseSpeed) % 1;
    var surge   = Math.pow(Math.sin(phase0 * Math.PI), 2);
    var breathe = 1 + surge * 0.24;
    ctx.beginPath();
    ctx.arc(cx, cy, 2.8 * breathe, 0, Math.PI * 2);
    ctx.fillStyle = hexAlpha(extreme ? EQ_RED : ringColor, severe ? 0.88 : 0.65);
    ctx.fill();

    // ── Core anchor: white seismic flash for extreme, amber/orange otherwise ──────
    ctx.beginPath();
    ctx.arc(cx, cy, 1.2, 0, Math.PI * 2);
    ctx.fillStyle = extreme ? EQ_CORE : ringColor;
    ctx.fill();

    ctx.restore();
  };

  EarthquakePulseTexture.prototype.dispose = function () {
    this.texture.dispose();
  };

  // ── EarthquakeMarker (sprite wrapper) ─────────────────────────────────────────
  //
  // Thin wrapper for EarthquakePulseTexture. Warm amber tint (0xdd7700) on the
  // SpriteMaterial — multiplied with canvas colors for additive blend coherence.
  // Exported via ArgusWeatherLayer so argusGdacs.js can create instances directly.

  // ── EarthquakeMarker (sprite wrapper) ─────────────────────────────────────────
  // Pool-based: all earthquake sprites of the same severity share one canvas texture.

  function EarthquakeMarker(scene, position, severity) {
    this._category = 'earthquake';
    this.severity  = severity || 'minor';
    this.material  = new THREE.SpriteMaterial({
      map: HazardTexturePool.get('earthquake', this.severity), transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
      color: 0xffffff,  // no tint: white seismic core renders as designed
    });
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.scale.setScalar(_HAZARD_SCALE[this.severity] || SCALE_PULSE);
    this.sprite.position.copy(position);
    scene.add(this.sprite);
    HazardTexturePool.register('earthquake', this.severity, this.sprite);
  }

  EarthquakeMarker.prototype.tick = function (dt) { /* no-op: HazardTexturePool.tick() drives this */ };

  EarthquakeMarker.prototype.setVisible = function (v) { this.sprite.visible = !!v; };

  EarthquakeMarker.prototype.dispose = function () {
    HazardTexturePool.unregister('earthquake', this.severity, this.sprite);
    HazardTexturePool.release('earthquake', this.severity);
    this.material.dispose();
    if (this.sprite.parent) this.sprite.parent.remove(this.sprite);
  };

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
    if (AG && AG.R && AG.R.MARKER) return AG.R.MARKER + 0.5;  // 101.5 — matches GDACS hazard sprite altitude
    return 101.5;
  }

  function _getScene() {
    var AG = window.ArgusGlobe;
    return AG ? AG.weatherSpriteGroup : null;
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
      link:          alert.url || '',
      countryCode:   null,
      // Fields used by showEventDetail NOAA card branch
      severity:      alert.severity  || null,
      _wSeverity:    alert._wSeverity || null,
      areaDesc:      alert.areaDesc  ? alert.areaDesc.slice(0, 80) : null,
      expires:       alert.expires   || null,
    };
  }

  function _addMarker(alert) {
    var scene = _getScene();
    if (!scene) return;

    var AG     = window.ArgusGlobe;
    if (!AG || !AG.latLonToVector) return;

    var mType  = alert._wMarkerType;
    var sev    = alert._wSeverity;
    var pos    = AG.latLonToVector(alert.lat, alert.lon, _altR);
    var marker;
    var ud     = _buildUserData(alert);

    // Stagger _tickCount by marker creation index so all markers don't redraw
    // on the same rAF frame. Without staggering, N markers with identical frame-skip
    // fire together → burst of N canvas draws + N GPU texture uploads per cycle.
    // Staggering distributes the cost across frameSkip consecutive frames.
    var _stagger = Object.keys(_markers).length;

    if (mType === 'cyclone') {
      marker = new CycloneMarker(scene, pos, sev);
      marker._tickCount = _stagger % marker._frameSkip;
      marker.group.userData    = ud;
      marker.armSprite.userData  = ud;
      marker.eyeSprite.userData  = ud;
      _spriteIndex.push({ obj: marker.armSprite,  id: alert.id });
      _spriteIndex.push({ obj: marker.eyeSprite,  id: alert.id });
    } else if (mType === 'flood') {
      marker = new FloodMarker(scene, pos, sev, false);  // NOAA flood: flat scale
      // No stagger: pool texture has its own _tickCount; stagger not applicable
      marker.sprite.userData = ud;
      _spriteIndex.push({ obj: marker.sprite, id: alert.id });
    } else {
      marker = new PulseMarker(scene, pos, sev);
      // No stagger: pool texture has its own _tickCount
      marker.sprite.userData = ud;
      _spriteIndex.push({ obj: marker.sprite, id: alert.id });
    }

    marker.setVisible(_enabled);
    _markers[alert.id] = { marker: marker, mType: mType, alert: alert, _seenAt: Date.now() };

    // Register sprites in window.weatherMarkers so the global click handler
    // and hover raycast can reach them. Replaces the internal hover-only path.
    var _wm = window.weatherMarkers;
    if (_wm) {
      if (mType === 'cyclone') {
        _wm.push(marker.armSprite);
        _wm.push(marker.eyeSprite);
      } else {
        _wm.push(marker.sprite);
      }
    }
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
    // Evict from global weatherMarkers by matching _weatherId on userData
    window.weatherMarkers = (window.weatherMarkers || []).filter(function(m) {
      return !(m.userData && m.userData._weatherId === id);
    });
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
  var _pollTimer  = null;
  var _pruneTimer = null;
  var _audit      = { polls: 0, errors: 0 };
  var _ctrl       = null;

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

    // Add new markers; refresh _seenAt for ones that are still present
    for (var newId in incomingIds) {
      if (_markers[newId]) {
        _markers[newId]._seenAt = now;  // storm still active — reset ghost clock
      } else {
        _alertCache[newId] = incomingIds[newId];
        _addMarker(incomingIds[newId]);
      }
    }
  }

  // ── Ghost-storm safety net ─────────────────────────────────────────────────────
  // Prunes any marker whose _seenAt is older than GHOST_MAX_AGE_MS.
  // Runs every GHOST_PRUNE_MS regardless of poll success/failure.
  // Provides a backstop when consecutive polls fail and _processAlerts never runs.
  // Does NOT fire during normal operation (active storms are refreshed each poll).
  function _pruneGhosts() {
    var cutoff = Date.now() - GHOST_MAX_AGE_MS;
    for (var id in _markers) {
      if ((_markers[id]._seenAt || 0) < cutoff) {
        console.warn('[ArgusWeatherLayer] ghost-prune: removing stale marker id=' + id +
          ' age=' + Math.round((Date.now() - (_markers[id]._seenAt || 0)) / 60000) + 'min');
        _removeMarker(id);
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
  // Last NDC coords that were raycasted — skip when mouse hasn't moved.
  var _lastHovNX  = null;
  var _lastHovNY  = null;

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

    // Skip raycast entirely when mouse hasn't moved since last check.
    // _removeMarker() sets _hoveredId=null when an active alert expires, so
    // tooltip teardown is handled by the data pipeline — not the hover poll.
    if (_mouseNX === _lastHovNX && _mouseNY === _lastHovNY) return;
    _lastHovNX = _mouseNX;
    _lastHovNY = _mouseNY;

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
        // Tooltip display delegated to global hover handler via window.weatherMarkers.
        // _showTooltip is intentionally not called here.
      }
    } else {
      if (_hoveredId !== null) {
        _hoveredId = null;
        // No _hideTooltip() call — global handler owns tooltip lifecycle.
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

    // CycloneMarker still uses per-instance textures — tick individually with LOD guard.
    // Pool-based markers (PulseMarker, FloodMarker) have no-op tick() calls here.
    for (var id in _markers) {
      var entry  = _markers[id];
      var marker = entry.marker;
      if (camPos && marker.group) {
        if (marker.group.position.distanceTo(camPos) > LOD_SKIP_DIST) continue;
      }
      marker.tick(dt);
    }

    // Central pool tick — redraws all shared hazard textures (NOAA + GDACS).
    // Max ~20 canvas redraws + GPU uploads per frame cycle regardless of event count.
    HazardTexturePool.tick(dt, camPos);

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
    _pollTimer  = setInterval(_poll, POLL_MS);
    _pruneTimer = setInterval(_pruneGhosts, GHOST_PRUNE_MS);
  }

  function stop() {
    if (_pollTimer)  { clearInterval(_pollTimer);  _pollTimer  = null; }
    if (_pruneTimer) { clearInterval(_pruneTimer); _pruneTimer = null; }
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
    tick:           tick,
    start:          start,
    stop:           stop,
    toggle:         toggle,
    setVisible:     setVisible,
    refresh:        refresh,
    status:         status,
    CycloneMarker:     CycloneMarker,
    DroughtMarker:     DroughtMarker,
    WildfireMarker:    WildfireMarker,
    FloodMarker:       FloodMarker,
    EarthquakeMarker:  EarthquakeMarker,
    HazardTexturePool: HazardTexturePool,
  };

}());
