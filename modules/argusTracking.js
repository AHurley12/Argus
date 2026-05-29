// modules/argusTracking.js
// Live tracking: Aircraft (OpenSky Network) + Ships (VesselAPI)
// Extracted from index.html SCRIPT 4. Zero logic changes.
// Dependencies (globals): window.THREE, window.ArgusGlobe, window.ArgusEntityRegistry
// Public API: window.ArgusTracking, window.ArgusTraffic

window.ArgusTracking = (function () {
'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
var AIRCRAFT_LIMIT = 750;   // Matches GLOBAL_CAP in fetch-traffic v4
var SHIP_LIMIT     = 500;   // Max ship markers (highest SOG first)
var AC_CACHE_MS    = 90 * 1000;        // 90 s — matches server 60 s TTL + propagation buffer
var SHIP_CACHE_MS  = 30 * 60 * 1000;  // 30 min — tanker at 20 knots barely moves in 30 min
var AC_CACHE_KEY   = 'argus_traffic_v4';
var AC_CACHE_TS    = 'argus_traffic_ts_v4';

// ── Jitter helper ─────────────────────────────────────────────────────────────
// Returns baseMs ± (fraction × baseMs) — spreads 100 simultaneous users across
// the full refresh window so they stop firing in a synchronized burst.
function _jitterMs(baseMs, fraction) {
  return Math.round(baseMs * (1 + fraction * (2 * Math.random() - 1)));
}

// Dead-reckoning state — keyed by ICAO24, used to extrapolate position between fetches
var _prevPositions = new Map(); // icao24 → { lat, lon, track, gs, seenAt }

// All aircraft data flows through the Netlify function — no direct external calls.
var TRAFFIC_FN = '/.netlify/functions/fetch-traffic';

// Ship backend — Netlify function proxies VesselAPI, applies 10% sampling, caches 30 min in Supabase
var VESSELS_FN = '/.netlify/functions/fetch-vessels';

// ── State ─────────────────────────────────────────────────────────────────────
var aircraftGroup  = null;   // THREE.Group for aircraft meshes
var corridorGroup  = null;   // THREE.Group for corridor flow-line indicators
var shipGroup      = null;   // THREE.Group for ship meshes
var aircraftOn    = false;
var shipsOn       = false;
var aircraftHits  = [];     // meshes registered in window.eventMarkers (for tooltips)
var shipHits      = [];
var shipBuffer    = [];     // accumulated vessel positions (array for rendering)
var vesselMap     = new Map(); // keyed by MMSI — spec-required Map for external access
var lastFetch     = 0;      // timestamp of last successful aircraft fetch
var cachedStates  = null;   // cached aircraft response
var _acFailedAt   = 0;      // timestamp of last all-sources failure (backoff marker)
var refreshTimer  = null;   // setInterval handle for aircraft auto-refresh
var shipRefreshTimer  = null; // setInterval handle for ship auto-refresh
var lastShipFetch = 0;      // timestamp of last successful ship fetch

// Expose spec-required window map immediately (array getters installed by ArgusEntityRegistry)
window._vesselMap = vesselMap;

// ── Ghost-sprite pools — eliminate allocation churn on refresh cycles ──────────
// Aircraft: up to 750 new SpriteMaterial + Sprite every 90s without pooling (~8/sec).
// Ships:    up to 500 new SpriteMaterial + Sprite every 30 min without pooling.
// Ghost sprites are pure JS objects (never added to any scene group). Their
// SpriteMaterial properties (color, opacity, rotation) are mutable — pool reuses
// them by overwriting in place, avoiding JS heap churn and GC spikes.
var _acSpritePool = [];   // available pooled aircraft sprites
var _shSpritePool = [];   // available pooled ship sprites
var AC_POOL_MAX   = 850;  // cap: slightly above AIRCRAFT_LIMIT to bound memory use
var SH_POOL_MAX   = 550;  // cap: slightly above SHIP_LIMIT

// Lifecycle audit counters — exposed via getLifecycleAudit()
var _lcAudit = { created: 0, reused: 0, staleEvictions: 0 };

// Acquire a sprite from the aircraft pool (or allocate new if pool is empty).
// Caller MUST reset material properties and userData before use.
function _acquireAcSprite() {
  if (_acSpritePool.length) { _lcAudit.reused++; return _acSpritePool.pop(); }
  _lcAudit.created++;
  // Material is minimal — texture tint + rotation set per-acquire, not in constructor
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: _acTex, transparent: true, depthTest: false }));
}

// Return all current aircraft ghost sprites to the pool for the next refresh cycle.
// Called at the start of renderAircraft() / aircraft toggle-off.
function _releaseAcSprites() {
  for (var i = 0; i < aircraftHits.length; i++) {
    if (_acSpritePool.length < AC_POOL_MAX) _acSpritePool.push(aircraftHits[i]);
    // else: pool is full — excess sprite is dropped and GC'd
  }
  aircraftHits.length = 0;
}

function _acquireShSprite() {
  if (_shSpritePool.length) { _lcAudit.reused++; return _shSpritePool.pop(); }
  _lcAudit.created++;
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: _shTex, transparent: true, depthTest: false }));
}

