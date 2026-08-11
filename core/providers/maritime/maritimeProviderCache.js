'use strict';
// core/providers/maritime/maritimeProviderCache.js
// Live vessel cache + poll scheduler for supplemental maritime providers.
//
// Sources:
//   /.netlify/functions/fetch-maritime-supplement  (Digitraffic.fi — Baltic/Finnish waters)
//     Polled every ~5 min (±20% jitter), 35s init delay.
//   /.netlify/functions/ais-vessels                (AISHub REST — 10 strategic zones, fallback)
//     Polled every ~10 min (±20% jitter), 60s init delay.
//     Requires AISHUB_USERNAME Netlify env var. Used as fallback when AISstream WS is degraded.
//
// After each poll, results are written to window._argusMaritimeSupplemental and
// window.ArgusTracking.renderShips() is called to push vessels to the globe via shipGroup.
//
// Failure conditions logged via ArgusMaritimeDiagnostics:
//   - HTTP error        → upstream_denial / auth / timeout
//   - Empty response    → logged as warning
//   - renderShips N/A  → logged as warning; vessels will appear on next refresh
//
// Exposes:
//   window._argusMaritimeSupplemental — Map<id → ArgusVessel>, read by renderShips()
//   window.ArgusMaritimeProviders     — { start, stop, status }
//
// Depends on (must load before this script):
//   window.ArgusMaritimeDiagnostics   — request logging + failure classification
//   window.ArgusNormalizeVessel       — fromAISHub(), toShipBufferEntry()
//   window.ArgusTracking              — renderShips() (exposed on public API)

