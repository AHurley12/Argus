'use strict';
// core/providers/argusProviderCache.js
// Aircraft supplemental ingestion — OpenSky (primary) + adsb.lol (fallback).
//
// Architecture:
//   Two independent polling loops write to a single live Map (aircraftLiveCache).
//   Both loops call _ingestAircraftArray() — dedup, diff-upsert, stale eviction.
//
//   Loop A — OpenSky via Cloudflare Worker (primary):
//     _pollOpenSky() every OPENSKY_POLL (30s)
//     → CF Worker (CORS proxy) → opensky-network.org/api/states/all?bbox
//     → normalized Argus schema delivered by Worker
//     → _openSkyConsecutiveEmpty tracks consecutive zero-aircraft responses
//       (used by status() for health observability, does not suppress fallback)
//
//   Loop B — adsb.lol via Netlify (fallback / enrichment):
//     _pollSupplemental() every SUPPLEMENTAL_POLL (5 min)
//     → /.netlify/functions/fetch-supplemental?lat=X&lon=X&dist=250
//     → server normalizes adsb.lol → Argus schema
//     → always runs — provides coverage when OpenSky is rate-limited or IP-blocked
//
// Bbox derivation (Loop A):
//   _getViewportCenter() → globe rotation → lat/lon of camera-facing point
//   _getBbox(center, BBOX_DEG) → lamin/lamax/lomin/lomax clamped to valid ranges
//   BBOX_DEG = 25 ≈ 1500 NM radius — wide enough for a regional viewport
//
// Ingestion core (_ingestAircraftArray):
//   PURELY ADDITIVE — never clears or replaces primary fetch-traffic aircraft.
//   1. Build capped, deduplicated incoming set (skip primary ICAO24s)
//   2. Explicit stale eviction (STALE_MS = max(loops) × 3)
//   3. Diff upsert — created vs updated counted separately
//   4. Hard cap (MAX_INJECT)
//   5. Cycle diagnostic log
//
// Globals published:
//   window._argusProviderAircraft  Map<icao24, record>  (live ref — renderAircraft reads)
//   window._argusCurrentIcao24s    Set<icao24>          (populated by renderAircraft each pass)
//   window.aircraftLiveCache       alias for _argusProviderAircraft
//
// Dependencies:
//   window._argusReqCache   — request coalescing (fetch-supplemental path only)
//   window.ArgusGlobe       — globe rotation for viewport center
//   window.ArgusModuleAudit — optional
//
// Load order: after argusAIS.js and argusTracking.js (last in body).

