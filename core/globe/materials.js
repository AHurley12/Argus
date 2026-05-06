'use strict';
// core/globe/materials.js
// Centralised colour registry for all globe marker types.
// Phase 1.1: documents existing colour mapping (previously scattered across modules).
// Phase 2+:  shared SpriteMaterial / InstancedMesh material instances live here.
//
// AIS vessel type → hex colour — mirrors aisColor() in argusAIS.js.
// Kept in sync manually; a future refactor should import from a single source.
window.ArgusMarkerColors = (function() {
  'use strict';

  var AIS_COLORS = {
    cargo:        0x4488ff,
    tanker:       0xff9933,
    military:     0xff4444,
    passenger:    0xffffff,
    fishing:      0x44cc88,
    tug:          0xffcc44,
    port_service: 0xaaaaaa,
    recreational: 0xcc88ff,
    other:        0x14b8a6,
    unknown:      0x888888,
  };

  // Aircraft type → hex colour — mirrors AC_TYPE_COLORS in argusTracking.js.
  var AC_COLORS = {
    commercial: 0xffffff,
    cargo:      0x4488ff,
    military:   0xff4444,
    unknown:    0xffffff,
  };

  function aisHex(typeCategory) {
    var t = (typeCategory || 'other').toLowerCase();
    return AIS_COLORS[t] !== undefined ? AIS_COLORS[t] : AIS_COLORS.other;
  }

  function aircraftHex(flightType) {
    var t = (flightType || 'unknown').toLowerCase();
    return AC_COLORS[t] !== undefined ? AC_COLORS[t] : AC_COLORS.unknown;
  }

  return { aisHex: aisHex, aircraftHex: aircraftHex, AIS_COLORS: AIS_COLORS, AC_COLORS: AC_COLORS };
}());
