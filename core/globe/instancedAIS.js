'use strict';
// core/globe/instancedAIS.js
// AIS Instanced Rendering — replaces 0-1500 individual Sprite draw calls with ONE.
//
// Architecture:
//   argusAIS.js keeps its full interaction surface (invisible sprites → raycasters,
//   ArgusSelection, hover, click, tooltips all unchanged).
//   This module owns ONLY the visual rendering layer.
//
// Step 2.1 — InstancedMesh with capacity = AIS_MAX_MARKERS (1500)
// Step 2.2 — id → instanceIndex map + free-index pool (no unbounded growth)
// Step 2.3 — setMatrixAt() for position + heading; instanceColor for type tint
// Step 2.4 — called from argusAIS.js; sprites set material.visible=false (0 draw calls)
// Step 2.5 — interaction preserved via invisible sprites (THREE raycaster ignores
//            material.visible, so sprites remain fully raycastable + ArgusSelection-
//            compatible without any changes to index.html or ArgusSelection)
// Step 2.6 — surface-normal billboarding: plane's +Z aligned to outward globe normal,
//            heading applied as rotation around that normal. No per-frame matrix update.
//
// Dependencies: window.THREE, window.ArgusGlobe, window._argusShTex
// Public API:   window.ArgusAISInstanced

