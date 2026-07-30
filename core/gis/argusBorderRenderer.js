'use strict';
// core/gis/argusBorderRenderer.js
// ARGUS GIS Phase 2 — BorderRenderer
//
// Renders country political boundaries as a THREE.LineSegments mesh on the
// globe surface. Independent of the canvas texture (which bakes borders into
// the land fill image) — this layer can be toggled separately, styled, and
// queried.
//
// Architecture:
//   - Off by default. Enable via ArgusBorderRenderer.setVisible(true).
//   - Built once from the country GeoJSON when _onFeaturesReady() is called.
//   - Geometry is built during requestIdleCallback to avoid blocking the UI.
//   - Antimeridian seam is handled by skipping segments that span > 180° lon.
//   - Added to window.ArgusGlobe.dataGroup so it co-rotates with the globe.
//
// Public API: window.ArgusBorderRenderer
//   .setVisible(bool)  — show/hide the border layer
//   .isVisible()       → bool
//   .isReady()         → bool — true once geometry is built
//   ._onFeaturesReady(features) — called by index.html (internal wiring only)
//
// Dependencies: window.THREE, window.ArgusGlobe (set before .then() fires)

window.ArgusBorderRenderer = (function () {
  'use strict';

  var _mesh    = null;
  var _ready   = false;
  var _visible = false;

  // ── _onFeaturesReady — called by index.html ───────────────────────────────────
  // Defers geometry construction to requestIdleCallback so it doesn't block
  // the GeoJSON fetch callback or the initial globe render.
  function _onFeaturesReady(features) {
    if (window.requestIdleCallback) {
      requestIdleCallback(function () { _build(features); }, { timeout: 4000 });
    } else {
      setTimeout(function () { _build(features); }, 150);
    }
  }

  // ── _build — constructs Three.js LineSegments from all country border rings ───
  function _build(features) {
    var AG = window.ArgusGlobe;
    if (!AG || !AG.dataGroup || !AG.latLonToVector || !AG.R) {
      console.warn('[ArgusBorderRenderer] ArgusGlobe not ready — deferring');
      setTimeout(function () { _build(features); }, 500);
      return;
    }

    var altitude   = AG.R.GRID;   // 100.39 — just above globe surface (100)
    var latLonToV  = AG.latLonToVector;
    var positions  = [];           // flat [x,y,z, x,y,z, ...] — one pair per segment

    for (var fi = 0; fi < features.length; fi++) {
      var geom = features[fi] && features[fi].geometry;
      if (!geom) continue;
      var polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;

      for (var p = 0; p < polys.length; p++) {
        var rings = polys[p];
        for (var ri = 0; ri < rings.length; ri++) {
          var ring = rings[ri];
          for (var ci = 1; ci < ring.length; ci++) {
            var prevLon = ring[ci - 1][0], prevLat = ring[ci - 1][1];
            var currLon = ring[ci][0],     currLat = ring[ci][1];
            // Skip segments that cross the antimeridian — they'd draw a line
            // from one side of the globe to the other through the interior.
            if (Math.abs(currLon - prevLon) > 180) continue;
            var p1 = latLonToV(prevLat, prevLon, altitude);
            var p2 = latLonToV(currLat, currLon, altitude);
            positions.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
          }
        }
      }
    }

    var buf = new THREE.BufferGeometry();
    buf.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));

    // Subtle blue-white: visible when zoomed in, understated at full globe scale.
    // depthWrite: false avoids corrupting the depth buffer for transparent overlays.
    var mat = new THREE.LineBasicMaterial({
      color:       0x5588cc,
      transparent: true,
      opacity:     0.40,
      depthWrite:  false,
    });

    _mesh         = new THREE.LineSegments(buf, mat);
    _mesh.visible = _visible;

    AG.dataGroup.add(_mesh);
    _ready = true;

    console.log('[ArgusBorderRenderer] built — ' + (positions.length / 6) + ' segments');
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  function setVisible(bool) {
    _visible = !!bool;
    if (_mesh) _mesh.visible = _visible;
  }

  function isVisible() { return _visible; }
  function isReady()   { return _ready;   }

  return {
    setVisible:       setVisible,
    isVisible:        isVisible,
    isReady:          isReady,
    _onFeaturesReady: _onFeaturesReady,
  };
}());

if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusBorderRenderer');