function _releaseShSprites() {
  for (var i = 0; i < shipHits.length; i++) {
    if (_shSpritePool.length < SH_POOL_MAX) _shSpritePool.push(shipHits[i]);
  }
  shipHits.length = 0;
}

// Shared geometries (created once, reused across all markers)
var _acTex, _shTex;
function ensureGeometries() {
  if (_acTex) return;

  // ── Aircraft sprite texture (top-down SVG plane shape) ──────────────────────
  (function () {
    var sz = 64, cx = 32, cy = 32, s = 1.5;
    var cv = document.createElement('canvas');
    cv.width = cv.height = sz;
    var c = cv.getContext('2d');

    // Fuselage
    c.beginPath(); c.ellipse(cx, cy, 4*s, 12*s, 0, 0, Math.PI*2);
    c.fillStyle = '#BAE6FD'; c.fill();

    // Wings
    var wg = c.createLinearGradient(cx, cy - 2*s, cx, cy + 2*s);
    wg.addColorStop(0, '#E0F2FE'); wg.addColorStop(1, '#7DD3FC');
    c.beginPath(); c.rect(cx - 16*s, cy - 2*s, 32*s, 4*s);
    c.fillStyle = wg; c.fill();

    // Nose
    c.beginPath(); c.moveTo(cx - 3*s, cy - 8*s); c.lineTo(cx, cy - 14*s); c.lineTo(cx + 3*s, cy - 8*s);
    c.closePath(); c.fillStyle = '#7DD3FC'; c.fill();

    // Tail fin
    c.beginPath(); c.ellipse(cx, cy + 8*s, 2*s, 3*s, 0, 0, Math.PI*2);
    c.fillStyle = '#F0F9FF'; c.globalAlpha = 0.8; c.fill(); c.globalAlpha = 1;

    _acTex = new THREE.CanvasTexture(cv);
    if (window.ArgusResourceTracker) window.ArgusResourceTracker.registerSharedTexture('aircraft_atlas', _acTex);
  }());

  // ── Ship sprite texture — bow-up hull shape (user SVG, scaled 2×) ───────────
  // Drawn in white so SpriteMaterial.color multiplies to produce vessel-type tint.
  // Bow points toward canvas top (north / 0°). SpriteMaterial.rotation then
  // rotates the sprite to match the vessel's COG heading at render time.
  //
  // Original SVG path (32×32):
  //   M16 1 C16 1 22 6 23 14 L23 26 Q23 31 16 31 Q9 31 9 26 L9 14 C10 6 16 1 16 1 Z
  (function () {
    var sz = 64;
    var cv = document.createElement('canvas');
    cv.width = cv.height = sz;
    var c = cv.getContext('2d');

    // Hull — SVG path scaled 2× (all coords × 2), bow at top
    c.beginPath();
    c.moveTo(32, 2);
    c.bezierCurveTo(32, 2, 44, 12, 46, 28);   // starboard bow curve
    c.lineTo(46, 52);                           // starboard side
    c.quadraticCurveTo(46, 62, 32, 62);        // starboard stern curve
    c.quadraticCurveTo(18, 62, 18, 52);        // port stern curve
    c.lineTo(18, 28);                           // port side
    c.bezierCurveTo(20, 12, 32, 2, 32, 2);    // port bow curve back to tip
    c.closePath();
    c.fillStyle = '#ffffff';
    c.fill();

    // Superstructure block (midship) — scaled 2×: x=26,y=30,w=12,h=14
    c.fillStyle = 'rgba(255,255,255,0.55)';
    c.fillRect(26, 30, 12, 14);

    // Center identification box — dark green, smaller than superstructure
    // Centered at (32,37): 6×8 px block sits over midship superstructure
    c.fillStyle = 'rgba(0, 150, 55, 0.90)';
    c.fillRect(29, 33, 6, 8);

    // Bow circle — scaled 2×: cx=32,cy=10,r=3
    // Provides a clear directional indicator at the pointed end
    c.fillStyle = 'rgba(255,255,255,0.88)';
    c.beginPath();
    c.arc(32, 10, 3, 0, Math.PI * 2);
    c.fill();

    _shTex = new THREE.CanvasTexture(cv);
    if (window.ArgusResourceTracker) window.ArgusResourceTracker.registerSharedTexture('ship_atlas', _shTex);
  }());
}

// ── Init — attach groups to eventMarkerGroup ──────────────────────────────────
function init() {
  var AG = window.ArgusGlobe;
  if (!AG || !AG.eventMarkerGroup || !AG.latLonToVector) return false;
  ensureGeometries();
  if (!aircraftGroup) {
    aircraftGroup          = new THREE.Group();
    aircraftGroup.name     = 'ArgusAircraft';
    aircraftGroup.visible  = false;
    AG.eventMarkerGroup.add(aircraftGroup);
    if (window.ArgusAircraftInstanced) window.ArgusAircraftInstanced.init(aircraftGroup, _acTex);
  }
  if (!corridorGroup) {
    corridorGroup         = new THREE.Group();
    corridorGroup.name    = 'ArgusCorridors';
    corridorGroup.visible = false;  // shown only when aircraft layer is on
    AG.eventMarkerGroup.add(corridorGroup);
  }
  if (!shipGroup) {
    shipGroup         = new THREE.Group();
    shipGroup.name    = 'ArgusShips';
    shipGroup.visible = false;
    AG.eventMarkerGroup.add(shipGroup);
    if (window.ArgusShipsInstanced) window.ArgusShipsInstanced.init(shipGroup, _shTex);
  }
  return true;
}