window.ArgusAISInstanced = (function () {
  'use strict';

  // Must match AIS_MAX_MARKERS in argusAIS.js
  var MAX       = 1500;
  var SCALE     = 0.89;
  var ALTITUDE  = 101.3; // R.AIS from globe init

  // ── THREE.js objects — allocated once, reused for every matrix computation ───
  // Allocating inside _setMatrix() would create GC pressure at 1500 calls/render-tick.
  var _dummy  = new THREE.Object3D();
  var _vecZ   = new THREE.Vector3(0, 0, 1); // plane default normal (PlaneGeometry)
  var _normal = new THREE.Vector3();         // outward surface normal scratch
  var _hQuat  = new THREE.Quaternion();      // heading rotation scratch
  var _nQuat  = new THREE.Quaternion();      // normal-alignment rotation scratch
  var _tmpCol = new THREE.Color();           // color scratch

  // ── State ─────────────────────────────────────────────────────────────────────
  var _mesh       = null;
  var _ready      = false;

  // Step 2.2 — index management
  var _mmsiToIdx  = new Map();                    // mmsi → instanceIndex
  var _idxToMmsi  = new Array(MAX).fill(null);    // instanceIndex → mmsi (reverse lookup)
  var _freePool   = [];                           // recycled indices (stack)
  var _maxUsedIdx = -1;                           // highest allocated index; drives _mesh.count

  // Base RGB per instance (stored for dim/restore without re-querying hexColor)
  var _baseRGB = new Float32Array(MAX * 3);       // initialised to 1,1,1

  // ── Helpers ───────────────────────────────────────────────────────────────────

  // Step 2.3 — build billboard matrix using surface-normal orientation.
  // PlaneGeometry lies in XY; its local +Z is the face normal.
  // Quaternion _nQuat aligns +Z → outward surface normal (positions plane flat on globe).
  // Heading rotation (_hQuat) then spins the plane around that same surface normal,
  // correctly turning the vessel icon in the direction of travel.
  // No per-frame update needed — matrix is stable until position or heading changes.
  function _buildMatrix(lat, lon, heading, scale) {
    var AG = window.ArgusGlobe;
    if (!AG) return false;

    var pos = AG.latLonToVector(lat, lon, ALTITUDE);

    // Align plane to globe surface
    _normal.copy(pos).normalize();
    _nQuat.setFromUnitVectors(_vecZ, _normal);

    // Apply heading (rotate around surface normal = local Z after alignment)
    if (heading != null && !isNaN(heading)) {
      _hQuat.setFromAxisAngle(_normal, -heading * Math.PI / 180);
      // premultiply: result = _hQuat * _nQuat  →  apply _nQuat first, then _hQuat
      _nQuat.premultiply(_hQuat);
    }

    _dummy.position.copy(pos);
    _dummy.setRotationFromQuaternion(_nQuat);
    _dummy.scale.set(scale, scale, 1);
    _dummy.updateMatrix();
    return true;
  }

  // Collapse an instance to zero-area (invisible) without removing its slot.
  // Used when scale = 0 OR when evicting (before recycling the index).
  function _zeroMatrix(idx) {
    _dummy.position.set(0, 0, 0);
    _dummy.scale.set(0, 0, 0);
    _dummy.rotation.set(0, 0, 0);
    _dummy.updateMatrix();
    _mesh.setMatrixAt(idx, _dummy.matrix);
  }

  // Write RGB to instanceColor buffer (does NOT set needsUpdate — caller must).
  function _writeColor(idx, r, g, b) {
    var off = idx * 3;
    _mesh.instanceColor.array[off]     = r;
    _mesh.instanceColor.array[off + 1] = g;
    _mesh.instanceColor.array[off + 2] = b;
  }

  // ── Step 2.1 — Initialise InstancedMesh ──────────────────────────────────────
  function init(aisGroup) {
    if (_ready) return true;
    var tex = window._argusShTex;
    if (!tex || !aisGroup) return false;

    // Shared geometry: plane (XY, face toward +Z) — same visual footprint as sprite
    var geo = new THREE.PlaneGeometry(SCALE * 2, SCALE * 2);

    // Shared material: identical to what upsertAISMarker used per-sprite, but shared
    var mat = new THREE.MeshBasicMaterial({
      map:         tex,
      transparent: true,
      opacity:     0.92,
      depthTest:   false,
      depthWrite:  false,
      side:        THREE.DoubleSide,  // visible from both faces (camera can be on either side)
    });

    _mesh = new THREE.InstancedMesh(geo, mat, MAX);
    _mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    _mesh.name          = 'ArgusAISInstanced';
    _mesh.frustumCulled = false;  // globe rotates → instanced mesh bounding box is unreliable
    _mesh.renderOrder   = 1;      // render above globe surface

    // Initialise instanceColor attribute (all white — type tint applied per upsert)
    var colorArr = new Float32Array(MAX * 3);
    for (var i = 0; i < MAX * 3; i++) colorArr[i] = 1.0;
    _mesh.instanceColor = new THREE.InstancedBufferAttribute(colorArr, 3);

    // Initialise all instance matrices to scale=0 (invisible) so unoccupied
    // slots never render as a stray quad at the globe origin.
    _dummy.scale.set(0, 0, 0);
    _dummy.position.set(0, 0, 0);
    _dummy.rotation.set(0, 0, 0);
    _dummy.updateMatrix();
    for (var j = 0; j < MAX; j++) {
      _mesh.setMatrixAt(j, _dummy.matrix);
      _baseRGB[j * 3] = _baseRGB[j * 3 + 1] = _baseRGB[j * 3 + 2] = 1.0;
    }
    _mesh.instanceMatrix.needsUpdate = true;

    // Start with count=0; grows as vessels are added
    _mesh.count = 0;

    aisGroup.add(_mesh);
    _ready = true;
    console.log('[ArgusAISInstanced] InstancedMesh ready — capacity:', MAX);
    return true;
  }

  // ── Step 2.2 — Index allocation ───────────────────────────────────────────────
  function _allocIdx(mmsi) {
    var idx;
    if (_freePool.length > 0) {
      idx = _freePool.pop();
    } else {
      // Expand the used range; guard against exceeding capacity
      if (_maxUsedIdx + 1 >= MAX) return -1; // at cap — caller must evict first
      idx = ++_maxUsedIdx;
    }
    _mmsiToIdx.set(mmsi, idx);
    _idxToMmsi[idx] = mmsi;
    // Grow _mesh.count to include this slot
    if (idx + 1 > _mesh.count) _mesh.count = idx + 1;
    return idx;
  }

  function _freeIdx(mmsi) {
    var idx = _mmsiToIdx.get(mmsi);
    if (idx === undefined) return;
    _mmsiToIdx.delete(mmsi);
    _idxToMmsi[idx] = null;
    _freePool.push(idx);
    // Shrink _mesh.count if this was the last slot
    if (idx + 1 === _mesh.count) {
      var newMax = idx - 1;
      while (newMax >= 0 && _idxToMmsi[newMax] === null) newMax--;
      _mesh.count = newMax + 1;
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  // Step 2.3 — upsert: create or update an AIS instance.
  // hexColor: integer e.g. 0x4488ff (from argusAIS aisColor()).
  function upsert(mmsi, lat, lon, heading, hexColor) {
    if (!_ready) return;

    var idx;
    if (_mmsiToIdx.has(mmsi)) {
      idx = _mmsiToIdx.get(mmsi);
    } else {
      idx = _allocIdx(mmsi);
      if (idx < 0) return; // at cap — argusAIS.js must have already evicted; skip
    }

    // Update matrix (position + heading)
    if (_buildMatrix(lat, lon, heading, SCALE)) {
      _mesh.setMatrixAt(idx, _dummy.matrix);
      _mesh.instanceMatrix.needsUpdate = true;
    }

    // Update colour
    _tmpCol.setHex(hexColor);
    var off = idx * 3;
    _baseRGB[off]     = _tmpCol.r;
    _baseRGB[off + 1] = _tmpCol.g;
    _baseRGB[off + 2] = _tmpCol.b;
    _writeColor(idx, _tmpCol.r, _tmpCol.g, _tmpCol.b);
    _mesh.instanceColor.needsUpdate = true;
  }

  // Remove an AIS instance (vessel evicted from argusAIS.js).
  function remove(mmsi) {
    if (!_ready) return;
    var idx = _mmsiToIdx.get(mmsi);
    if (idx === undefined) return;

    _zeroMatrix(idx);
    _mesh.instanceMatrix.needsUpdate = true;

    _freeIdx(mmsi);
  }

  // Sync dim/highlight from sprite state → InstancedMesh colour.
  // Called by argusAIS.js every render tick (300 ms).
  // dimFactor: 1.0 = full brightness, ~0.13 = ArgusSelection DIM_OPACITY relative.
  function setDimFactor(mmsi, dimFactor) {
    if (!_ready) return;
    var idx = _mmsiToIdx.get(mmsi);
    if (idx === undefined) return;
    var off = idx * 3;
    _writeColor(idx,
      _baseRGB[off]     * dimFactor,
      _baseRGB[off + 1] * dimFactor,
      _baseRGB[off + 2] * dimFactor
    );
    _mesh.instanceColor.needsUpdate = true;
  }

  // Scale update (ArgusSelection highlights selected vessel at 1.45× base scale).
  // Requires lat/lon/heading from _aisState to rebuild the matrix with new scale.
  function setScale(mmsi, scale, lat, lon, heading) {
    if (!_ready) return;
    var idx = _mmsiToIdx.get(mmsi);
    if (idx === undefined) return;
    if (_buildMatrix(lat, lon, heading, scale)) {
      _mesh.setMatrixAt(idx, _dummy.matrix);
      _mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // Toggle visibility (mirrors argusAIS.js toggle()).
  function setVisible(v) {
    if (_mesh) _mesh.visible = !!v;
  }

  // Diagnostics
  function getCount()   { return _mmsiToIdx.size; }
  function getMesh()    { return _mesh; }

  return {
    init:         init,
    upsert:       upsert,
    remove:       remove,
    setDimFactor: setDimFactor,
    setScale:     setScale,
    setVisible:   setVisible,
    getCount:     getCount,
    getMesh:      getMesh,
  };
}());