(function () {
  'use strict';

  // ── Digitraffic constants ─────────────────────────────────────────────────────
  var ENDPOINT   = '/.netlify/functions/fetch-maritime-supplement';
  var POLL_MS    = 5 * 60 * 1000;
  var JITTER     = 0.20;
  var INIT_DELAY = 35 * 1000;
  var STALE_MS   = 15 * 60 * 1000;
  var MAX_SUPP   = 400;

  // ── AISHub constants ──────────────────────────────────────────────────────────
  var AH_ENDPOINT   = '/.netlify/functions/ais-vessels';
  var AH_POLL_MS    = 10 * 60 * 1000; // 10 min — conservative for free tier
  var AH_INIT_DELAY = 60 * 1000;      // 60s — staggered from Digitraffic's 35s
  var AH_STALE_MS   = 25 * 60 * 1000; // 25 min — longer window since it's a fallback
  var AH_MAX        = 500;

  // ── Shared vessel map ─────────────────────────────────────────────────────────
  var _map        = new Map();

  // ── Digitraffic state ─────────────────────────────────────────────────────────
  var _timer      = null;
  var _running    = false;
  var _lastPollAt = 0;
  var _pollCount  = 0;
  var _errCount   = 0;

  // ── AISHub state ──────────────────────────────────────────────────────────────
  var _ahTimer      = null;
  var _ahLastPollAt = 0;
  var _ahPollCount  = 0;
  var _ahErrCount   = 0;

  window._argusMaritimeSupplemental = _map;

  function _jitter(base, pct) {
    return Math.round(base * (1 - pct + Math.random() * pct * 2));
  }

  function _scheduleNext() {
    if (_running) _timer = setTimeout(_poll, _jitter(POLL_MS, JITTER));
  }

  function _evictStale(nowMs) {
    var cutoff = nowMs - STALE_MS;
    _map.forEach(function (v, id) {
      if (v.lastUpdate < cutoff) _map.delete(id);
    });
  }

  // ── AISHub: evict + apply ─────────────────────────────────────────────────────
  function _evictAISHub() {
    _map.forEach(function (v, id) { if (v.source === 'aishub') _map.delete(id); });
  }

  function _applyAISHub(rawVessels, nowMs) {
    var norm = window.ArgusNormalizeVessel;
    if (!norm || !norm.fromAISHub) {
      console.warn('[ArgusMaritimeProviders] ArgusNormalizeVessel.fromAISHub not available — skipping AISHub batch');
      return 0;
    }
    var sorted   = rawVessels.slice().sort(function (a, b) { return (b.velocity || 0) - (a.velocity || 0); });
    var cap      = Math.min(sorted.length, AH_MAX);
    var written  = 0;
    _evictAISHub();
    for (var i = 0; i < cap; i++) {
      var vessel = norm.fromAISHub(sorted[i]);
      if (!vessel) continue;
      if (!vessel.lastUpdate) vessel.lastUpdate = nowMs;
      _map.set(vessel.id, vessel);
      written++;
    }
    return written;
  }

  function _pollAISHub() {
    if (!_running) return;

    var diag = window.ArgusMaritimeDiagnostics;
    var tok  = diag ? diag.logStart('aishub') : null;
    var t0   = Date.now();

    fetch(AH_ENDPOINT, { headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) {
          var e = new Error('HTTP ' + res.status);
          e.httpStatus = res.status;
          throw e;
        }
        return res.json();
      })
      .then(function (data) {
        var nowMs   = Date.now();
        var vessels = Array.isArray(data.vessels) ? data.vessels : [];

        if (tok && diag) diag.logSuccess(tok, 200, vessels.length, 0, null);

        if (vessels.length === 0) {
          console.warn('[ArgusMaritimeProviders] aishub — empty_payload (check AISHUB_USERNAME env var)');
        }

        var written = _applyAISHub(vessels, nowMs);
        _ahLastPollAt = nowMs;
        _ahPollCount++;

        console.log(
          '[ArgusMaritimeProviders] aishub poll #' + _ahPollCount +
          ' — ' + written + ' vessels written (' + (nowMs - t0) + 'ms) [raw=' + vessels.length + ']'
        );

        if (window.ArgusTracking && window.ArgusTracking.renderShips) {
          window.ArgusTracking.renderShips();
        }

        if (_running) _ahTimer = setTimeout(_pollAISHub, _jitter(AH_POLL_MS, JITTER));
      })
      .catch(function (err) {
        var nowMs = Date.now();
        if (tok && diag) diag.logFailure(tok, err, err.httpStatus || null);
        _ahErrCount++;
        console.warn('[ArgusMaritimeProviders] aishub poll error:', err.message);
        if (_running) _ahTimer = setTimeout(_pollAISHub, _jitter(AH_POLL_MS, JITTER));
      });
  }

  function _applyBatch(vessels, nowMs) {
    var sorted = vessels.slice().sort(function (a, b) { return (b.sog || 0) - (a.sog || 0); });
    var cap    = Math.min(sorted.length, MAX_SUPP);
    // Remove only this provider's entries — leave VesselFinder and other providers intact
    _map.forEach(function (v, id) { if (v.source === 'digitraffic') _map.delete(id); });
    for (var i = 0; i < cap; i++) {
      var v = sorted[i];
      if (!v.lastUpdate) v.lastUpdate = nowMs;
      _map.set(v.id, v);
    }
  }

  function _poll() {
    if (!_running) return;

    var diag = window.ArgusMaritimeDiagnostics;
    var tok  = diag ? diag.logStart('digitraffic') : null;
    var t0   = Date.now();

    fetch(ENDPOINT, { headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) {
          var e = new Error('HTTP ' + res.status);
          e.httpStatus = res.status;
          throw e;
        }
        return res.json();
      })
      .then(function (data) {
        var nowMs   = Date.now();
        var vessels = Array.isArray(data.vessels) ? data.vessels : [];

        if (tok && diag) diag.logSuccess(tok, 200, vessels.length, 0, null);

        if (vessels.length === 0) {
          console.warn('[ArgusMaritimeProviders] digitraffic — empty_payload (0 vessels returned)');
        }

        _applyBatch(vessels, nowMs);
        _lastPollAt = nowMs;
        _pollCount++;

        console.log(
          '[ArgusMaritimeProviders] poll #' + _pollCount +
          ' — ' + _map.size + ' vessels (' + (nowMs - t0) + 'ms) [digitraffic=' + vessels.length + ']'
        );

        if (window.ArgusTracking && window.ArgusTracking.renderShips) {
          window.ArgusTracking.renderShips();
        } else {
          console.warn('[ArgusMaritimeProviders] ArgusTracking.renderShips not available — ships will appear on next render cycle');
        }

        _scheduleNext();
      })
      .catch(function (err) {
        var nowMs = Date.now();
        if (tok && diag) diag.logFailure(tok, err, err.httpStatus || null);
        _errCount++;
        console.warn('[ArgusMaritimeProviders] poll error:', err.message, '— run ArgusMaritimeDiagnostics.report() for details');
        _evictStale(nowMs);
        _scheduleNext();
      });
  }

  function start() {
    if (_running) return;
    _running = true;
    console.log('[ArgusMaritimeProviders] starting — digitraffic in ' + (INIT_DELAY / 1000) + 's, aishub in ' + (AH_INIT_DELAY / 1000) + 's');
    _timer   = setTimeout(_poll,      INIT_DELAY);
    _ahTimer = setTimeout(_pollAISHub, AH_INIT_DELAY);
  }

  function stop() {
    _running = false;
    if (_timer)   { clearTimeout(_timer);   _timer   = null; }
    if (_ahTimer) { clearTimeout(_ahTimer); _ahTimer = null; }
    console.log('[ArgusMaritimeProviders] stopped');
  }

  function status() {
    var health = window.ArgusMaritimeDiagnostics ? window.ArgusMaritimeDiagnostics.getHealth() : {};
    var now    = Date.now();
    return {
      running:           _running,
      vesselCount:       _map.size,
      digitraffic: {
        lastPollAt:  _lastPollAt,
        lastPollAgo: _lastPollAt  ? (now - _lastPollAt)  : null,
        pollCount:   _pollCount,
        errorCount:  _errCount,
      },
      aishub: {
        lastPollAt:  _ahLastPollAt,
        lastPollAgo: _ahLastPollAt ? (now - _ahLastPollAt) : null,
        pollCount:   _ahPollCount,
        errorCount:  _ahErrCount,
      },
      health: health,
    };
  }

  window.ArgusMaritimeProviders = { start: start, stop: stop, status: status };

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusMaritimeProviders');

  start();
}());