(function () {
  'use strict';

  // ── Config ────────────────────────────────────────────────────────────────────
  var OPENSKY_WORKER    = 'https://opensky-proxy.aidanhurley12.workers.dev';
  var SUPPLEMENTAL_FN   = '/.netlify/functions/fetch-supplemental';

  var OPENSKY_POLL      = 30 * 1000;           // 30s — safe for authenticated OpenSky (5 req/10s)
  var SUPPLEMENTAL_POLL = 5  * 60 * 1000;      // 5 min — adsb.lol fallback cadence
  var BBOX_DEG          = 25;                  // ±25° from viewport center ≈ 1500 NM radius
  var ADSB_DIST_NM      = 250;                 // supplemental viewport radius (NM)

  var MAX_INJECT        = 250;                 // hard ceiling on supplemental cache size
  var STALE_MS          = SUPPLEMENTAL_POLL * 3; // 15 min — evict after 3 missed supplemental cycles

  // ── Live aircraft cache ───────────────────────────────────────────────────────
  var aircraftLiveCache = new Map(); // icao24 → normalized Argus record

  // ── Audit ─────────────────────────────────────────────────────────────────────
  var _audit = {
    openskyPolls:   0,
    openskyIngested: 0,
    openskyErrors:  0,
    openskyConsecutiveEmpty: 0,
    suppPolls:      0,
    suppIngested:   0,
    suppErrors:     0,
    skipped:        0,
    expired:        0,
    lastOpenSkyMs:  0,
    lastSuppMs:     0,
    lastError:      null,
  };

  // ── State ─────────────────────────────────────────────────────────────────────
  var _openSkyTimer    = null;
  var _suppTimer       = null;
  var _openSkyActive   = false;
  var _suppActive      = false;
  var _enabled         = true;
  var _openSkyErrorType = null; // last typed error code from Worker response
  var _openSkyWorkerV   = null; // X-Worker-Version from last response
  var _firstPoll        = true; // log full URL on first poll only

  // ── Primary-absent check ──────────────────────────────────────────────────────
  function _isPrimaryAbsent(icao24) {
    var primary = window._argusCurrentIcao24s;
    if (!primary || !primary.size) return true;
    return !primary.has(icao24);
  }

  // ── Viewport center ───────────────────────────────────────────────────────────
  // Returns { lat, lon } of the globe point facing the camera.
  // Math: camera at world (0,0,z). Inverse globe rotation M^-1 applied to (0,0,1):
  //   M^-1*(0,0,1) = (-sin(ry)cos(rx), sin(rx), cos(ry)cos(rx))
  // Then lat = 90 - arccos(y)*r2d; lon from atan2(z,-x)*r2d - 180.
  function _getViewportCenter() {
    var ag = window.ArgusGlobe;
    if (!ag || !ag.globeGroup) return null;
    var rx  = ag.globeGroup.rotation.x;
    var ry  = ag.globeGroup.rotation.y;
    var lx  = -Math.sin(ry) * Math.cos(rx);
    var ly  =  Math.sin(rx);
    var lz  =  Math.cos(ry) * Math.cos(rx);
    var phi = Math.acos(Math.max(-1, Math.min(1, ly)));
    var lat = 90 - phi * 180 / Math.PI;
    var lon = 0;
    if (Math.abs(Math.sin(phi)) > 1e-6) {
      lon = Math.atan2(lz, -lx) * 180 / Math.PI - 180;
      if (lon < -180) lon += 360;
      if (lon >  180) lon -= 360;
    }
    return { lat: lat, lon: lon };
  }

  // ── Bounding box from viewport center ─────────────────────────────────────────
  // Expands lon range at high latitudes (cos-scaling). Clamps to valid ranges.
  function _getBbox(center, radiusDeg) {
    var lat    = center.lat;
    var lon    = center.lon;
    var cosLat = Math.max(0.1, Math.cos(lat * Math.PI / 180));
    var lonDeg = Math.min(90, radiusDeg / cosLat); // cap to avoid wrapping

    return {
      lamin: parseFloat(Math.max(-90,  lat - radiusDeg).toFixed(4)),
      lamax: parseFloat(Math.min( 90,  lat + radiusDeg).toFixed(4)),
      lomin: parseFloat(Math.max(-180, lon - lonDeg).toFixed(4)),
      lomax: parseFloat(Math.min( 180, lon + lonDeg).toFixed(4)),
    };
  }

  // ── Ingestion core ────────────────────────────────────────────────────────────
  // Diff-based — never blind-clears the cache. Called by both poll loops.
  function _ingestAircraftArray(aircraft, sourceLabel) {
    if (!Array.isArray(aircraft) || !aircraft.length) return 0;
    var nowMs       = Date.now();
    var sizeAtStart = aircraftLiveCache.size;
    var label       = sourceLabel || 'unknown';

    // ── Emergency guard ──────────────────────────────────────────────────────
    if (aircraftLiveCache.size > MAX_INJECT * 2) {
      console.warn('[ArgusProviderCache] Cache inflated to', aircraftLiveCache.size,
        '— clearing. Check for external writes to window.aircraftLiveCache.');
      aircraftLiveCache.clear();
    }

    // ── Step 1: Build capped, deduplicated incoming set ───────────────────
    var incomingIds = new Set();
    var incoming    = [];
    for (var i = 0; i < aircraft.length; i++) {
      if (incoming.length >= MAX_INJECT) break;
      var ac = aircraft[i];
      if (!ac || !ac.icao24 || ac.lat == null || ac.lon == null) continue;
      if (incomingIds.has(ac.icao24)) continue;
      if (!_isPrimaryAbsent(ac.icao24)) { _audit.skipped++; continue; }
      incomingIds.add(ac.icao24);
      incoming.push(ac);
    }

    // ── Step 2: Stale eviction ────────────────────────────────────────────
    var expired = 0;
    aircraftLiveCache.forEach(function (entry, id) {
      var tooOld = (entry._cachedAt != null) && (nowMs - entry._cachedAt) > STALE_MS;
      if (!incomingIds.has(id) || tooOld) {
        aircraftLiveCache.delete(id);
        expired++;
      }
    });

    // ── Step 3: Diff upsert ───────────────────────────────────────────────
    var created = 0;
    var updated = 0;
    for (var j = 0; j < incoming.length; j++) {
      var entry  = incoming[j];
      var exists = aircraftLiveCache.has(entry.icao24);
      entry._cachedAt = nowMs;
      aircraftLiveCache.set(entry.icao24, entry);
      if (exists) { updated++; } else { created++; }
    }

    // ── Step 4: Hard cap ──────────────────────────────────────────────────
    if (aircraftLiveCache.size > MAX_INJECT) {
      var iter = aircraftLiveCache.keys();
      var trim = aircraftLiveCache.size - MAX_INJECT;
      for (var k = 0; k < trim; k++) aircraftLiveCache.delete(iter.next().value);
      console.warn('[ArgusProviderCache] HARD CAP — trimmed', trim, 'entries.');
    }

    // ── Step 5: Cycle diagnostic ──────────────────────────────────────────
    var delta = aircraftLiveCache.size - sizeAtStart;
    console.log(
      '[ArgusProviderCache:' + label + ']',
      'created:', created,
      '| updated:', updated,
      '| expired:', expired,
      '| cacheSize:', aircraftLiveCache.size,
      '| Δ:', (delta >= 0 ? '+' : '') + delta
    );

    _audit.expired += expired;
    return created + updated;
  }

  // ── Loop A: OpenSky via Cloudflare Worker ─────────────────────────────────────
  function _pollOpenSky() {
    if (!_enabled || _openSkyActive) return;
    _openSkyActive = true;
    _audit.openskyPolls++;

    var center = _getViewportCenter();
    if (!center) {
      _openSkyActive = false;
      return;
    }

    var bbox = _getBbox(center, BBOX_DEG);
    var url  = OPENSKY_WORKER +
               '?lamin=' + bbox.lamin +
               '&lamax=' + bbox.lamax +
               '&lomin=' + bbox.lomin +
               '&lomax=' + bbox.lomax;

    // Log full URL on first poll — confirms Worker URL and bbox in console.
    if (_firstPoll) {
      console.log('[ArgusProviderCache:opensky] first poll →', url);
      _firstPoll = false;
    }

    fetch(url)
      .then(function (resp) {
        // Capture Worker version from response header (confirms which deploy is live).
        var workerV = resp.headers && resp.headers.get('X-Worker-Version');
        if (workerV && workerV !== _openSkyWorkerV) {
          _openSkyWorkerV = workerV;
          console.log('[ArgusProviderCache:opensky] Worker version:', workerV);
        }

        // New Worker (v2+) always returns HTTP 200 with error field in body.
        // Old Worker passes through upstream status verbatim (may be 403).
        // Handle both safely — never throw on non-ok, just log and fall through.
        if (!resp.ok) {
          console.warn('[ArgusProviderCache:opensky] Worker returned HTTP', resp.status,
            '— old Worker still deployed? Run: wrangler deploy');
          _openSkyActive = false;
          _audit.openskyErrors++;
          _audit.openskyConsecutiveEmpty++;
          _audit.lastError = 'Worker HTTP ' + resp.status + ' (redeploy needed)';
          _openSkyErrorType = 'worker_http_' + resp.status;
          return null;
        }

        return resp.json();
      })
      .then(function (json) {
        if (!json) return; // non-ok path already handled above
        _openSkyActive       = false;
        _audit.lastOpenSkyMs = Date.now();

        if (!Array.isArray(json.aircraft)) return;

        // Typed error from Worker — log and track, fallback loop covers coverage.
        if (json.error) {
          _openSkyErrorType = json.error;
          _audit.openskyErrors++;
          _audit.openskyConsecutiveEmpty++;
          _audit.lastError = 'opensky: ' + json.error;

          // Distinguish known error types for operator awareness
          if (json.error === 'opensky_ip_blocked_403') {
            console.warn('[ArgusProviderCache:opensky] CF IP blocked by OpenSky. ' +
              'Supplemental loop (adsb.lol) will provide coverage. ' +
              'Run /?mode=probe to confirm.');
          } else if (json.error === 'opensky_auth_failed_401') {
            console.warn('[ArgusProviderCache:opensky] Auth failed — check OPENSKY_USERNAME ' +
              'and OPENSKY_PASSWORD secrets. Run: wrangler secret put OPENSKY_USERNAME');
          } else if (json.error === 'opensky_rate_limited_429') {
            console.warn('[ArgusProviderCache:opensky] Rate limited — daily quota may be exhausted.');
          } else {
            console.warn('[ArgusProviderCache:opensky] upstream error:', json.error);
          }
          return;
        }

        if (!json.aircraft.length) {
          _openSkyErrorType = null;
          _audit.openskyConsecutiveEmpty++;
          return;
        }

        _openSkyErrorType              = null;
        _audit.openskyConsecutiveEmpty = 0;
        var n = _ingestAircraftArray(json.aircraft, 'opensky');
        _audit.openskyIngested += n;
        console.log('[ArgusProviderCache:opensky] ok —',
          json.count, 'aircraft | ingested:', n,
          json.cached ? '| cf-cache-hit' : '| cf-cache-miss',
          '| workerV:', json.workerV || '?');
      })
      .catch(function (err) {
        _openSkyActive = false;
        _audit.openskyErrors++;
        _audit.openskyConsecutiveEmpty++;
        _openSkyErrorType = 'network_error';
        _audit.lastError  = 'opensky: ' + (err && err.message ? err.message : String(err));
        console.warn('[ArgusProviderCache:opensky] network error:', _audit.lastError);
      });
  }

  // ── Loop B: adsb.lol via Netlify (fallback / enrichment) ─────────────────────
  function _pollSupplemental() {
    if (!_enabled || _suppActive) return;
    if (!window._argusReqCache) return;
    _suppActive = true;
    _audit.suppPolls++;

    var center = _getViewportCenter();
    var lat    = center ? center.lat.toFixed(2) : '0';
    var lon    = center ? center.lon.toFixed(2) : '0';
    var url    = SUPPLEMENTAL_FN + '?lat=' + lat + '&lon=' + lon + '&dist=' + ADSB_DIST_NM;

    window._argusReqCache.fetch(url)
      .then(function (json) {
        _suppActive        = false;
        _audit.lastSuppMs  = Date.now();
        if (!json || !Array.isArray(json.aircraft)) return;
        console.log('[ArgusProviderCache:supplemental] raw:', json.aircraft.length, 'aircraft');
        var n = _ingestAircraftArray(json.aircraft, 'supplemental');
        _audit.suppIngested += n;
      })
      .catch(function (err) {
        _suppActive = false;
        _audit.suppErrors++;
        _audit.lastError = 'supp: ' + (err && err.message ? err.message : String(err));
      });
  }

  // ── Publish globals ───────────────────────────────────────────────────────────
  window._argusProviderAircraft = aircraftLiveCache;
  window._argusCurrentIcao24s   = new Set();
  window.aircraftLiveCache      = aircraftLiveCache;

  // ── Lifecycle ─────────────────────────────────────────────────────────────────
  function start() {
    if (_openSkyTimer && _suppTimer) return; // already running

    // OpenSky: first poll after 20s (let primary renderAircraft() populate
    // _argusCurrentIcao24s first so we don't duplicate primary aircraft).
    if (!_openSkyTimer) {
      setTimeout(_pollOpenSky, 20 * 1000);
      _openSkyTimer = setInterval(_pollOpenSky, OPENSKY_POLL);
      console.log('[ArgusProviderCache] OpenSky loop started — every',
        Math.round(OPENSKY_POLL / 1000), 's via CF Worker');
    }

    // Supplemental: first poll after 30s (slight stagger from OpenSky).
    if (!_suppTimer) {
      setTimeout(function () {
        if (window._argusReqCache) {
          _pollSupplemental();
          _suppTimer = setInterval(_pollSupplemental, SUPPLEMENTAL_POLL);
          console.log('[ArgusProviderCache] Supplemental loop started — every',
            Math.round(SUPPLEMENTAL_POLL / 60000), 'min via fetch-supplemental');
        }
      }, 30 * 1000);
    }
  }

  function stop() {
    if (_openSkyTimer) { clearInterval(_openSkyTimer); _openSkyTimer = null; }
    if (_suppTimer)    { clearInterval(_suppTimer);    _suppTimer    = null; }
    aircraftLiveCache.clear();
    _enabled = false;
  }

  function status() {
    var openskyHealthy = _audit.openskyConsecutiveEmpty < 3;
    return {
      enabled:          _enabled,
      opensky: {
        healthy:          openskyHealthy,
        polls:            _audit.openskyPolls,
        ingested:         _audit.openskyIngested,
        errors:           _audit.openskyErrors,
        consecutiveEmpty: _audit.openskyConsecutiveEmpty,
        lastPollMs:       _audit.lastOpenSkyMs,
        inFlight:         _openSkyActive,
        lastErrorType:    _openSkyErrorType,
        workerVersion:    _openSkyWorkerV,
        workerUrl:        OPENSKY_WORKER,
      },
      supplemental: {
        polls:      _audit.suppPolls,
        ingested:   _audit.suppIngested,
        errors:     _audit.suppErrors,
        lastPollMs: _audit.lastSuppMs,
        inFlight:   _suppActive,
      },
      cacheSize:  aircraftLiveCache.size,
      skipped:    _audit.skipped,
      expired:    _audit.expired,
      lastError:  _audit.lastError,
    };
  }

  window.ArgusProviderCache = { start: start, stop: stop, status: status };

  // ── Auto-start ────────────────────────────────────────────────────────────────
  setTimeout(start, 0);

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusProviderCache');

}());
