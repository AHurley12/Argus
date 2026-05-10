'use strict';
// core/globe/instancedCountries.js
// Country Marker Instanced Rendering — replaces ~195 individual Mesh draw calls with ONE.
//
// Architecture:
//   index.html keeps its full interaction surface:
//     - countryHitMeshes (invisible expanded hit spheres) → hover raycasting
//     - countryMarkers   (ghost meshes, material.visible=false) → click raycasting + userData
//   This module owns ONLY the visual rendering layer.
//
// Per-instance color is required — GDELT sentiment analysis updates country risk colors.
// A stable code→instanceIndex map lets updateColor() target the correct instance.
//
// Static positions — init() is called once at page load; no rebuild needed.
// GDELT calls updateColor(code, colorStr) when it receives new sentiment data.
//
// Dependencies: window.THREE, latLonToVector (passed to init — no window.ArgusGlobe dependency)
// Public API:   window.ArgusCountriesInstanced

window.ArgusCountriesInstanced = (function () {
  'use strict';

  var SCALE_CN = 1.07;  // matches SphereGeometry radius in addStaticMarker
  var ALTITUDE = 101;   // matches R.MARKER in globe init

  // ── Pre-allocated scratch objects ─────────────────────────────────────────────
  var _dummy  = new THREE.Object3D();
  var _tmpCol = new THREE.Color();

  // ── State ─────────────────────────────────────────────────────────────────────
  var _mesh      = null;
  var _ready     = false;
  var _codeToIdx = new Map();  // ISO-3 country code → instanceIndex

  // ── Init ──────────────────────────────────────────────────────────────────────
  // parentGroup:   staticMarkerGroup
  // countriesData: COUNTRIES_DATA array from static-data.js
  // staticRc:      STATIC_RC color map { LOW:'#00ff88', WATCH:... } — same reference
  // latLonToVecFn: the globe's latLonToVector(lat, lon, r) function — passed explicitly
  //                because window.ArgusGlobe may not be set yet at call time.
  function init(parentGroup, countriesData, staticRc, latLonToVecFn) {
    if (_ready) return true;
    if (!parentGroup || !countriesData || !countriesData.length || !latLonToVecFn) return false;

    var count = countriesData.length;

    // Shared sphere geometry matching the original SphereGeometry(1.07, 14, 14).
    // Using a lower-poly sphere (8,8) since instances are small dots on the globe.
    var geo = new THREE.SphereGeometry(SCALE_CN, 10, 10);

    var mat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity:     0.82,
      // Per-instance color is driven by InstancedMesh.instanceColor (USE_INSTANCING_COLOR
      // shader path). No vertexColors flag needed — THREE.js handles this automatically.
    });

    _mesh = new THREE.InstancedMesh(geo, mat, count);
    _mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);  // positions never change
    _mesh.name          = 'ArgusCountriesInstanced';
    _mesh.frustumCulled = false;
    _mesh.renderOrder   = 0;   // render at same level as static markers
    _mesh.visible       = false;  // hidden on first load
    _mesh.count         = count;

    // Init instanceColor to white (overwritten below)
    var colors = new Float32Array(count * 3);
    for (var i = 0; i < count * 3; i++) colors[i] = 1.0;
    _mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);

    // Zero-scale placeholder so no stray spheres appear before population
    _dummy.scale.set(0, 0, 0);
    _dummy.position.set(0, 0, 0);
    _dummy.rotation.set(0, 0, 0);
    _dummy.updateMatrix();
    for (var j = 0; j < count; j++) _mesh.setMatrixAt(j, _dummy.matrix);

    // Populate all instances
    for (var k = 0; k < count; k++) {
      var c   = countriesData[k];
      var pos = latLonToVecFn(c.rawLat, c.rawLon, ALTITUDE);
      _dummy.position.copy(pos);
      _dummy.scale.set(1, 1, 1);
      _dummy.rotation.set(0, 0, 0);
      _dummy.updateMatrix();
      _mesh.setMatrixAt(k, _dummy.matrix);

      var hexStr = staticRc[c.risk] || '#00ff88';
      _tmpCol.set(hexStr);
      var off = k * 3;
      _mesh.instanceColor.array[off]     = _tmpCol.r;
      _mesh.instanceColor.array[off + 1] = _tmpCol.g;
      _mesh.instanceColor.array[off + 2] = _tmpCol.b;

      if (c.code) _codeToIdx.set(c.code, k);
    }

    _mesh.instanceMatrix.needsUpdate = true;
    _mesh.instanceColor.needsUpdate  = true;

    parentGroup.add(_mesh);
    _ready = true;
    console.log('[ArgusCountriesInstanced] ready —', count, 'countries in 1 draw call');
    return true;
  }

  // ── updateColor — called by GDELT when sentiment data upgrades a country's risk ─
  // colorStr: CSS color string e.g. '#ff0044' or THREE.Color object.
  function updateColor(code, colorStr) {
    if (!_ready) return;
    var idx = _codeToIdx.get(code);
    if (idx === undefined) return;

    _tmpCol.set(colorStr);
    var off = idx * 3;
    _mesh.instanceColor.array[off]     = _tmpCol.r;
    _mesh.instanceColor.array[off + 1] = _tmpCol.g;
    _mesh.instanceColor.array[off + 2] = _tmpCol.b;
    _mesh.instanceColor.needsUpdate = true;
  }

  // ── Public helpers ────────────────────────────────────────────────────────────

  function setVisible(v) {
    if (_mesh) _mesh.visible = !!v;
  }

  function getCount() { return _mesh ? _mesh.count : 0; }
  function getMesh()  { return _mesh; }

  return {
    init:        init,
    updateColor: updateColor,
    setVisible:  setVisible,
    getCount:    getCount,
    getMesh:     getMesh,
  };
}());