function ensureInit() {
  if (aircraftGroup && shipGroup) return true;
  return init();
}

// ── Clear a group and de-register its tooltip meshes ─────────────────────────
// Tracking markers are NOT in window.eventMarkers — no cross-array filter needed.
function clearGroup(group, hitsArr) {
  hitsArr.length = 0;
  // Snapshot children first — removes inside the loop would shift indices.
  // _keepAlive children (InstancedMeshes) are skipped so they survive the rebuild.
  var toRemove = group.children.slice();
  for (var i = 0; i < toRemove.length; i++) {
    var child = toRemove[i];
    if (child.userData && child.userData._keepAlive) continue;
    // Dispose material(s) — releases GPU shader program reference.
    // Do NOT dispose child.material.map (shared texture — owned by ensureGeometries).
    if (child.material) {
      if (Array.isArray(child.material)) {
        for (var mi = 0; mi < child.material.length; mi++) {
          if (child.material[mi].dispose) child.material[mi].dispose();
        }
      } else {
        if (child.material.dispose) child.material.dispose();
      }
    }
    // Sprites have no geometry (built-in quad) — guard avoids throw on undefined.
    if (child.geometry && child.geometry.dispose) child.geometry.dispose();
    group.remove(child);
  }
}

// ── Aircraft type → sprite tint (multiplied against white SVG texture) ────────
// commercial=white(default) · cargo=#4488ff(blue) · military=#ff4444(red) · unknown=white
var AC_TYPE_COLORS = { commercial: 0xffffff, cargo: 0x4488ff, military: 0xff4444, unknown: 0xffffff };

// ── Vessel type → sprite tint (multiplied against base ship texture) ──────────
// Mirrors AC_TYPE_COLORS pattern — single mapping table, no scattered logic.
var SHIP_TYPE_COLORS = {
  cargo:        0x4488ff,  // blue  — matches cargo flight tint
  tanker:       0xff9933,  // amber — high-value / high-risk
  military:     0xff4444,  // red   — matches military flight tint
  passenger:    0xffffff,  // white — civilian
  fishing:      0x44cc88,  // green
  tug:          0xffcc44,  // yellow
  port_service: 0xaaaaaa,  // grey
  recreational: 0xcc88ff,  // violet
  other:        0x14b8a6,  // default teal (original ship colour)
  unknown:      0x888888   // mid-grey
};

// ── Aircraft marker — oriented by heading, tinted by flight type ──────────────
// stale=true → dead-reckoned or carry-forward position; rendered at reduced opacity
function placeAircraft(lat, lon, heading, callsign, country, flightType, alt, region, icao24, gs, phase, stale) {
  var AG         = window.ArgusGlobe;
  var pos        = AG.latLonToVector(lat, lon, 101.8);
  var ft         = flightType || 'unknown';
  var acColorHex = AC_TYPE_COLORS[ft] !== undefined ? AC_TYPE_COLORS[ft] : 0xffffff;

  // Pool reuse: acquire sprite + update mutable material properties in place.
  // Avoids new SpriteMaterial + new Sprite allocation on every 90s refresh cycle.
  var sprite = _acquireAcSprite();
  var mat    = sprite.material;
  mat.color.setHex(acColorHex);
  mat.opacity  = stale ? 0.45 : 0.92;  // dimmed for carry-forward / dead-reckoned
  mat.rotation = (heading != null && !isNaN(heading)) ? -heading * Math.PI / 180 : 0;
  // mat.map = _acTex is already set at pool-create time; never changes

  sprite.position.copy(pos);
  sprite.scale.set(1.75, 1.75, 1);
  // Detached from scene — InstancedMesh renders visually.
  // updateWorldMatrix ensures matrixWorld is valid for raycaster.intersectObjects().
  sprite.updateWorldMatrix(false, false);

  var cs = (callsign || '').trim() || '???';
  sprite.userData = {
    isAircraft:  true,
    title:       cs + (country ? ' · ' + country : '') + (stale ? ' [DR]' : ''),
    type:        'AIRCRAFT',
    flightType:  ft,
    severity:    'LOW',
    lat:         lat,
    lon:         lon,
    heading:     (heading != null && !isNaN(heading)) ? Math.round(heading) : null,
    alt:         (alt != null && !isNaN(alt))         ? Math.round(alt)     : null,
    gs:          (gs  != null && !isNaN(gs))          ? Math.round(gs)      : null,
    phase:       phase  || null,
    icao24:      icao24 || null,
    region:      region || null,
    stale:       !!stale,
  };
  // NOT added to aircraftGroup — proxy for raycasting/ArgusSelection only.
  aircraftHits.push(sprite);
  if (window.ArgusEntityRegistry) window.ArgusEntityRegistry.register(icao24 || (lat + ',' + lon), 'aircraft', sprite, sprite.userData);
  if (window.ArgusAircraftInstanced) window.ArgusAircraftInstanced.upsert(lat, lon, heading, acColorHex, !!stale, sprite);
}

