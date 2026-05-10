'use strict';
// core/globe/instancedShips.js
// VesselAPI Ship Instanced Rendering — replaces 0-500 individual Sprite draw calls with ONE.
//
// Architecture mirrors instancedAircraft.js exactly:
//   argusTracking.js keeps its full interaction surface (ghost sprites → shipHits,
//   hover, click, tooltips, ArgusSelection all unchanged).
//   This module owns ONLY the visual rendering layer.
//
// Single InstancedMesh (no opacity split — all VesselAPI ships at opacity 0.92).
// Ghost sprites are never added to the scene; they carry userData + position for
// raycasters and ArgusSelection without contributing render overhead.
//
// Lifecycle (full rebuild every 30 min):
//   renderShips() → ArgusShipsInstanced.clear()  → reset mesh count to 0
//   placeShip()   → ArgusShipsInstanced.upsert() → sequential slot allocation
//   No free-pool needed — full clear eliminates eviction complexity.
//
// Dim/scale sync (ArgusSelection drives ghost sprites):
//   100ms setInterval reads sprite.material.opacity and sprite.scale,
//   mirrors changes to instanceColor and instanceMatrix.
//   No parent-null guard needed (ghost sprites are never in the scene).
//
// Dependencies: window.THREE, window.ArgusGlobe
// Public API:   window.ArgusShipsInstanced

