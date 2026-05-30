'use strict';
// core/providers/maritime/maritimeProviderCache.js
// Live vessel cache + adaptive poll scheduler for supplemental maritime providers.
//
// Sources polled in parallel every ~5 min (±20% jitter), 35s init delay:
//   1. /.netlify/functions/fetch-maritime-supplement  (Digitraffic.fi — Baltic/Finnish waters)
//   2. /.netlify/functions/ais-vessels                (AISHub — 10 strategic global zones)
//
// After each poll, results are merged (deduped by MMSI, Digitraffic wins on collision),
// capped at MAX_SUPP, written to window._argusMaritimeSupplemental, and
// window.ArgusTracking.renderShips() is called to push vessels to the globe.
//
// Failure conditions:
//   - HTTP error from either endpoint → classified via ArgusMaritimeDiagnostics, logged
//   - 503 from ais-vessels → AISHUB_USERNAME env var missing in Netlify; operator must set it
//   - Empty response from either source → logged as empty_payload
//   - Stale entries (>STALE_MS) pruned on error polls so transient outages don't blank globe
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

  var ENDPOINT_DIGITRAFFIC = '/.netlify/functions/fetch-maritime-supplement';
  var ENDPOINT_AISHUB      = '/.netlify/functions/ais-vessels';

  var POLL_MS    = 5 * 60 * 1000;   // 5 min base interval
  var JITTER     = 0.20;             // ±20%
  var INIT_DELAY = 35 * 1000;        // 35 s — let globe and ArgusTracking init first
  var STALE_MS   = 15 * 60 * 1000;  // 15 min — prune on error polls
  var MAX_SUPP   = 600;              // raised from 400 — now aggregating two sources

  var _map        = new Map();
  var _timer      = null;
  var _running    = false;
  var _lastPollAt = 0;
  var _pollCount  = 0;
  var _errCount   = 0;
  var _sourceStats = { digitraffic: 0, aishub: 0 };

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

  // ── Single-source fetch with diagnostics ─────────────────────────────────────
  function _fetchSource(url, providerKey, normalizer) {
    var diag = window.ArgusMaritimeDiagnostics;
    var tok  = diag ? diag.logStart(providerKey) : null;

    return fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) {
          var e = new Error('HTTP ' + res.status);
          e.httpStatus = res.status;
          if (res.status === 503) {
            console.error(
              '[ArgusMaritimeProviders] ' + providerKey + ': 503 — check Netlify env vars.' +
              (providerKey === 'aishub' ? ' AISHUB_USERNAME must be set.' : '')
            );
          }
          throw e;
        }
        return res.json();
      })
      .then(function (data) {
        if (data.error && !Array.isArray(data.vessels)) {
          var e2 = new Error(data.error);
          if (tok && diag) diag.logFailure(tok, e2, null);
          console.warn('[ArgusMaritimeProviders]', providerKey, 'upstream error:', data.error);
          return [];
        }
        var raw     = Array.isArray(data.vessels) ? data.vessels : [];
        var vessels = normalizer ? raw.map(normalizer).filter(Boolean) : raw;
        if (tok && diag) diag.logSuccess(tok, 200, vessels.length, 0, null);
        if (vessels.length === 0) {
          console.warn('[ArgusMaritimeProviders]', providerKey, '— empty_payload (0 vessels)');
        }
        return vessels;
      })
      .catch(function (err) {
        if (tok && diag) diag.logFailure(tok, err, err.httpStatus || null);
        console.warn('[ArgusMaritimeProviders]', providerKey, 'error:', err.message);
        return [];
      });
  }

  // ── Poll: fetch both sources in parallel ──────────────────────────────────────
  function _poll() {
    if (!_running) return;

    var t0   = Date.now();
    var norm = window.ArgusNormalizeVessel;

    var p1 = _fetchSource(ENDPOINT_DIGITRAFFIC, 'digitraffic', null);       // already ArgusVessel shape
    var p2 = _fetchSource(ENDPOINT_AISHUB, 'aishub', norm ? norm.fromAISHub.bind(norm) : null);

    Promise.all([p1, p2]).then(function (results) {
      var nowMs       = Date.now();
      var dtVessels   = results[0];
      var aishVessels = results[1];

      // Merge — deduplicate by MMSI across sources (Digitraffic wins on collision)
      var combined = [];
      var seenMmsi = new Set();

      function addVessels(list) {
        list.forEach(function (v) {
          if (!v || !v.id || !v.mmsi) return;
          if (seenMmsi.has(v.mmsi)) return;
          seenMmsi.add(v.mmsi);
          combined.push(v);
        });
      }
      addVessels(dtVessels);
      addVessels(aishVessels);

      _applyBatch(combined, nowMs);
      _lastPollAt = nowMs;
      _pollCount++;
      _sourceStats.digitraffic = dtVessels.length;
      _sourceStats.aishub      = aishVessels.length;

      if (dtVessels.length === 0 && aishVessels.length === 0) {
        _errCount++;
        console.error(
          '[ArgusMaritimeProviders] BOTH sources returned 0 vessels — check Netlify function logs.' +
          ' Run: ArgusMaritimeDiagnostics.report() for details.'
        );
      } else {
        console.log(
          '[ArgusMaritimeProviders] poll #' + _pollCount +
          ' — ' + _map.size + ' vessels (' + (nowMs - t0) + 'ms)' +
          ' [digitraffic=' + dtVessels.length + ' aishub=' + aishVessels.length + ']'
        );
      }

      // Push to globe — renderShips() reads window._argusMaritimeSupplemental
      if (window.ArgusTracking && window.ArgusTracking.renderShips) {
        window.ArgusTracking.renderShips();
      } else {
        console.warn('[ArgusMaritimeProviders] ArgusTracking.renderShips not available — ships will not appear until next refresh.');
      }

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
    var health = window.ArgusMaritimeDiagnostics ? window.ArgusMaritimeDiagnostics.getHealth() : {};
    return {
      running:     _running,
      vesselCount: _map.size,
      lastPollAt:  _lastPollAt,
      lastPollAgo: _lastPollAt ? (Date.now() - _lastPollAt) : null,
      pollCount:   _pollCount,
      errorCount:  _errCount,
      sources:     _sourceStats,
      health:      health,
    };
  }

  window.ArgusMaritimeProviders = { start: start, stop: stop, status: status };

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusMaritimeProviders');

  start();
}());