// ── Ship marker — top-down SVG ship sprite ────────────────────────────────────
function placeShip(lat, lon, name, sog, cog, typeCategory, mmsi, region, navStatus, destination) {
  var AG  = window.ArgusGlobe;
  var pos = AG.latLonToVector(lat, lon, 101.5);
  var tc  = typeCategory || 'other';

  // Rotate sprite so bow points in the vessel's COG direction.
  // COG 0° = north (bow up in texture) → rotation 0.
  // COG 90° = east → rotation -π/2 (clockwise in screen space).
  // Matches the aircraft heading convention: rotation = -degrees × π/180.
  // If no COG data, sprite stays bow-up (0 rad) — better than a random orientation.
  var cogRad = (cog != null && !isNaN(cog)) ? -cog * Math.PI / 180 : 0;

  // Pool reuse: same pattern as placeAircraft — update mutable properties in place.
  var sprite = _acquireShSprite();
  var mat    = sprite.material;
  mat.color.setHex(SHIP_TYPE_COLORS[tc] !== undefined ? SHIP_TYPE_COLORS[tc] : SHIP_TYPE_COLORS.other);
  mat.opacity  = 0.92;
  mat.rotation = cogRad;
  // mat.map = _shTex is already set at pool-create time; never changes

  sprite.position.copy(pos);
  sprite.scale.set(0.89, 0.89, 1);
  // Detached from scene — InstancedMesh renders visually.
  // updateWorldMatrix ensures matrixWorld is valid for raycaster.intersectObjects().
  sprite.updateWorldMatrix(false, false);

  var label = (name || '').trim() || 'VESSEL';
  sprite.userData = {
    isShip:       true,
    title:        label,
    type:         'VESSEL',
    typeCategory: tc,
    severity:     'LOW',
    lat:          lat,
    lon:          lon,
    velocity:     sog != null ? sog : null,
    heading:      cog != null ? cog : null,
    mmsi:         mmsi        || null,
    region:       region      || null,
    navStatus:    navStatus   != null ? navStatus : null,
    destination:  destination || null
  };
  // NOT added to shipGroup — InstancedMesh renders visually; sprite is a ghost
  // proxy for raycasting and ArgusSelection only (mirrors aircraft/AIS pattern).
  shipHits.push(sprite);
  if (window.ArgusEntityRegistry) window.ArgusEntityRegistry.register(mmsi || (lat + ',' + lon), 'ship', sprite, sprite.userData);
  if (window.ArgusShipsInstanced) {
    var shipColorHex = SHIP_TYPE_COLORS[tc] !== undefined ? SHIP_TYPE_COLORS[tc] : SHIP_TYPE_COLORS.other;
    window.ArgusShipsInstanced.upsert(lat, lon, cog, shipColorHex, sprite);
  }
  // Tracking markers are managed via shipHits (pool) and ArgusEntityRegistry ('ship' type).
  // They are NOT pushed to window.eventMarkers to keep the event system clean.
}

// ── Normalized tracking model ─────────────────────────────────────────────────
// Produces window._trackingData: [{id, type, lat, lon, velocity, heading, timestamp}]
// This is the canonical shape for ALL downstream tracking consumers.
function normalizeTracking() {
  var ts = Date.now();
  var aircraft = aircraftHits.map(function(s, i) {
    var ud = s.userData;
    return {
      id:         'ac-' + i,
      type:       'aircraft',
      flightType: ud.flightType || 'unknown',
      lat:        ud.lat,
      lon:        ud.lon,
      velocity:   null,
      heading:    ud.heading,
      label:      ud.title,
      timestamp:  ts
    };
  });
  var vessels = shipHits.map(function(s, i) {
    var ud = s.userData;
    return {
      id:           'vs-' + i,
      type:         'vessel',
      typeCategory: ud.typeCategory || 'other',
      lat:          ud.lat,
      lon:          ud.lon,
      velocity:     ud.velocity,
      heading:      ud.heading,
      label:        ud.title,
      timestamp:    ts
    };
  });
  window._trackingData = aircraft.concat(vessels);
}

