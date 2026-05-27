'use strict';
// core/globe/instancedAircraft.js
// Aircraft Instanced Rendering — replaces 750 individual Sprite draw calls with TWO.
//
// Architecture:
//   argusTracking.js keeps its full interaction surface (invisible ghost sprites →
//   raycasters, ArgusSelection, hover, click all unchanged).
//   This module owns ONLY the visual rendering layer.
//
// Two InstancedMesh instances handle the opacity split:
//   _meshNormal  — live aircraft      (opacity 0.92, up to 750 instances)
//   _meshStale   — dead-reckoned      (opacity 0.45, up to 50 instances)
// Both share a single PlaneGeometry (read-only in GPU).
//
// Lifecycle (full rebuild every 90s):
//   renderAircraft() → ArgusAircraftInstanced.clear()  → reset both meshes
//   placeAircraft()  → ArgusAircraftInstanced.upsert() → sequential slot allocation
//   No free-pool needed — full clear eliminates eviction complexity.
//
// Dim/scale sync (ArgusSelection drives ghost sprites):
//   100ms setInterval reads sprite.material.opacity and sprite.scale,
//   mirrors the changes to instanceColor and instanceMatrix.
//   parent===null guard skips sprites removed by clearGroup().
//
// Dependencies: window.THREE, window.ArgusGlobe
// Public API:   window.ArgusAircraftInstanced

