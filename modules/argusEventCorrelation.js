'use strict';
// modules/argusEventCorrelation.js
// Cross-source event correlation engine.
//
// Purpose:
//   Prevents duplicate markers when multiple sources report the same real-world event.
//   Goal: ONE EVENT → ONE MARKER → MULTIPLE SOURCES recorded in userData.sources.
//
// Current consumers:
//   ArgusEONET — checks each EONET event against GDACS and NOAA before rendering.
//
// Correlation factors (all three must pass for a match):
//   1. Category match  — event types must belong to the same overlap group
//   2. Geographic proximity — centroids within GEO_THRESHOLD degrees lat/lon
//   3. Time proximity  — events within TIME_THRESHOLD ms of each other
//
// Public API: window.ArgusEventCorrelation
//   .checkAndEnrich(eonetEvent) → { isDuplicate, matchedId, matchedSource, confidence }
//                                  Also calls enrichMarker() if a match is found.
//   .check(eonetEvent)          → same result, no side effects
//   .enrichMarker(mesh, ev)     → merges EONET attribution onto an existing marker
//   .diagReport()               → console diagnostics

window.ArgusEventCorrelation = (function () {
  'use strict';

  // ── Thresholds ────────────────────────────────────────────────────────────────
  // 2° ≈ 222km at the equator — large enough to correlate events with imprecise centroids
  // (GDACS centroids are country/province centroids; EONET is the event epicentre).
  var GEO_THRESHOLD  = 2.0;
  // 72 hours — covers the gap between GDACS receiving an event and EONET activating it.
  var TIME_THRESHOLD = 72 * 60 * 60 * 1000;

  // ── Category overlap table ────────────────────────────────────────────────────
  // Key   = EONET argus-category string (after mapping in argusEonet.js)
  // Value = array of source-category strings that overlap with this EONET category
  //
  // Categories with no known overlap are not in this table and will never be flagged
  // as duplicates (sea_ice, dust_haze, landslide, snow, temperature, water_color, manmade).
  var _OVERLAP = {
    'wildfire':         ['wildfire'],
    'earthquake':       ['earthquake'],
    'flood':            ['flood'],
    'drought':          ['drought'],
    'volcano':          ['volcano'],
    'tropical_cyclone': ['tropical_cyclone'],
    'tsunami':          ['tsunami'],
  };

  // ── Audit counters ────────────────────────────────────────────────────────────
  var _audit = {
    checked:             0,
    duplicatesPrevented: 0,
    enrichments:         0,
  };

  // ── Helpers ───────────────────────────────────────────────────────────────────

  // Parse date string or epoch number to ms. Returns null if unparseable.
  function _toMs(ts) {
    if (!ts) return null;
    var n = (typeof ts === 'number') ? ts : Date.parse(ts);
    return isNaN(n) ? null : n;
  }

  // Geographic proximity test — both lat and lon within GEO_THRESHOLD degrees.
  // Does NOT use haversine — degree comparison is sufficient at this coarseness.
  function _geoMatch(lat1, lon1, lat2, lon2) {
    return Math.abs(lat1 - lat2) < GEO_THRESHOLD &&
           Math.abs(lon1 - lon2) < GEO_THRESHOLD;
  }

  // Time proximity test — within TIME_THRESHOLD. Passes if either timestamp is unknown.
  function _timeMatch(ts1, ts2) {
    if (ts1 == null || ts2 == null) return true;
    return Math.abs(ts1 - ts2) < TIME_THRESHOLD;
  }

  // Confidence score [0.00–1.00].
  // 60% weight on geographic closeness, 40% on temporal closeness.
  function _confidence(lat1, lon1, ts1, lat2, lon2, ts2) {
    var gLatDeg  = Math.min(Math.abs(lat1 - lat2), GEO_THRESHOLD);
    var gLonDeg  = Math.min(Math.abs(lon1 - lon2), GEO_THRESHOLD);
    var geoScore = 1 - (gLatDeg + gLonDeg) / (GEO_THRESHOLD * 2);

    var timeScore = 1;
    if (ts1 != null && ts2 != null) {
      timeScore = 1 - Math.min(Math.abs(ts1 - ts2), TIME_THRESHOLD) / TIME_THRESHOLD;
    }

    return Math.round((geoScore * 0.6 + timeScore * 0.4) * 100) / 100;
  }

  // ── Core check — pure, no side effects ───────────────────────────────────────
  // Returns { isDuplicate, matchedId, matchedSource, confidence }.
  function check(eonetEvent) {
    _audit.checked++;

    var overlapCats = _OVERLAP[eonetEvent.category];
    if (!overlapCats) {
      return { isDuplicate: false, matchedId: null, matchedSource: null, confidence: 0 };
    }

    var eLat = eonetEvent.lat;
    var eLon = eonetEvent.lon;
    var eTs  = _toMs(eonetEvent.timestamp);

    // ── 1. Check GDACS cache ──────────────────────────────────────────────────
    var gCache = window.gdacsEventCache;
    if (gCache && gCache.size > 0) {
      var gdacsMatch = null;
      gCache.forEach(function (ev) {
        if (gdacsMatch) return;
        if (overlapCats.indexOf(ev.category) === -1) return;
        var gTs = _toMs(ev.startTime || ev.onset || null);
        if (!_timeMatch(eTs, gTs)) return;
        if (_geoMatch(eLat, eLon, ev.lat, ev.lon)) gdacsMatch = ev;
      });

      if (gdacsMatch) {
        _audit.duplicatesPrevented++;
        return {
          isDuplicate:   true,
          matchedId:     gdacsMatch.eventId,
          matchedSource: 'GDACS',
          confidence:    _confidence(eLat, eLon, eTs,
            gdacsMatch.lat, gdacsMatch.lon,
            _toMs(gdacsMatch.startTime || gdacsMatch.onset || null)),
        };
      }
    }

    // ── 2. Check NOAA cache (tropical cyclones / severe storms only) ──────────
    if (eonetEvent.category === 'tropical_cyclone') {
      var nCache = window.weatherOverlayCache;
      if (nCache && nCache.size > 0) {
        var noaaMatch = null;
        nCache.forEach(function (ev) {
          if (noaaMatch) return;
          if (ev.lat == null || ev.lon == null) return;
          var nTs = _toMs(ev.onset || ev.effective || null);
          if (!_timeMatch(eTs, nTs)) return;
          if (_geoMatch(eLat, eLon, ev.lat, ev.lon)) noaaMatch = ev;
        });

        if (noaaMatch) {
          _audit.duplicatesPrevented++;
          return {
            isDuplicate:   true,
            matchedId:     noaaMatch.id,
            matchedSource: 'NOAA',
            confidence:    _confidence(eLat, eLon, eTs,
              noaaMatch.lat, noaaMatch.lon,
              _toMs(noaaMatch.onset || noaaMatch.effective || null)),
          };
        }
      }
    }

    return { isDuplicate: false, matchedId: null, matchedSource: null, confidence: 0 };
  }

  // ── Find an existing event marker by its source ID ────────────────────────────
  // Searches window.eventMarkers for ghost meshes whose userData ID matches.
  function _findMarker(id) {
    var markers = window.eventMarkers || [];
    for (var i = 0; i < markers.length; i++) {
      var m = markers[i];
      if (!m || !m.userData) continue;
      if (m.userData._gdacsId === id || m.userData.id === id) return m;
    }
    return null;
  }

  // ── Enrich — merge EONET attribution onto an existing marker's userData ───────
  // Adds 'EONET' to userData.sources and attaches eonetMeta without overwriting
  // any existing field.  Source attribution is preserved for the detail panel.
  function enrichMarker(mesh, eonetEvent) {
    if (!mesh || !mesh.userData) return;
    var ud = mesh.userData;

    if (!Array.isArray(ud.sources)) {
      ud.sources = [ud.source || 'GDACS'];
    }
    if (ud.sources.indexOf('EONET') === -1) {
      ud.sources.push('EONET');
    }

    ud.eonetMeta = {
      id:            eonetEvent.id,
      link:          eonetEvent.link,
      sources:       eonetEvent.sources,
      timestamp:     eonetEvent.timestamp,
      magnitude:     eonetEvent.magnitude,
      magnitudeUnit: eonetEvent.magnitudeUnit,
    };

    _audit.enrichments++;
  }

  // ── checkAndEnrich — check + auto-enrich on match ────────────────────────────
  // This is the primary entry point for ArgusEONET._loadResponse().
  function checkAndEnrich(eonetEvent) {
    var result = check(eonetEvent);
    if (result.isDuplicate && result.matchedId) {
      var marker = _findMarker(result.matchedId);
      if (marker) enrichMarker(marker, eonetEvent);
    }
    return result;
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────────
  function diagReport() {
    console.group('%c[ArgusEventCorrelation]', 'color:#ffcc44;font-weight:bold');
    console.log('  checked              :', _audit.checked);
    console.log('  duplicatesPrevented  :', _audit.duplicatesPrevented);
    console.log('  enrichments          :', _audit.enrichments);
    console.log('  gdacsCache size      :', window.gdacsEventCache
      ? window.gdacsEventCache.size : 'N/A');
    console.log('  noaaCache size       :', window.weatherOverlayCache
      ? window.weatherOverlayCache.size : 'N/A');
    console.log('  eonetCache size      :', window.eonetEventCache
      ? window.eonetEventCache.size : 'N/A');
    console.groupEnd();
  }

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusEventCorrelation');

  return {
    check:          check,
    checkAndEnrich: checkAndEnrich,
    enrichMarker:   enrichMarker,
    diagReport:     diagReport,
  };

}());
