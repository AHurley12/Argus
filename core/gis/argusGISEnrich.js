'use strict';
// core/gis/argusGISEnrich.js
// ARGUS GIS Phase 4 — Context Enrichment
//
// enrichWithContext(item) enriches any event/entity with geographic context.
// Called during ingestion — NOT on hover.
// Attaches item.gis = { country, chokepoint, port, portName }
//
// Public API: window.ArgusGISEnrich
//   .enrich(item)  — item must have .lat and .lon

window.ArgusGISEnrich = (function () {
  'use strict';

  function enrich(item) {
    if (!item || item.lat == null || item.lon == null) return item;
    var bm  = window.ArgusBoundaryManager;
    var gis = {};

    if (bm && bm.isReady()) {
      gis.country    = bm.pointInCountry(item.lat, item.lon);
      gis.chokepoint = bm.pointInChokepoint(item.lat, item.lon);
      var portHit    = bm.pointNearPort(item.lat, item.lon);
      gis.port       = portHit ? portHit.id   : null;
      gis.portName   = portHit ? portHit.name : null;
    }

    item.gis = gis;
    return item;
  }

  console.log('[ArgusGISEnrich] ready');

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusGISEnrich');

  return { enrich: enrich };

}());
