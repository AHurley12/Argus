'use strict';
// core/gis/argusRegionalAggregator.js
// ARGUS GIS Phase 4 — Regional Aggregator
//
// Aggregates spatial index data by gis.country.
// Does NOT re-run point-in-polygon — reads the gis field set during enrichment.
//
// Public API: window.ArgusRegionalAggregator
//   .getCountrySummary(iso3)  → { country, events, vessels, aircraft, risk, coverage }
//   .getGlobalSummary()       → { byCountry: [...] } top 20 countries by event count

window.ArgusRegionalAggregator = (function () {
  'use strict';

  // Risk score formula matching ArgusAnalytics — severity multipliers.
  var SEVERITY_WEIGHTS = { CRITICAL: 8, WARNING: 4, WATCH: 2, red: 8, orange: 4, green: 2 };

  function _riskScore(events) {
    var score = 0;
    events.forEach(function (ev) {
      var sev = (ev.severity || ev._evSev || '').toLowerCase();
      if      (sev === 'critical' || sev === 'red')    score += 8;
      else if (sev === 'warning'  || sev === 'orange') score += 4;
      else if (sev === 'watch'    || sev === 'green')  score += 2;
      else                                              score += 1;
    });
    return score;
  }

  // Coverage tier based on data points per 100,000 km².
  // Uses fixed-ratio approximation — we don't have exact country areas.
  function _coverageTier(count) {
    // Normalise against a reference of 100,000 km² — equivalent counts
    if (count < 5)  return 'LOW';
    if (count < 20) return 'MODERATE';
    return 'GOOD';
  }

  // ── getCountrySummary ─────────────────────────────────────────────────────────
  function getCountrySummary(iso3) {
    if (!iso3) return null;

    var events   = [];
    var vessels  = 0;
    var aircraft = 0;

    // Scan event caches — read gis.country field set during enrichment
    var caches = [
      window.acledEventCache,
      window.gdacsEventCache,
      window.eonetEventCache,
    ];
    caches.forEach(function (cache) {
      if (!cache) return;
      cache.forEach(function (ev) {
        if (ev && ev.gis && ev.gis.country === iso3) events.push(ev);
      });
    });

    // Scan live entity caches for vessels and aircraft by gis.country
    // (AIS vessel and aircraft caches may be published on window by their modules)
    var vesselCaches = [
      window.aisVesselCache,
      window.shipCache,
      window.vesselCache,
    ];
    vesselCaches.forEach(function (cache) {
      if (!cache || typeof cache.forEach !== 'function') return;
      cache.forEach(function (v) {
        if (v && v.gis && v.gis.country === iso3) vessels++;
      });
    });
    var aircraftCaches = [
      window.aircraftLiveCache,
      window.flightCache,
    ];
    aircraftCaches.forEach(function (cache) {
      if (!cache || typeof cache.forEach !== 'function') return;
      cache.forEach(function (a) {
        if (a && a.gis && a.gis.country === iso3) aircraft++;
      });
    });

    var risk     = _riskScore(events);
    var coverage = _coverageTier(events.length);

    // Count events by type
    var eventsByType = {};
    events.forEach(function (ev) {
      var t = ev.category || ev.eventType || ev.type || 'other';
      eventsByType[t] = (eventsByType[t] || 0) + 1;
    });

    return {
      country:      iso3,
      eventCount:   events.length,
      eventsByType: eventsByType,
      vessels:      vessels,
      aircraft:     aircraft,
      risk:         risk,
      coverage:     coverage,
    };
  }

  // ── getGlobalSummary ──────────────────────────────────────────────────────────
  function getGlobalSummary() {
    var counts = {};

    var caches = [
      window.acledEventCache,
      window.gdacsEventCache,
      window.eonetEventCache,
    ];
    caches.forEach(function (cache) {
      if (!cache) return;
      cache.forEach(function (ev) {
        if (!ev || !ev.gis || !ev.gis.country) return;
        var iso3 = ev.gis.country;
        counts[iso3] = (counts[iso3] || 0) + 1;
      });
    });

    var byCountry = Object.keys(counts).map(function (iso3) {
      return { country: iso3, events: counts[iso3] };
    });

    byCountry.sort(function (a, b) { return b.events - a.events; });
    byCountry = byCountry.slice(0, 20);

    return { byCountry: byCountry };
  }

  console.log('[ArgusRegionalAggregator] ready');

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusRegionalAggregator');

  return {
    getCountrySummary: getCountrySummary,
    getGlobalSummary:  getGlobalSummary,
  };

}());
