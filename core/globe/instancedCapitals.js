'use strict';
// core/globe/instancedCapitals.js
// Capital City Instanced Rendering — replaces ~200 individual Sprite draw calls with ONE.
//
// Architecture:
//   index.html keeps its full interaction surface (ghost sprites in capitalMarkers →
//   raycasters, hover, tooltips, ArgusSelection all unchanged).
//   This module owns ONLY the visual rendering layer.
//
// Static positions — init() is called once at page load; no rebuild ever needed.
// All capitals share the same city icon texture with uniform opacity/no per-instance color.
// Ghost sprites are never added to the scene; they carry userData for hover/click/tooltips.
//
// Visibility is controlled via setVisible(bool) which mirrors the 'V' layer toggle.
// Ghost sprites' .visible property is still managed by the existing toggle loop in
// index.html — this keeps canInteract() and hover reconciliation functioning correctly.
//
// Dependencies: window.THREE, latLonToVector (passed to init — no window.ArgusGlobe dependency)
// Public API:   window.ArgusCapitalsInstanced

window.ArgusCapitalsInstanced = (function () {
  'use strict';

  var SCALE_CAP = 1.68;   // matches sprite.scale.set(1.68, 1.68, 1) in original code
  var ALTITUDE  = 101.8;  // matches R.AIRCRAFT in globe init

  // ── Pre-allocated scratch objects ─────────────────────────────────────────────
  var _dummy  = new THREE.Object3D();
  var _vecZ   = new THREE.Vector3(0, 0, 1);  // PlaneGeometry default face normal
  var _normal = new THREE.Vector3();
  var _nQuat  = new THREE.Quaternion();

  // ── State ─────────────────────────────────────────────────────────────────────
  var _mesh  = null;
  var _ready = false;

  // ── Helpers ───────────────────────────────────────────────────────────────────

  // Surface-normal billboard matrix without heading — capitals have no orientation.
  // Aligns the plane's +Z to the outward globe normal so it faces the camera.
  var _latlonFn = null;  // set once on first init() call

  function _buildMatrix(lat, lon) {
    if (!_latlonFn) return false;
    var pos = _latlonFn(lat, lon, ALTITUDE);
    _normal.copy(pos).normalize();
    _nQuat.setFromUnitVectors(_vecZ, _normal);
    _dummy.position.copy(pos);
    _dummy.setRotationFromQuaternion(_nQuat);
    _dummy.scale.set(SCALE_CAP, SCALE_CAP, 1);
    _dummy.updateMatrix();
    return true;
  }

  // ── Init — called once after capitalCitiesData is available ──────────────────
  // parentGroup:   the THREE.Group to add the mesh into (eventMarkerGroup).
  // cityTex:       the shared CanvasTexture for the city icon.
  // citiesData:    the capitalCitiesData array from static-data.js.
  // latLonToVecFn: the globe's latLonToVector(lat, lon, r) function — passed explicitly
  //                because window.ArgusGlobe may not be set yet at call time.
  function init(parentGroup, cityTex, citiesData, latLonToVecFn) {
    if (_ready) return true;
    if (!cityTex || !parentGroup || !citiesData || !citiesData.length || !latLonToVecFn) return false;

    var count = citiesData.length;
    _latlonFn = latLonToVecFn;  // store for _buildMatrix

    // Shared geometry: 1×1 plane — matrix scale drives world-space size
    var geo = new THREE.PlaneGeometry(1, 1);

    var mat = new THREE.MeshBasicMaterial({
      map:         cityTex,
      transparent: true,
      opacity:     0.92,
      depthTest:   false,
      depthWrite:  false,
      side:        THREE.DoubleSide,
    });

    _mesh = new THREE.InstancedMesh(geo, mat, count);
    _mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);  // positions never change
    _mesh.name          = 'ArgusCapitalsInstanced';
    _mesh.frustumCulled = false;  // globe rotates — instanced bounding box is unreliable
    _mesh.renderOrder   = 1;
    _mesh.visible       = false;  // hidden on first load; matches original capitalMarkers behavior
    _mesh.count         = count;

    // Initialise all slots to scale=0 first, then populate in a second pass.
    // This avoids rendering partially-built state if the loop is interrupted.
    _dummy.scale.set(0, 0, 0);
    _dummy.position.set(0, 0, 0);
    _dummy.rotation.set(0, 0, 0);
    _dummy.updateMatrix();
    for (var j = 0; j < count; j++) _mesh.setMatrixAt(j, _dummy.matrix);

    // Populate all instances with correct globe-surface positions
    for (var i = 0; i < count; i++) {
      var city = citiesData[i];
      if (_buildMatrix(city.lat, city.lon)) {
        _mesh.setMatrixAt(i, _dummy.matrix);
      }
    }
    _mesh.instanceMatrix.needsUpdate = true;

    parentGroup.add(_mesh);
    _ready = true;
    console.log('[ArgusCapitalsInstanced] ready —', count, 'capitals in 1 draw call');
    return true;
  }

  // ── Public helpers ────────────────────────────────────────────────────────────

  // Toggle visibility — called alongside the existing ghost-sprite visible loop.
  function setVisible(v) {
    if (_mesh) _mesh.visible = !!v;
  }

  function getCount() { return _mesh ? _mesh.count : 0; }
  function getMesh()  { return _mesh; }

  return {
    init:       init,
    setVisible: setVisible,
    getCount:   getCount,
    getMesh:    getMesh,
  };
}());