// ── Aircraft fetch — Netlify function (primary) → community fallbacks ─────────
function fetchAndRenderAircraft() {
  // Back off 5 min after complete waterfall failure
  var _AC_BACKOFF_MS = 5 * 60 * 1000;
  if (_acFailedAt && (Date.now() - _acFailedAt) < _AC_BACKOFF_MS) return;

  // In-memory cache
  if (cachedStates && (Date.now() - lastFetch) < AC_CACHE_MS) {
    renderAircraft(cachedStates);
    return;
  }
  // localStorage cache (survives reload)
  try {
    var _lsTs  = parseInt(localStorage.getItem(AC_CACHE_TS) || '0');
    var _lsRaw = localStorage.getItem(AC_CACHE_KEY);
    if (_lsRaw && (Date.now() - _lsTs) < AC_CACHE_MS) {
      cachedStates = JSON.parse(_lsRaw);
      lastFetch    = _lsTs;
      renderAircraft(cachedStates);
      return;
    }
  } catch (_) {}

  window._argusReqCache.fetch(TRAFFIC_FN)
    .then(function (json) {
      lastFetch   = Date.now();
      _acFailedAt = 0;
      cachedStates = json;
      // Defer the ~75 KB serialization off the current call stack so it
      // doesn't block renderAircraft (both keys written in the same task).
      window._lsWrite(AC_CACHE_KEY, json);
      window._lsWrite(AC_CACHE_TS,  String(lastFetch));
      var _acT0 = performance.now();
      renderAircraft(json);
      if (window.ArgusPerf) ArgusPerf.record('AIRCRAFT_RENDER', performance.now() - _acT0, 200);
    })
    .catch(function (err) {
      console.warn('[ArgusTracking] fetch-traffic failed:', err, '— backing off 5 min');
      updateStatus('AIRCRAFT: UNAVAILABLE');
      _acFailedAt = Date.now();
    });
}

// ── Corridor flow-line renderer ───────────────────────────────────────────────
// Draws short heading-direction line segments at each corridor centroid on the
// globe surface. Length and opacity scale with aircraft count in the corridor.
function renderCorridors(corridors) {
  if (!corridorGroup) return;
  // Dispose geometry + material before removing — prevents WebGL resource leak on each 90s rebuild.
  // (BufferGeometry creates a VBO; LineBasicMaterial registers a shader program reference.
  //  Without explicit dispose(), these accumulate in the GPU driver until renderer.dispose().)
  var _cOld = corridorGroup.children.slice();
  for (var _ci = 0; _ci < _cOld.length; _ci++) {
    var _cl = _cOld[_ci];
    if (_cl.geometry) _cl.geometry.dispose();
    if (_cl.material) _cl.material.dispose();
    corridorGroup.remove(_cl);
  }
  if (!corridors || !corridors.length) return;

  var AG  = window.ArgusGlobe;
  var RAD = Math.PI / 180;

  corridors.forEach(function(c) {
    // Half-length of the corridor indicator in degrees (1.5° – 4°, scales with count)
    var halfLen = Math.min(4, 1.5 + c.count * 0.05);
    var hRad    = c.heading * RAD;
    var cosLat  = Math.max(0.05, Math.cos(c.lat * RAD));
    var dLat    = halfLen * Math.cos(hRad);
    var dLon    = halfLen * Math.sin(hRad) / cosLat;

    var p1 = AG.latLonToVector(c.lat - dLat, c.lon - dLon, 101.9);
    var p2 = AG.latLonToVector(c.lat + dLat, c.lon + dLon, 101.9);

    var opacity = Math.min(0.72, 0.22 + c.count * 0.04);
    var line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([p1, p2]),
      new THREE.LineBasicMaterial({ color: 0x00aaff, transparent: true, opacity: opacity, depthTest: false })
    );
    corridorGroup.add(line);
  });
}

