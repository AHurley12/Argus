'use strict';
// core/providers/maritime/maritimeProviderCache.js
// Live vessel cache + poll scheduler for supplemental maritime providers.
//
// Source: /.netlify/functions/fetch-maritime-supplement  (Digitraffic.fi — Baltic/Finnish waters)
// Polled every ~5 min (±20% jitter), 35s init delay.
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
//   window.ArgusNormalizeVessel       — toShipBufferEntry()
//   window.ArgusTracking              — renderShips() (exposed on public API)

(function () {
  'use strict';

  var ENDPOINT   = '/.netlify/functions/fetch-maritime-supplement';
  var POLL_MS    = 5 * 60 * 1000;
  var JITTER     = 0.20;
  var INIT_DELAY = 35 * 1000;
  var STALE_MS   = 15 * 60 * 1000;
  var MAX_SUPP   = 400;

  var _map        = new Map();
  var _timer      = null;
  var _running    = false;
  var _lastPollAt = 0;
  var _pollCount  = 0;
  var _errCount   = 0;

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

  function _applyBatch(vessels, nowMs) {
    var sorted = vessels.slice().sort(function (a, b) { return (b.sog || 0) - (a.sog || 0); });
    var cap    = Math.min(sorted.length, MAX_SUPP);
    _map.clear();
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
    console.log('[ArgusMaritimeProviders] starting — first poll in ' + (INIT_DELAY / 1000) + 's');
    _timer = setTimeout(_poll, INIT_DELAY);
  }

  function stop() {
    _running = false;
    if (_timer) { clearTimeout(_timer); _timer = null; }
    console.log('[ArgusMaritimeProviders] stopped');
  }

  function status() {
    var health = window.ArgusMaritimeDiagnostics ? window.ArgusMaritimeDiagnostics.getHealth() : {};
    return {
      running:     _running,
      vesselCount: _map.size,
      lastPollAt:  _lastPollAt,
      lastPollAgo: _lastPollAt ? (Date.now() - _lastPollAt) : null,
      pollCount:   _pollCount,
      errorCount:  _errCount,
      health:      health,
    };
  }

  window.ArgusMaritimeProviders = { start: start, stop: stop, status: status };

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusMaritimeProviders');

  start();
}());