window.ArgusAircraftInstanced = (function () {
  'use strict';

  var MAX      = 800;    // > AIRCRAFT_LIMIT(750) + DR headroom
  var SCALE_AC = 1.75;   // matches placeAircraft sprite.scale.set(1.75, 1.75, 1)
  var ALTITUDE = 101.8;  // matches placeAircraft latLonToVector altitude

  // ── Pre-allocated scratch objects — no per-call GC pressure ──────────────────
  var _dummy  = new THREE.Object3D();
  var _vecZ   = new THREE.Vector3(0, 0, 1);  // PlaneGeometry default normal
  var _normal = new THREE.Vector3();
  var _hQuat  = new THREE.Quaternion();
  var _nQuat  = new THREE.Quaternion();
  var _tmpCol = new THREE.Color();

  // ── State ─────────────────────────────────────────────────────────────────────
  var _meshNormal = null;   // opacity 0.92 — live aircraft
  var _meshStale  = null;   // opacity 0.45 — dead-reckoned aircraft
  var _ready      = false;

  // Sequential counters — reset on each clear() call (no free-pool needed)
  var _normalIdx = 0;
  var _staleIdx  = 0;

  // Sprite sync arrays — rebuilt on each clear() / upsert() cycle.
  // Entry: { sprite, idx, lat, lon, heading, baseOpacity, baseR, baseG, baseB, lastDimF }
  var _normalSprites = [];
  var _staleSprites  = [];

  // Base RGB stores for dim restore (separate for each mesh)
  var _baseRGB_n = new Float32Array(MAX * 3);  // normal aircraft base colors
  var _baseRGB_s = new Float32Array(MAX * 3);  // stale aircraft base colors

  var _syncTimer = null;  // 100ms dim/scale sync interval handle

  // ── Zoom-scale state ──────────────────────────────────────────────────────────
  // Multiplied inside _buildMatrix so all callers benefit automatically.
  // _normalSprites / _staleSprites already store per-aircraft lat/lon/heading,
  // so applyZoomScale() needs no separate position storage.
  var _zoomScale = 1.0;

  // ── Dirty-flag audit counters (exposed via getAudit()) ───────────────────────
  var _audit = { dirtyOpacity: 0, skippedOpacity: 0 };

  // ── Helpers ───────────────────────────────────────────────────────────────────

  // Surface-normal billboard matrix — identical math to instancedAIS.js.
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
    _dummy.scale.set(scale * _zoomScale, scale * _zoomScale, 1);
    _dummy.updateMatrix();
    return true;
  }

  // Write RGB to a mesh's instanceColor buffer (caller sets needsUpdate).
  function _writeColor(mesh, idx, r, g, b) {
    var off = idx * 3;
    mesh.instanceColor.array[off]     = r;
    mesh.instanceColor.array[off + 1] = g;
    mesh.instanceColor.array[off + 2] = b;
  }

  // ── Init ─────────────────────────────────────────────────────────────────────
  function init(aircraftGroup, acTex) {
    if (_ready) return true;
    if (!acTex || !aircraftGroup) return false;

    // Shared geometry: 1×1 plane — matrix scale drives world-space size (SCALE_AC = 1.75 wu)
    var geo = new THREE.PlaneGeometry(1, 1);

    var matNormal = new THREE.MeshBasicMaterial({
      map: acTex, transparent: true, opacity: 0.92,
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    });
    var matStale = new THREE.MeshBasicMaterial({
      map: acTex, transparent: true, opacity: 0.45,
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    });

    _meshNormal = new THREE.InstancedMesh(geo, matNormal, MAX);
    _meshNormal.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    _meshNormal.name          = 'ArgusAircraftNormal';
    _meshNormal.frustumCulled = false;
    _meshNormal.renderOrder   = 1;
    _meshNormal.count         = 0;
    _meshNormal.userData._keepAlive = true;  // clearGroup() must not remove this

    _meshStale = new THREE.InstancedMesh(geo, matStale, MAX);
    _meshStale.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    _meshStale.name          = 'ArgusAircraftStale';
    _meshStale.frustumCulled = false;
    _meshStale.renderOrder   = 1;
    _meshStale.count         = 0;
    _meshStale.userData._keepAlive = true;

    // Init instanceColor to white — type tint applied per upsert()
    var normColors  = new Float32Array(MAX * 3);
    var staleColors = new Float32Array(MAX * 3);
    for (var i = 0; i < MAX * 3; i++) { normColors[i] = 1.0; staleColors[i] = 1.0; }
    _meshNormal.instanceColor = new THREE.InstancedBufferAttribute(normColors, 3);
    _meshStale.instanceColor  = new THREE.InstancedBufferAttribute(staleColors, 3);

    // All slots start at scale=0 — unused slots never render as stray quads
    _dummy.scale.set(0, 0, 0);
    _dummy.position.set(0, 0, 0);
    _dummy.rotation.set(0, 0, 0);
    _dummy.updateMatrix();
    for (var j = 0; j < MAX; j++) {
      _meshNormal.setMatrixAt(j, _dummy.matrix);
      _meshStale.setMatrixAt(j, _dummy.matrix);
    }
    _meshNormal.instanceMatrix.needsUpdate = true;
    _meshStale.instanceMatrix.needsUpdate  = true;

    aircraftGroup.add(_meshNormal);
    aircraftGroup.add(_meshStale);
    _ready = true;

    // Start dim/scale sync — 100ms is imperceptible to users, light CPU cost
    _syncTimer = setInterval(_syncFromSprites, 100);

    console.log('[ArgusAircraftInstanced] ready — capacity:', MAX, '× 2 meshes (normal + stale)');
    return true;
  }

  // ── clear — called at top of each renderAircraft() (every ~90s) ───────────────
  // Resets sequential counters and sprite sync arrays. Sets count=0 on both meshes
  // so no instances render until the new batch of upsert() calls completes.
  function clear() {
    if (!_ready) return;
    _normalIdx     = 0;
    _staleIdx      = 0;
    _normalSprites = [];
    _staleSprites  = [];
    _meshNormal.count = 0;
    _meshStale.count  = 0;
    // instanceMatrix entries beyond count are not rendered — no explicit zeroing needed
  }

  // ── upsert — allocate next sequential slot, set matrix + color ───────────────
  // Called once per aircraft per renderAircraft() cycle. Sequential allocation
  // is sufficient here since the full mesh is rebuilt every ~90s.
  function upsert(lat, lon, heading, colorHex, stale, sprite) {
    if (!_ready) return;

    var mesh    = stale ? _meshStale    : _meshNormal;
    var spArr   = stale ? _staleSprites : _normalSprites;
    var bRGB    = stale ? _baseRGB_s    : _baseRGB_n;
    var idx     = stale ? _staleIdx++   : _normalIdx++;
    var baseOp  = stale ? 0.45 : 0.92;

    if (idx >= MAX) return;  // at cap

    if (_buildMatrix(lat, lon, heading, SCALE_AC)) {
      mesh.setMatrixAt(idx, _dummy.matrix);
      mesh.instanceMatrix.needsUpdate = true;
    }

    _tmpCol.setHex(colorHex);
    var off = idx * 3;
    bRGB[off]     = _tmpCol.r;
    bRGB[off + 1] = _tmpCol.g;
    bRGB[off + 2] = _tmpCol.b;
    _writeColor(mesh, idx, _tmpCol.r, _tmpCol.g, _tmpCol.b);
    mesh.instanceColor.needsUpdate = true;

    if (idx + 1 > mesh.count) mesh.count = idx + 1;

    // Record sprite reference for the 100ms dim/scale poller.
    // lastDimF tracks the last written dim factor so _syncFromSprites skips no-op writes.
    spArr.push({
      sprite: sprite, idx: idx,
      lat: lat, lon: lon, heading: heading,
      baseOpacity: baseOp,
      baseR: _tmpCol.r, baseG: _tmpCol.g, baseB: _tmpCol.b,
      lastDimF: 1.0,  // dirty-flag: full brightness at upsert time
    });
  }

  // ── 100ms dim/scale sync ─────────────────────────────────────────────────────
  // ArgusSelection modifies ghost sprite opacity (dim) and scale (highlight).
  // This poller mirrors those changes to the InstancedMesh so the visual matches.
  // parent===null guard skips sprites evicted by clearGroup() before clear() runs.
  //
  // Dirty-flag optimisation: lastDimF tracks the previously written dim factor.
  // At steady state (nothing selected, dimF = 1.0 for all), no writes occur and
  // neither instanceColor buffer is uploaded.
  function _syncFromSprites() {
    if (!_ready) return;

    var groups = [
      { arr: _normalSprites, mesh: _meshNormal, bRGB: _baseRGB_n },
      { arr: _staleSprites,  mesh: _meshStale,  bRGB: _baseRGB_s },
    ];

    for (var g = 0; g < groups.length; g++) {
      var grp         = groups[g];
      var colorDirty  = false;
      var matrixDirty = false;

      for (var i = 0; i < grp.arr.length; i++) {
        var e = grp.arr[i];
        // Aircraft ghost sprites are never added to any scene group — no parent check.
        // (parent===null is always true for detached sprites; checking it would skip everything)
        if (!e.sprite || !e.sprite.material) continue;

        // Dim: only write when factor actually changed — avoids buffer upload at steady state
        var dimF = e.sprite.material.opacity / e.baseOpacity;
        if (Math.abs(dimF - e.lastDimF) > 0.001) {
          e.lastDimF = dimF;
          var off = e.idx * 3;
          grp.mesh.instanceColor.array[off]     = grp.bRGB[off]     * dimF;
          grp.mesh.instanceColor.array[off + 1] = grp.bRGB[off + 1] * dimF;
          grp.mesh.instanceColor.array[off + 2] = grp.bRGB[off + 2] * dimF;
          colorDirty = true;
          _audit.dirtyOpacity++;
        } else {
          _audit.skippedOpacity++;
        }

        // Scale: ArgusSelection enlarges selected sprite (1.75 → ~2.54)
        if (Math.abs(e.sprite.scale.x - SCALE_AC) > 0.01) {
          if (_buildMatrix(e.lat, e.lon, e.heading, e.sprite.scale.x)) {
            grp.mesh.setMatrixAt(e.idx, _dummy.matrix);
            matrixDirty = true;
          }
        }
      }

      if (colorDirty)  grp.mesh.instanceColor.needsUpdate = true;
      if (matrixDirty) grp.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // ── applyZoomScale — full matrix rebuild on zoom bucket change ───────────────
  // Iterates both sprite sync arrays (which store per-aircraft lat/lon/heading).
  // For highlighted aircraft, uses the sprite's actual enlarged scale so selection
  // highlight is preserved correctly under the new zoom multiplier.
  function applyZoomScale(s) {
    if (!_ready || s === _zoomScale) return;
    _zoomScale = s;
    var groups = [
      { arr: _normalSprites, mesh: _meshNormal },
      { arr: _staleSprites,  mesh: _meshStale  },
    ];
    for (var g = 0; g < groups.length; g++) {
      var grp      = groups[g];
      var matDirty = false;
      for (var i = 0; i < grp.arr.length; i++) {
        var e  = grp.arr[i];
        // Use actual sprite scale when ArgusSelection has enlarged it; base otherwise
        var sc = (e.sprite && Math.abs(e.sprite.scale.x - SCALE_AC) > 0.01)
          ? e.sprite.scale.x
          : SCALE_AC;
        if (_buildMatrix(e.lat, e.lon, e.heading, sc)) {
          grp.mesh.setMatrixAt(e.idx, _dummy.matrix);
          matDirty = true;
        }
      }
      if (matDirty) grp.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // ── Public helpers ────────────────────────────────────────────────────────────

  // Mirror group visibility (aircraftGroup.visible already covers this as parent,
  // but explicit call keeps parity with instancedAIS.js API).
  function setVisible(v) {
    if (_meshNormal) _meshNormal.visible = !!v;
    if (_meshStale)  _meshStale.visible  = !!v;
  }

  function getCount() {
    return _normalIdx + _staleIdx;
  }

  function getAudit() { return { dirtyOpacity: _audit.dirtyOpacity, skippedOpacity: _audit.skippedOpacity }; }

  return {
    init:       init,
    clear:      clear,
    upsert:     upsert,
    applyZoomScale: applyZoomScale,
    setVisible:     setVisible,
    getCount:       getCount,
    getAudit:       getAudit,
  };
}());