function renderAircraft(json) {
  if (!aircraftGroup) return;
  if (window.ArgusAircraftInstanced) window.ArgusAircraftInstanced.clear();
  _releaseAcSprites();              // return ghost sprites to pool before rebuild
  if (window.ArgusEntityRegistry) window.ArgusEntityRegistry.clearType('aircraft');
  clearGroup(aircraftGroup, aircraftHits);  // handles _keepAlive InstancedMesh skip; no-op for sprites
  if (!json) { updateStatus(); return; }

  // v4 schema: { aircraft, corridors, activeCells, staleCells, ... }
  var states    = Array.isArray(json.aircraft)  ? json.aircraft  : [];
  var corridors = Array.isArray(json.corridors) ? json.corridors : [];

  if (!states.length) { updateStatus(); return; }

  // Build a Set of ICAO24s in this snapshot for dead-reckoning gap fill
  var nowMs      = Date.now();
  var currentIds = new Set();
  states.forEach(function(s) { if (s.icao24) currentIds.add(s.icao24); });

  // Publish primary ICAO24 set for ArgusProviderCache staleness checks.
  // ArgusProviderCache reads this to determine which ICAO24s need fallback coverage.
  if (window._argusCurrentIcao24s) {
    window._argusCurrentIcao24s.clear();
    currentIds.forEach(function(id) { window._argusCurrentIcao24s.add(id); });
  }

  // Merge OpenSky fallback aircraft — additive only, no primary override.
  // Entries whose ICAO24 is already in the primary snapshot are skipped.
  var _provBuf = window._argusProviderAircraft;
  if (_provBuf && _provBuf.size && states.length < AIRCRAFT_LIMIT) {
    _provBuf.forEach(function(ac, icao24) {
      if (currentIds.has(icao24)) return;  // primary has this — skip
      if (states.length >= AIRCRAFT_LIMIT) return;
      states.push(ac);
      currentIds.add(icao24);
    });
  }

  // Dead-reckon aircraft from previous snapshot absent in current
  // Uses heading + ground speed to extrapolate position over elapsed time
  _prevPositions.forEach(function(prev, icao24) {
    if (currentIds.has(icao24)) return;                          // present — no DR needed
    var age = nowMs - prev.seenAt;
    if (age > AC_CACHE_MS * 2) { _lcAudit.staleEvictions++; return; }  // too old — drop
    if (prev.track == null || prev.gs == null || prev.gs < 50) return; // no vector — skip
    var dtHours = age / 3600000;
    var distNm  = prev.gs * dtHours;
    var RAD     = Math.PI / 180;
    var dLat    = distNm * Math.cos(prev.track * RAD) / 60;
    var dLon    = distNm * Math.sin(prev.track * RAD) / (60 * Math.max(0.05, Math.cos(prev.lat * RAD)));
    var drLat   = prev.lat + dLat;
    var drLon   = prev.lon + dLon;
    if (drLat < -90 || drLat > 90) return;
    placeAircraft(drLat, drLon, prev.track, prev.cs, null, prev.flightType, prev.alt, prev.region, icao24, prev.gs, prev.phase, true);
  });

  // Render current snapshot aircraft — no systematic step-skip
  // Server already grid-stratified to AIRCRAFT_LIMIT; render all directly
  states.forEach(function(s) {
    if (aircraftHits.length >= AIRCRAFT_LIMIT) return;
    placeAircraft(s.lat, s.lon, s.track, s.cs, s.country, s.flightType || 'unknown',
                  s.alt, s.region, s.icao24, s.gs, s.phase, !!s.stale);
  });



  // Update dead-reckoning store with current snapshot
  _prevPositions.clear();
  states.forEach(function(s) {
    if (!s.icao24 || s.stale) return;
    _prevPositions.set(s.icao24, {
      lat: s.lat, lon: s.lon, track: s.track, gs: s.gs,
      alt: s.alt, cs: s.cs, flightType: s.flightType, phase: s.phase,
      region: s.region, seenAt: nowMs,
    });
  });

  // Render corridor flow indicators (visible while aircraft layer is on)
  if (corridorGroup) {
    renderCorridors(corridors);
    corridorGroup.visible = aircraftOn;
  }

  if (window.requestIdleCallback) {
    requestIdleCallback(normalizeTracking, { timeout: 5000 });
    if (window.ArgusSchedulerAudit) window.ArgusSchedulerAudit.deferredTasks++;
  } else {
    setTimeout(normalizeTracking, 0);
  }
  updateStatus();
}

// ── Ship backend fetch — calls Netlify function (VesselAPI, Supabase-cached) ──
function fetchShipsFromBackend() {
  // Honour 30-min cache on the frontend too (server already caches, but avoids redundant calls)
  if (Date.now() - lastShipFetch < SHIP_CACHE_MS) {
    if (shipsOn && shipGroup && shipBuffer.length) renderShips();
    return;
  }

  window._argusReqCache.fetch(VESSELS_FN)
    .then(function (json) {
      if (!json || !Array.isArray(json.vessels)) {
        console.warn('[ArgusTracking] fetch-vessels: unexpected response shape —', JSON.stringify(json).slice(0, 200));
        updateStatus('SHIPS: UNAVAILABLE');
        return;
      }
      console.log('[ArgusTracking] fetch-vessels: received', json.vessels.length, 'vessels | source:', json.source, '| regions:', JSON.stringify(json.regions));
      if (json.vessels.length === 0) {
        console.warn('[ArgusTracking] fetch-vessels: 0 vessels in response — check Netlify function logs');
        updateStatus('SHIPS: 0 VESSELS');
        return;
      }
      lastShipFetch = Date.now();
      shipBuffer    = [];
      vesselMap     = new Map();

      json.vessels.forEach(function (v) {
        if (v.lat == null || v.lon == null) return;
        if (v.mmsi) {
          vesselMap.set(v.mmsi, { lat: v.lat, lon: v.lon, sog: v.sog, cog: v.cog, shipName: v.name });
        }
        shipBuffer.push({
          lat:          v.lat,
          lon:          v.lon,
          name:         v.name || 'VESSEL',
          sog:          v.sog,
          cog:          v.cog         || null,
          typeCategory: v.typeCategory || 'unknown',
          mmsi:         v.mmsi        || null,
          region:       v.region      || null,
          navStatus:    v.navStatus   != null ? v.navStatus : null,
          destination:  v.destination || null
        });
      });

      window._vesselMap = vesselMap;
      if (shipsOn && shipGroup) renderShips();
    })
    .catch(function (err) {
      console.warn('[ArgusTracking] fetch-vessels failed:', err);
      updateStatus('SHIPS: UNAVAILABLE');
    });
}

