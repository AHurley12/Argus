'use strict';
// core/providers/maritime/vesselFinderProvider.js
// VesselFinder Vessels API — viewport-aware AIS ingestion module.
//
// Data sources (strictly per VesselFinder API docs):
//   AIS layer    — real-time position, speed, course, destination, ETA
//   Voyage layer — last port, departure time  (fetchDetails with extradata=voyage)
//   PortCalls    — arrivals/departures        (fetchPortCalls)
//
// Architecture:
//   Polls /.netlify/functions/vessel-finder (server-side proxy, keeps API key secure)
//   Computes viewport bbox from ArgusGlobe camera + dataGroup rotation
//   Writes canonical ArgusVessel entries into window._argusMaritimeSupplemental
//   All entries namespaced source='vesselfinder' so Digitraffic entries are never touched
//   Calls ArgusTracking.renderShips() after each successful poll
//   Port call events → window._portCalls
//
// Adaptive polling (credit-aware):
//   global   (camZ >= 250)  : SKIP — viewport too broad, burns credits without value
//   regional (150 <= camZ < 250): poll every ~60 s
//   zoomed   (camZ < 150)   : poll every ~30 s
//
// Init delay: 45 s (staggered from Digitraffic's 35 s cold-start)
//
// Public API: window.ArgusVesselFinder = { start, stop, status, fetchDetails, fetchPortCalls }
//
// Depends on (must load before this module):
//   window.ArgusMaritimeDiagnostics   — request logging + failure classification
//   window.ArgusNormalizeVessel       — fromVesselFinder() adapter
//   window.ArgusTracking              — renderShips()
//   window.ArgusGlobe                 — { camera, dataGroup }
//   window._argusMaritimeSupplemental — shared supplemental vessel Map

