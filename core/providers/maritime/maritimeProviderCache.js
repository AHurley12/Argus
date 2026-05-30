'use strict';
// core/providers/maritime/maritimeProviderCache.js
// Live vessel cache + adaptive poll scheduler for supplemental maritime providers.
//
// Polls /.netlify/functions/fetch-maritime-supplement every ~5 min (±20% jitter).
// Maintains a Map<id → ArgusVessel> keyed by composite provider id ('digitraffic:123456789').
// On each successful poll: full-batch replacement — old map is cleared and rebuilt from
// the new response. Entries absent from the response are implicitly evicted.
// On failed poll: stale entries older than STALE_MS (15 min) are pruned; the rest survive
// so that a transient outage doesn't blank the globe.
//
// Hard cap: MAX_SUPP = 400 entries — highest-SOG vessels kept on overflow.
//
// Exposes:
//   window._argusMaritimeSupplemental — Map<id → ArgusVessel>, read by renderShips()
//   window.ArgusMaritimeProviders     — { start, stop, status }
//
// Depends on (must load before this script):
//   window.ArgusMaritimeDiagnostics   — request logging
//   window.ArgusNormalizeVessel       — toShipBufferEntry()

(function () {
  'use strict';

  var ENDPOINT   = '/.netlify/functions/fetch-maritime-supplement';
  var POLL_MS    = 5 * 60 * 1000;   // 5 min base interval
  var JITTER     = 0.20;             // ±20% jitter
  var INIT_DELAY = 35 * 1000;        // 35 s — let primary ship data load first
  var STALE_MS   = 15 * 60 * 1000;  // 15 min — entries older than this pruned on error
  var MAX_SUPP   = 400;

  var _map        = new Map();
  var _timer      = null;
  var _running    = false;
  var _lastPollAt = 0;
  var _pollCount  = 0;
  var _errCount   = 0;

  // Expose the map immediately so renderShips() can safely read it (size=0) before first poll
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
    // Sort by SOG descending so that the cap keeps the most active vessels
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
    var tok  = diag ? diag.logStart('maritime_supplement') : null;
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
        _applyBatch(vessels, nowMs);
        _lastPollAt = nowMs;
        _pollCount++;
        console.log(
          '[ArgusMaritimeProviders] poll #' + _pollCount +
          ' — ' + _map.size + ' vessels (' + (nowMs - t0) + 'ms)'
        );
        _scheduleNext();
      })
      .catch(function (err) {
        var nowMs = Date.now();
        if (tok && diag) diag.logFailure(tok, err, err.httpStatus || null);
        _errCount++;
        console.warn('[ArgusMaritimeProviders] poll error:', err.message);
        _evictStale(nowMs);  // prune very old entries; keep recent ones through outage
        _scheduleNext();
      });
  }

  // ── Public API ────────────────────────────────────────────────────────────────

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
    return {
      running:     _running,
      vesselCount: _map.size,
      lastPollAt:  _lastPollAt,
      lastPollAgo: _lastPollAt ? (Date.now() - _lastPollAt) : null,
      pollCount:   _pollCount,
      errorCount:  _errCount,
    };
  }

  window.ArgusMaritimeProviders = { start: start, stop: stop, status: status };

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusMaritimeProviders');

  // Auto-start — supplement begins collecting silently in the background
  start();
}());