function stopShips() {
  if (shipRefreshTimer) { clearTimeout(shipRefreshTimer); shipRefreshTimer = null; }
  _releaseShSprites();  // return ghost sprites to pool before clearing buffer
  if (window.ArgusEntityRegistry) window.ArgusEntityRegistry.clearType('ship');
  shipBuffer    = [];
  lastShipFetch = 0;
  vesselMap     = new Map();
  window._vesselMap = vesselMap;
}

function renderShips() {
  if (!shipGroup) return;
  if (window.ArgusShipsInstanced) window.ArgusShipsInstanced.clear();
  _releaseShSprites();              // return ghost sprites to pool before rebuild
  if (window.ArgusEntityRegistry) window.ArgusEntityRegistry.clearType('ship');
  clearGroup(shipGroup, shipHits);  // handles _keepAlive InstancedMesh skip; no-op for sprites
  // Spec: limit to SHIP_LIMIT, highest SOG first (moving ships take priority)
  var sorted = shipBuffer.slice().sort(function (a, b) { return (b.sog || 0) - (a.sog || 0); });
  sorted.slice(0, SHIP_LIMIT).forEach(function (s) {
    placeShip(s.lat, s.lon, s.name, s.sog, s.cog, s.typeCategory, s.mmsi, s.region, s.navStatus, s.destination);
  });
  if (window.requestIdleCallback) {
    requestIdleCallback(normalizeTracking, { timeout: 5000 });
    if (window.ArgusSchedulerAudit) window.ArgusSchedulerAudit.deferredTasks++;
  } else {
    setTimeout(normalizeTracking, 0);
  }
  updateStatus();
}

// ── Toggle functions (public) ─────────────────────────────────────────────────
function toggleAircraft() {
  if (!ensureInit()) {
    console.warn('[ArgusTracking] Globe not ready yet');
    return;
  }
  aircraftOn             = !aircraftOn;
  aircraftGroup.visible  = aircraftOn;
  if (corridorGroup) corridorGroup.visible = aircraftOn;
  window.ArgusLayerState.aircraft = aircraftOn;
  if (!aircraftOn && window.ArgusGlobe && window.ArgusGlobe.clearHover) window.ArgusGlobe.clearHover();

  if (aircraftOn) {
    fetchAndRenderAircraft();
    // Auto-refresh with jittered interval — prevents 100 users from firing in sync
    if (!refreshTimer) {
      (function schedAcActive() {
        refreshTimer = setTimeout(function () {
          if (aircraftOn && !document.hidden) { lastFetch = 0; fetchAndRenderAircraft(); }
          if (aircraftOn) schedAcActive();
        }, _jitterMs(AC_CACHE_MS, 0.25)); // 90s ± 22.5s
      }());
    }
  } else {
    if (window.ArgusAircraftInstanced) window.ArgusAircraftInstanced.clear();
    _releaseAcSprites();
    if (window.ArgusEntityRegistry) window.ArgusEntityRegistry.clearType('aircraft');
    clearGroup(aircraftGroup, aircraftHits);
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  }

  setActive('btn-track-aircraft', aircraftOn);
  updateStatus();
}