window.ArgusShipsInstanced = (function () {
  'use strict';

  var MAX      = 520;    // > SHIP_LIMIT(500) with small headroom
  var SCALE_SH = 0.89;   // matches placeShip sprite.scale.set(0.89, 0.89, 1)
  var ALTITUDE = 101.5;  // matches R.SHIP in globe init

  // ── Pre-allocated scratch objects — no per-call GC pressure ──────────────────
  var _dummy  = new THREE.Object3D();
  var _vecZ   = new THREE.Vector3(0, 0, 1);  // PlaneGeometry default normal
  var _normal = new THREE.Vector3();
  var _hQuat  = new THREE.Quaternion();
  var _nQuat  = new THREE.Quaternion();
  var _tmpCol = new THREE.Color();

  // ── State ─────────────────────────────────────────────────────────────────────
  var _mesh  = null;
  var _ready = false;

  // Sequential counter — reset on each clear() call (no free-pool needed)
  var _idx = 0;

  // Sprite sync array — rebuilt each clear() / upsert() cycle.
  // Entry: { sprite, idx, lat, lon, heading, baseR, baseG, baseB }
  var _sprites = [];

  // Base RGB per slot — used for dim/restore without re-querying hex color
  var _baseRGB = new Float32Array(MAX * 3);

  var _syncTimer = null;  // 100ms dim/scale sync interval handle

  // ── Helpers ───────────────────────────────────────────────────────────────────

  // Surface-normal billboard matrix — identical math to instancedAIS.js / instancedAircraft.js.
  // PlaneGeometry lies in XY; +Z aligns to outward globe normal; heading rotates around it.
  function _buildMatrix(lat, lon, heading, scale) {
    var AG = window.ArgusGlobe;
    if (!AG) return false;
    var pos = AG.latLonToVector(lat, lon, ALTITUDE);
    _normal.copy(pos).normalize();
    _nQuat.setFromUnitVectors(_vecZ, _normal);
    if (heading != null && !isNaN(heading)) {
      _hQuat.setFromAxisAngle(_normal, -heading * Math.PI / 180);
      _nQuat.premultiply(_hQuat);
    }
    _dummy.position.copy(pos);
    _dummy.setRotationFromQuaternion(_nQuat);
    _dummy.scale.set(scale, scale, 1);
    _dummy.updateMatrix();
    return true;
  }

  // Write RGB to instanceColor buffer (caller sets needsUpdate).
  function _writeColor(idx, r, g, b) {
    var off = idx * 3;
    _mesh.instanceColor.array[off]     = r;
    _mesh.instanceColor.array[off + 1] = g;
    _mesh.instanceColor.array[off + 2] = b;
  }

  // ── Init ──────────────────────────────────────────────────────────────────────
  function init(shipGroup, shTex) {
    if (_ready) return true;
    if (!shTex || !shipGroup) return false;

    // 1×1 plane — matrix scale drives world-space size (SCALE_SH = 0.89 world units)
    var geo = new THREE.PlaneGeometry(1, 1);

    var mat = new THREE.MeshBasicMaterial({
      map:        shTex,
      transparent: true,
      opacity:    0.92,
      depthTest:  false,
      depthWrite: false,
      side:       THREE.DoubleSide,
    });

    _mesh = new THREE.InstancedMesh(geo, mat, MAX);
    _mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    _mesh.name          = 'ArgusShipsInstanced';
    _mesh.frustumCulled = false;  // globe rotates — instanced bounding box unreliable
    _mesh.renderOrder   = 1;      // render above globe surface
    _mesh.count         = 0;
    _mesh.userData._keepAlive = true;  // clearGroup() must not remove this

    // Init instanceColor to white — type tint applied per upsert()
    var colors = new Float32Array(MAX * 3);
    for (var i = 0; i < MAX * 3; i++) colors[i] = 1.0;
    _mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);

    // All slots start at scale=0 — unused slots never render as stray quads
    _dummy.scale.set(0, 0, 0);
    _dummy.position.set(0, 0, 0);
    _dummy.rotation.set(0, 0, 0);
    _dummy.updateMatrix();
    for (var j = 0; j < MAX; j++) {
      _mesh.setMatrixAt(j, _dummy.matrix);
      _baseRGB[j * 3] = _baseRGB[j * 3 + 1] = _baseRGB[j * 3 + 2] = 1.0;
    }
    _mesh.instanceMatrix.needsUpdate = true;

    shipGroup.add(_mesh);
    _ready = true;

    // 100ms dim/scale sync — mirrors selection state from ghost sprites to InstancedMesh
    _syncTimer = setInterval(_syncFromSprites, 100);

    console.log('[ArgusShipsInstanced] ready — capacity:', MAX);
    return true;
  }

  // ── clear — called at top of each renderShips() (every ~30 min) ───────────────
  // Resets sequential counter and sprite sync array. Sets count=0 so no instances
  // render until the new batch of upsert() calls completes.
  function clear() {
    if (!_ready) return;
    _idx     = 0;
    _sprites = [];
    _mesh.count = 0;
    // Slots beyond count are not rendered — no explicit zeroing needed.
  }

  // ── upsert — allocate next sequential slot, set matrix + color ───────────────
  // Called once per ship per renderShips() cycle.
  function upsert(lat, lon, heading, colorHex, sprite) {
    if (!_ready) return;
    var idx = _idx++;
    if (idx >= MAX) return;  // at cap

    if (_buildMatrix(lat, lon, heading, SCALE_SH)) {
      _mesh.setMatrixAt(idx, _dummy.matrix);
      _mesh.instanceMatrix.needsUpdate = true;
    }

    _tmpCol.setHex(colorHex);
    var off = idx * 3;
    _baseRGB[off]     = _tmpCol.r;
    _baseRGB[off + 1] = _tmpCol.g;
    _baseRGB[off + 2] = _tmpCol.b;
    _writeColor(idx, _tmpCol.r, _tmpCol.g, _tmpCol.b);
    _mesh.instanceColor.needsUpdate = true;

    if (idx + 1 > _mesh.count) _mesh.count = idx + 1;

    // Record sprite reference for the 100ms dim/scale poller.
    // Ghost sprites have no parent (never added to scene) — no parent guard needed.
    _sprites.push({
      sprite:  sprite,
      idx:     idx,
      lat:     lat,
      lon:     lon,
      heading: heading,
      baseR:   _tmpCol.r,
      baseG:   _tmpCol.g,
      baseB:   _tmpCol.b,
    });
  }

  // ── 100ms dim/scale sync ─────────────────────────────────────────────────────
  // ArgusSelection modifies ghost sprite opacity (dim) and scale (highlight).
  // This poller mirrors those changes to the InstancedMesh so the visual matches.
  // Ghost sprites have no parent (not in scene) — skip the parent-null guard used
  // in instancedAircraft.js; check material existence directly instead.
  function _syncFromSprites() {
    if (!_ready || !_sprites.length) return;

    var colorDirty  = false;
    var matrixDirty = false;

    for (var i = 0; i < _sprites.length; i++) {
      var e = _sprites[i];
      if (!e.sprite || !e.sprite.material) continue;

      // Dim: map sprite opacity → instanceColor factor
      var dimF = e.sprite.material.opacity / 0.92;
      var off  = e.idx * 3;
      _mesh.instanceColor.array[off]     = e.baseR * dimF;
      _mesh.instanceColor.array[off + 1] = e.baseG * dimF;
      _mesh.instanceColor.array[off + 2] = e.baseB * dimF;
      colorDirty = true;

      // Scale: ArgusSelection enlarges selected sprite
      if (Math.abs(e.sprite.scale.x - SCALE_SH) > 0.01) {
        if (_buildMatrix(e.lat, e.lon, e.heading, e.sprite.scale.x)) {
          _mesh.setMatrixAt(e.idx, _dummy.matrix);
          matrixDirty = true;
        }
      }
    }

    if (colorDirty)  _mesh.instanceColor.needsUpdate = true;
    if (matrixDirty) _mesh.instanceMatrix.needsUpdate = true;
  }

  // ── Public helpers ────────────────────────────────────────────────────────────

  function setVisible(v) {
    if (_mesh) _mesh.visible = !!v;
  }

  function getCount() { return _idx; }
  function getMesh()  { return _mesh; }

  return {
    init:       init,
    clear:      clear,
    upsert:     upsert,
    setVisible: setVisible,
    getCount:   getCount,
    getMesh:    getMesh,
  };
}());