(function () {
  'use strict';

  var PROXY      = '/.netlify/functions/vessel-finder';
  var INIT_DELAY = 45 * 1000;
  var JITTER     = 0.15;
  var STALE_MS   = 10 * 60 * 1000;
  var MAX_CALLS  = 20;        // max port call entries to keep in window._portCalls
  var BOOT_MS    = 500;       // readiness poll interval
  var BOOT_MAX   = 60 * 1000; // give up after 60 s

  var POLL_REGIONAL = 60  * 1000;
  var POLL_ZOOMED   = 30  * 1000;
  var POLL_GLOBAL   = 120 * 1000; // used for reschedule only; poll is skipped

  var PI     = Math.PI;
  var TWO_PI = 2 * PI;

  var _running     = false;
  var _timer       = null;
  var _bootTimer   = null;
  var _bootElapsed = 0;
  var _pollCount   = 0;
  var _errCount    = 0;
  var _lastPollAt  = 0;
  var _lastBounds  = null;

  // ── Jitter helper ──────────────────────────────────────────────────────────
  function _jitter(base) {
    return Math.round(base * (1 - JITTER + Math.random() * JITTER * 2));
  }

  // ── Zoom level classification ──────────────────────────────────────────────
  function _zoomInfo(camZ) {
    if (camZ >= 250) return { level: 'global',   pollMs: POLL_GLOBAL };
    if (camZ >= 150) return { level: 'regional', pollMs: POLL_REGIONAL };
    return              { level: 'zoomed',    pollMs: POLL_ZOOMED };
  }

  // ── Viewport bounds ────────────────────────────────────────────────────────
  // Derives visible lat/lon bounding box from the globe camera + dataGroup rotation.
  //
  // ArgusGlobe.dataGroup.rotation encodes which lat/lon is centred in the viewport.
  // Formula (from focusEntity comment in index.html):
  //   dataGroup.rotation.y = -PI/2 - lon_centre × PI/180
  //   dataGroup.rotation.x = -lat_centre × PI/180
  //
  // Half-angle of visible hemisphere = arcsin(globeRadius / camZ), padded 15%.
  function _viewportBounds() {
    var AG = window.ArgusGlobe;
    if (!AG || !AG.camera || !AG.dataGroup) return null;

    var camZ = AG.camera.position.z;
    if (!camZ || camZ <= 0) return null;

    var ry = AG.dataGroup.rotation.y;
    var rx = AG.dataGroup.rotation.x;

    // Normalize ry to (-PI, PI]
    ry = ((ry % TWO_PI) + TWO_PI) % TWO_PI;
    if (ry > PI) ry -= TWO_PI;

    var cLon = -(ry + PI / 2) * 180 / PI;
    var cLat = -rx * 180 / PI;
    cLat = Math.max(-90, Math.min(90, cLat));
    cLon = Math.max(-180, Math.min(180, cLon));

    var halfDeg  = Math.asin(Math.min(0.99, 100 / camZ)) * 180 / PI * 1.15;
    var cosLat   = Math.cos(Math.abs(cLat) * PI / 180);
    var lonSpread = Math.min(180, halfDeg / Math.max(0.1, cosLat));

    return {
      minLat:    +Math.max(-90,  cLat - halfDeg).toFixed(4),
      maxLat:    +Math.min(90,   cLat + halfDeg).toFixed(4),
      minLon:    +Math.max(-180, cLon - lonSpread).toFixed(4),
      maxLon:    +Math.min(180,  cLon + lonSpread).toFixed(4),
      centerLat: +cLat.toFixed(4),
      centerLon: +cLon.toFixed(4),
      camZ:      camZ,
    };
  }

  // ── Source-namespaced Map operations ───────────────────────────────────────
  // Only touch entries where source === 'vesselfinder'.
  // Digitraffic and other providers' entries are never cleared here.
  function _clearOwn() {
    var m = window._argusMaritimeSupplemental;
    if (!m) return;
    m.forEach(function (v, id) {
      if (v.source === 'vesselfinder') m.delete(id);
    });
  }

  function _evictStale(nowMs) {
    var m = window._argusMaritimeSupplemental;
    if (!m) return;
    var cutoff = nowMs - STALE_MS;
    m.forEach(function (v, id) {
      if (v.source === 'vesselfinder' && v.lastUpdate < cutoff) m.delete(id);
    });
  }

  function _writeVessels(normalized, nowMs) {
    var m = window._argusMaritimeSupplemental;
    if (!m) { console.warn('[ArgusVesselFinder] _argusMaritimeSupplemental not ready'); return; }
    _clearOwn();
    for (var i = 0; i < normalized.length; i++) {
      var v = normalized[i];
      if (!v) continue;
      if (!v.lastUpdate) v.lastUpdate = nowMs;
      m.set(v.id, v);
    }
  }

  // ── Core poll ──────────────────────────────────────────────────────────────
  function _poll() {
    if (!_running) return;

    var diag  = window.ArgusMaritimeDiagnostics;
    var norm  = window.ArgusNormalizeVessel;
    var nowMs = Date.now();

    var bounds = _viewportBounds();
    if (!bounds) {
      console.log('[ArgusVesselFinder] globe not ready — retrying in 15 s');
      _timer = setTimeout(_poll, 15000);
      return;
    }

    _lastBounds = bounds;
    var zoom    = _zoomInfo(bounds.camZ);

    if (zoom.level === 'global') {
      console.log('[ArgusVesselFinder] global zoom (' + bounds.camZ.toFixed(0) + ') — skipping, reschedule ' + (zoom.pollMs / 1000) + 's');
      _evictStale(nowMs);
      _timer = setTimeout(_poll, _jitter(zoom.pollMs));
      return;
    }

    var url = PROXY +
      '?action=positions' +
      '&minLat=' + bounds.minLat +
      '&maxLat=' + bounds.maxLat +
      '&minLon=' + bounds.minLon +
      '&maxLon=' + bounds.maxLon;

    var tok = diag ? diag.logStart('vesselfinder') : null;
    var t0  = Date.now();

    fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) { var e = new Error('HTTP ' + res.status); e.httpStatus = res.status; throw e; }
        return res.json();
      })
      .then(function (data) {
        var fetchNow = Date.now();
        var raw      = Array.isArray(data.vessels) ? data.vessels : [];

        if (tok && diag) diag.logSuccess(tok, 200, raw.length, 0, null);
        if (raw.length === 0) {
          console.warn('[ArgusVesselFinder] 0 vessels in bbox centre=' + bounds.centerLat + ',' + bounds.centerLon);
        }

        var normalized = [];
        for (var i = 0; i < raw.length; i++) {
          var v = norm.fromVesselFinder(raw[i]);
          if (v) normalized.push(v);
        }

        _writeVessels(normalized, fetchNow);
        _evictStale(fetchNow);

        _lastPollAt = fetchNow;
        _pollCount++;

        var mapTotal = window._argusMaritimeSupplemental ? window._argusMaritimeSupplemental.size : 0;
        console.log(
          '[ArgusVesselFinder] poll #' + _pollCount +
          ' ' + normalized.length + ' vessels (' + (fetchNow - t0) + 'ms)' +
          ' zoom=' + zoom.level + ' mapTotal=' + mapTotal
        );

        if (window.ArgusTracking && window.ArgusTracking.renderShips) {
          window.ArgusTracking.renderShips();
        }

        _timer = setTimeout(_poll, _jitter(zoom.pollMs));
      })
      .catch(function (err) {
        var fetchNow = Date.now();
        if (tok && diag) diag.logFailure(tok, err, err.httpStatus || null);
        _errCount++;
        console.warn('[ArgusVesselFinder] poll error:', err.message);
        _evictStale(fetchNow);
        var interval = _lastBounds ? _zoomInfo(_lastBounds.camZ).pollMs : POLL_REGIONAL;
        _timer = setTimeout(_poll, _jitter(interval));
      });
  }

  // ── Public: start / stop / status ─────────────────────────────────────────
  function start() {
    if (_running) return;
    _running = true;
    console.log('[ArgusVesselFinder] starting — first poll in ' + (INIT_DELAY / 1000) + 's');
    _timer = setTimeout(_poll, INIT_DELAY);
  }

  function stop() {
    _running = false;
    if (_timer)     { clearTimeout(_timer);     _timer     = null; }
    if (_bootTimer) { clearTimeout(_bootTimer); _bootTimer = null; }
    console.log('[ArgusVesselFinder] stopped');
  }

  function status() {
    var diag    = window.ArgusMaritimeDiagnostics;
    var m       = window._argusMaritimeSupplemental;
    var vfCount = 0;
    if (m) m.forEach(function (v) { if (v.source === 'vesselfinder') vfCount++; });
    return {
      running:     _running,
      vesselCount: vfCount,
      lastPollAt:  _lastPollAt,
      lastPollAgo: _lastPollAt ? (Date.now() - _lastPollAt) : null,
      pollCount:   _pollCount,
      errorCount:  _errCount,
      lastBounds:  _lastBounds,
      health:      diag ? (diag.getHealth().vesselfinder || null) : null,
    };
  }

  // ── Public: fetchDetails(mmsi, extradata) ─────────────────────────────────
  // Returns a Promise<ArgusVessel|null>.
  // extradata: 'voyage' | 'master' | '' (optional enrichment)
  // Dispatches custom event 'argus:vesseldetails' on success.
  function fetchDetails(mmsi, extradata) {
    var norm = window.ArgusNormalizeVessel;
    if (!norm || !norm.fromVesselFinder) {
      return Promise.reject(new Error('ArgusNormalizeVessel.fromVesselFinder not available'));
    }
    var url = PROXY + '?action=details&mmsi=' + encodeURIComponent(String(mmsi).replace(/\D/g, ''));
    if (extradata === 'voyage' || extradata === 'master') url += '&extradata=' + extradata;

    return fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(function (data) {
        if (!data.vessel) return null;
        var v = norm.fromVesselFinder(data.vessel);
        if (v) window.dispatchEvent(new CustomEvent('argus:vesseldetails', { detail: { vessel: v } }));
        return v;
      });
  }

  // ── Public: fetchPortCalls(mmsi) ──────────────────────────────────────────
  // Fetches port call history. Writes to window._portCalls (newest first, max 20).
  function fetchPortCalls(mmsi) {
    var url = PROXY + '?action=portcalls&mmsi=' + encodeURIComponent(String(mmsi).replace(/\D/g, ''));

    return fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(function (data) {
        var raw   = Array.isArray(data.calls) ? data.calls : [];
        var calls = raw.map(function (r) {
          return {
            vesselId:  'vesselfinder:' + String(mmsi).replace(/\D/g, ''),
            portName:  r.PORTNAME  || r.portName  || null,
            locode:    r.LOCODE    || r.locode    || null,
            country:   r.COUNTRY   || r.country   || null,
            arrival:   r.ARRIVAL   || r.arrival   || null,
            departure: r.DEPARTURE || r.departure || null,
            ts:        Date.now(),
          };
        });
        calls.sort(function (a, b) {
          return (b.arrival ? new Date(b.arrival).getTime() : 0) -
                 (a.arrival ? new Date(a.arrival).getTime() : 0);
        });
        window._portCalls = calls.slice(0, MAX_CALLS);
        console.log('[ArgusVesselFinder] fetchPortCalls mmsi=' + mmsi + ' → ' + window._portCalls.length + ' calls');
        return window._portCalls;
      });
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────────
  function _boot() {
    var norm = window.ArgusNormalizeVessel;
    if (!norm || typeof norm.fromVesselFinder !== 'function') {
      _bootElapsed += BOOT_MS;
      if (_bootElapsed >= BOOT_MAX) {
        console.warn('[ArgusVesselFinder] timeout waiting for ArgusNormalizeVessel.fromVesselFinder — module will not start');
        return;
      }
      _bootTimer = setTimeout(_boot, BOOT_MS);
      return;
    }
    start();
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  window.ArgusVesselFinder = {
    start:          start,
    stop:           stop,
    status:         status,
    fetchDetails:   fetchDetails,
    fetchPortCalls: fetchPortCalls,
  };

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusVesselFinder');

  _bootTimer = setTimeout(_boot, BOOT_MS);

}());