function toggleShips() {
  if (!ensureInit()) {
    console.warn('[ArgusTracking] Globe not ready yet');
    return;
  }
  shipsOn            = !shipsOn;
  shipGroup.visible  = shipsOn;
  window.ArgusLayerState.vessels = shipsOn;
  if (!shipsOn && window.ArgusGlobe && window.ArgusGlobe.clearHover) window.ArgusGlobe.clearHover();

  if (shipsOn) {
    fetchShipsFromBackend();
    if (!shipRefreshTimer) {
      (function schedShActive() {
        shipRefreshTimer = setTimeout(function () {
          if (shipsOn && !document.hidden) { lastShipFetch = 0; fetchShipsFromBackend(); }
          if (shipsOn) schedShActive();
        }, _jitterMs(SHIP_CACHE_MS, 0.20)); // 30min ± 6min
      }());
    }
  } else {
    stopShips();
    if (window.ArgusShipsInstanced) window.ArgusShipsInstanced.clear();
    clearGroup(shipGroup, shipHits);
  }

  setActive('btn-track-ships', shipsOn);
  updateStatus();
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function setActive(id, on) {
  var el = document.getElementById(id);
  if (!el) return;
  if (on) el.classList.add('is-active');
  else    el.classList.remove('is-active');
}

function updateStatus(msg) {
  var el = document.getElementById('tracking-status');
  if (!el) return;
  if (msg) { el.textContent = msg; return; }
  var parts = [];
  if (aircraftOn) parts.push(aircraftHits.length + ' AC');
  if (shipsOn) parts.push(shipHits.length + ' VES');
  el.textContent = parts.join(' · ');
}

// ── Keyboard shortcuts (A = aircraft, S = ships) ──────────────────────────────
window.addEventListener('keydown', function (e) {
  var tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (document.activeElement && document.activeElement.isContentEditable) return;
  if (document.querySelector('#analyst-modal-overlay.is-open')) return;
  if (document.querySelector('#es-modal-overlay.is-open')) return;
  if (document.querySelector('#panel-ai.is-open')) return;
  var k = e.key.toLowerCase();
  if (k === 'a' || k === 'f') toggleAircraft(); // A or F — FLIGHTS
  if (k === 's' || k === 'h') toggleShips();    // S or H — SHIPS
});

// ── Bootstrap — poll until ArgusGlobe is ready, then pre-warm aircraft cache ──
(function bootstrap() {
  var attempts  = 0;
  var prefetched = false;
  var timer = setInterval(function () {
    if (init()) {
      clearInterval(timer);
      // Spec: auto-fetch aircraft on load (stays invisible until user toggles A/F)
      if (!prefetched) {
        prefetched = true;
        fetchAndRenderAircraft();                        // prime the cache
        // Jittered cache-warming loop — runs regardless of aircraftOn toggle state
        (function schedAcWarm() {
          refreshTimer = setTimeout(function () {
            if (!document.hidden) { lastFetch = 0; fetchAndRenderAircraft(); }
            schedAcWarm();
          }, _jitterMs(AC_CACHE_MS, 0.25)); // 90s ± 22.5s
        }());
      }
    } else if (++attempts > 60) {
      clearInterval(timer);
    }
  }, 200);
}());

// ── Filter utility ────────────────────────────────────────────────────────────
// filterByType(data, type) — works on window._trackingData or any mixed array.
// type examples: 'commercial', 'cargo', 'military', 'unknown', 'tanker', 'passenger', 'fishing', 'other'
function filterByType(data, type) {
  return (data || []).filter(function(item) {
    return item.flightType === type || item.typeCategory === type;
  });
}

// ── Public API ────────────────────────────────────────────────────────────────
return {
  toggleAircraft:      toggleAircraft,
  toggleShips:         toggleShips,
  refreshAircraft:     function () { lastFetch = 0; fetchAndRenderAircraft(); },
  refreshShips:        function () { lastShipFetch = 0; fetchShipsFromBackend(); },
  filterByType:        filterByType,
  getLifecycleAudit:   function () {
    return {
      created:        _lcAudit.created,
      reused:         _lcAudit.reused,
      staleEvictions: _lcAudit.staleEvictions,
      acPoolSize:     _acSpritePool.length,
      shPoolSize:     _shSpritePool.length,
    };
  },
};

}());
// Spec alias — HTML buttons already use ArgusTracking; ArgusTraffic exposed for console access
window.ArgusTraffic = window.ArgusTracking;

// ── _argusShTex shim ─────────────────────────────────────────────────────────
// Exposes ship texture on window._argusShTex for ArgusAIS after ArgusTracking
// initialises. Moved here (end of argusTracking.js) to keep it co-located
// with the texture it patches.
(function patchShTex() {
  // Poll until ArgusTracking has initialised the globe groups (which triggers
  // ensureGeometries internally).  Once _shTex is set on the closure we can
  // only reach it via the sprite materials already created.  Instead we re-run
  // ensureGeometries via a benign toggle probe, then read _shTex from an
  // existing ship sprite if one is present — OR we rebuild the texture here
  // with the identical canvas code so ArgusAIS is fully self-contained.
  var attempts = 0;
  var timer = setInterval(function () {
    attempts++;
    if (window._argusShTex) { clearInterval(timer); return; }

    // Attempt to read the texture from an already-placed VesselAPI ship sprite
    var hits = window._vesselMarkers;
    if (hits && hits.length > 0) {
      var tex = hits[0].material && hits[0].material.map;
      if (tex) {
        window._argusShTex = tex;
        clearInterval(timer);
        return;
      }
    }

    // Fallback: rebuild the identical ship canvas texture so ArgusAIS can
    // start without waiting for the first VesselAPI fetch.
    if (attempts > 10 && typeof THREE !== 'undefined') {
      (function () {
        var sz = 64;
        var cv = document.createElement('canvas');
        cv.width = cv.height = sz;
        var c = cv.getContext('2d');
        c.beginPath();
        c.moveTo(32, 2);
        c.bezierCurveTo(32, 2, 44, 12, 46, 28);
        c.lineTo(46, 52);
        c.quadraticCurveTo(46, 62, 32, 62);
        c.quadraticCurveTo(18, 62, 18, 52);
        c.lineTo(18, 28);
        c.bezierCurveTo(20, 12, 32, 2, 32, 2);
        c.closePath();
        c.fillStyle = '#ffffff';
        c.fill();
        c.fillStyle = 'rgba(255,255,255,0.55)';
        c.fillRect(26, 30, 12, 14);
        c.fillStyle = 'rgba(0, 150, 55, 0.90)';
        c.fillRect(29, 33, 6, 8);
        c.fillStyle = 'rgba(255,255,255,0.88)';
        c.beginPath();
        c.arc(32, 10, 3, 0, Math.PI * 2);
        c.fill();
        window._argusShTex = new THREE.CanvasTexture(cv);
      }());
      clearInterval(timer);
    }

    if (attempts > 300) clearInterval(timer); // 60 s hard stop
  }, 200);
  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusTracking');
}());
