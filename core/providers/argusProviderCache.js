'use strict';
// core/providers/argusProviderCache.js
// Aircraft supplemental telemetry provider — OpenSky Network (additive, aircraft only).
//
// Architecture:
//   PURELY ADDITIVE. Injects aircraft that are absent from the primary fetch-traffic
//   snapshot. Never alters, overrides, or replaces primary data.
//   AISstream remains the sole realtime vessel provider — no vessel fallback here.
//
// Poll modes (ENABLE_BROWSER_OPENSKY flag):
//   true  — browser-direct: browser polls OpenSky REST API with viewport bounds.
//             Bypasses Netlify/AWS infrastructure that OpenSky blocks. 5 min interval.
//   false — netlify-proxy: browser calls /.netlify/functions/fetch-opensky. 3 min interval.
//             Used when browser-direct is disabled or unavailable.
//
// Browser-direct auth:
//   Anonymous by default (400 req/day limit; 5 min interval → ~288 req/day — within limit).
//   Optional Basic Auth via window.ARGUS_OPENSKY_CREDS = { user: '...', pass: '...' }.
//   Set this from the browser console or a git-excluded local config script.
//   NEVER hardcode credentials directly in this file.
//
// Viewport bounds:
//   _getViewportBounds() derives a ±30° lat/lon box from the globe's current rotation
//   (window.ArgusGlobe.globeGroup.rotation). This constrains each poll to the region
//   the user is actively viewing, reducing API pressure and response payload size.
//
// Vessel strategy:
//   AISstream WebSocket is the only vessel telemetry source. Future vessel additions
//   should target metadata enrichment — NOT additional AIS streams.
//
// Aircraft staleness model:
//   An ICAO24 is considered absent if it is not in the current primary snapshot.
//   window._argusCurrentIcao24s (a Set) is populated by renderAircraft() on each
//   render pass. OpenSky entries whose ICAO24 is in that Set are silently skipped.
//
// Injection path:
//   OpenSky poll → normalize → filter by _argusCurrentIcao24s → write to aircraftLiveCache.
//   renderAircraft() reads window._argusProviderAircraft (live reference to aircraftLiveCache)
//   and appends absent ICAO24s before processing — zero allocation on cache hit.
//
// Cache:
//   aircraftLiveCache  Map<icao24, normalizedAircraftRecord>  — live, mutated in place.
//   Diff-updated each poll cycle. renderAircraft() reads it by reference between polls.
//
// Console policy: silent at steady state. ArgusProviderCache.status() for diagnostics.
//
// Dependencies:
//   window._argusReqCache    — deduped fetch infrastructure (netlify-proxy path only)
//   window.ArgusGlobe        — globe rotation for viewport bounds (browser-direct path)
//   window.ArgusModuleAudit  — optional
//
// Load order: after argusAIS.js and argusTracking.js (last two scripts in body)

(function () {
  'use strict';

  // ── Config ───────────────────────────────────────────────────────────────────
  var OPENSKY_FN           = '/.netlify/functions/fetch-opensky';    // unused — Netlify IPs are blocked by OpenSky
  var OPENSKY_POLL         = 3 * 60 * 1000;   // 3 min  — netlify-proxy path (unused)
  // adsb.lol via Cloudflare Worker proxy (adds CORS headers).
  // Worker URL: opensky-proxy.aidanhurley12.workers.dev
  // Backend: api.adsb.lol — same source as fetch-traffic, no key required.
  var ADSB_WORKER_BASE     = 'https://opensky-proxy.aidanhurley12.workers.dev';
  var ADSB_DIST_NM         = 250;             // max radius supported by adsb.fi
  var OPENSKY_BROWSER_POLL = 5 * 60 * 1000;   // 5 min — well within adsb.fi rate limits
  var OPENSKY_BOX_PAD      = 30;              // used only by _getViewportCenter for lat/lon
  var ENABLE_BROWSER_OPENSKY = true;          // Cloudflare Worker path (no CORS/IP issues)
  var MAX_INJECT           = 200;             // hard ceiling: cache never exceeds this count
  var _pollInterval        = ENABLE_BROWSER_OPENSKY ? OPENSKY_BROWSER_POLL : OPENSKY_POLL;
  var STALE_MS             = _pollInterval * 3; // force-evict after 3 missed cycles

  // ── Live aircraft cache ──────────────────────────────────────────────────────
  // Canonical Map<icao24, normalizedRecord>. Populated by poll functions.
  // Consumed by renderAircraft() via window._argusProviderAircraft (live reference).
  // Mutated in place each cycle — entries are set() / clear(), not array push/splice.
  var aircraftLiveCache = new Map(); // icao24 → { icao24, callsign, lat, lon, track, gs, alt, flightType, stale, source }

  // ── Audit ────────────────────────────────────────────────────────────────────
  var _audit = {
    polls: 0, injected: 0, skipped: 0, expired: 0, lastPollMs: 0, lastError: null,
  };

  // ── State ────────────────────────────────────────────────────────────────────
  var _openskyTimer      = null;
  var _enabled           = true;
  var _browserPollActive = false; // in-flight guard — prevents overlapping browser requests

  // ── Aircraft staleness check ─────────────────────────────────────────────────
  function _isPrimaryAbsent(icao24) {
    var primary = window._argusCurrentIcao24s;
    if (!primary || !primary.size) return true; // no primary data yet — inject conservatively
    return !primary.has(icao24);
  }

  // ── adsb.lol record normalization ─────────────────────────────────────────────
  // adsb.lol returns ADSBexchange v2 format objects (not OpenSky array format).
  // Key fields: hex (icao24), flight (callsign), lat, lon, alt_baro (ft),
  //             gs (knots), track (deg), on_ground (bool).
  var _CARGO_PFX = ['FDX', 'UPS', 'CLX', 'GTI', 'ABX'];
  var _MIL_PFX   = ['RCH', 'BAF', 'RAF', 'AMC', 'NAV'];
  var _COMM_PFX  = ['DAL', 'UAL', 'AAL', 'SWA', 'BAW', 'AFR', 'KLM'];

  function _classifyFlight(callsign, altFt) {
    var pfx = (callsign || '').trim().slice(0, 3).toUpperCase();
    if (_MIL_PFX.indexOf(pfx)   >= 0) return 'military';
    if (_CARGO_PFX.indexOf(pfx) >= 0) return 'cargo';
    if (_COMM_PFX.indexOf(pfx)  >= 0) return 'commercial';
    if (altFt != null && altFt > 20000) return 'commercial';
    return 'unknown';
  }

  function _normalizeAdsbLol(ac) {
    if (!ac || typeof ac !== 'object') return null;
    var icao24 = String(ac.hex || '').trim().toLowerCase();
    if (!icao24) return null;
    if (ac.on_ground) return null;           // skip ground traffic
    var lat = ac.lat;
    var lon = ac.lon;
    if (lat == null || lon == null || !isFinite(lat) || !isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    var callsign = (ac.flight || '').trim() || null;
    // alt_baro is already in feet; fall back to alt_geom
    var altFt = ac.alt_baro != null ? ac.alt_baro : (ac.alt_geom != null ? ac.alt_geom : null);
    if (typeof altFt === 'string') altFt = null; // 'ground' string sentinel
    var gs    = ac.gs    != null ? Math.round(ac.gs)    : null;
    var track = ac.track != null ? ac.track             : null;
    return {
      icao24:     icao24,
      callsign:   callsign,
      lat:        lat,
      lon:        lon,
      track:      track,
      gs:         gs,
      alt:        altFt != null ? Math.round(altFt) : null,
      flightType: _classifyFlight(callsign, altFt),
      stale:      false,
      source:     'adsb.lol',
    };
  }

  // ── Viewport center ───────────────────────────────────────────────────────────
  // Returns { lat, lon } of the globe point currently facing the camera.
  // Math: camera sits at world (0,0,z). Apply inverse globe rotation to (0,0,1):
  //   M^-1*(0,0,1) = (-sin(ry)cos(rx), sin(rx), cos(ry)cos(rx))
  // Then lat = 90 - arccos(y)*r2d, lon from atan2(z,-x)*r2d - 180.
  function _getViewportCenter() {
    var ag = window.ArgusGlobe;
    if (!ag || !ag.globeGroup) return null;
    var rx = ag.globeGroup.rotation.x;
    var ry = ag.globeGroup.rotation.y;
    var lx = -Math.sin(ry) * Math.cos(rx);
    var ly =  Math.sin(rx);
    var lz =  Math.cos(ry) * Math.cos(rx);
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

  // ── Shared ingestion core ─────────────────────────────────────────────────────
  // Called by both _pollOpenSky (netlify-proxy) and _pollOpenSkyBrowser (direct).
  // aircraft: array of normalized records  { icao24, lat, lon, ... }
  // Diff-based update — never blind-clears the cache.
  function _ingestAircraftArray(aircraft) {
    if (!Array.isArray(aircraft)) return;
    var nowMs       = Date.now();
    var sizeAtStart = aircraftLiveCache.size;

    // ── Emergency guard: corrupt cache detection ─────────────────────────────
    if (aircraftLiveCache.size > MAX_INJECT * 2) {
      console.warn('[ArgusProviderCache] Cache inflated to', aircraftLiveCache.size,
        'entries — clearing. Investigate external writes to window.aircraftLiveCache.');
      aircraftLiveCache.clear();
    }

    // ── Step 1: Build capped, deduplicated incoming set ──────────────────────
    var incomingIds = new Set();
    var incoming    = [];
    for (var i = 0; i < aircraft.length; i++) {
      if (incoming.length >= MAX_INJECT) break;
      var ac = aircraft[i];
      if (!ac || !ac.icao24 || ac.lat == null || ac.lon == null) continue;
      if (incomingIds.has(ac.icao24)) continue;
      if (!_isPrimaryAbsent(ac.icao24)) continue;
      incomingIds.add(ac.icao24);
      incoming.push(ac);
    }

    // ── Step 2: Explicit stale expiration ────────────────────────────────────
    var expired = 0;
    aircraftLiveCache.forEach(function (entry, id) {
      var tooOld = (entry._cachedAt != null) && (nowMs - entry._cachedAt) > STALE_MS;
      if (!incomingIds.has(id) || tooOld) {
        aircraftLiveCache.delete(id);
        expired++;
      }
    });

    // ── Step 3: Diff upsert ──────────────────────────────────────────────────
    var created = 0;
    var updated = 0;
    for (var j = 0; j < incoming.length; j++) {
      var entry  = incoming[j];
      var exists = aircraftLiveCache.has(entry.icao24);
      entry._cachedAt = nowMs;
      aircraftLiveCache.set(entry.icao24, entry);
      if (exists) { updated++; } else { created++; }
    }

    // ── Step 4: Hard cap ─────────────────────────────────────────────────────
    if (aircraftLiveCache.size > MAX_INJECT) {
      var iter = aircraftLiveCache.keys();
      var trim = aircraftLiveCache.size - MAX_INJECT;
      for (var k = 0; k < trim; k++) aircraftLiveCache.delete(iter.next().value);
      console.warn('[ArgusProviderCache] HARD CAP — trimmed', trim, 'excess entries. Investigate write source.');
    }

    // ── Step 5: Cycle diagnostic ─────────────────────────────────────────────
    var delta = aircraftLiveCache.size - sizeAtStart;
    console.log(
      '[OpenSky Cycle]',
      'created:', created,
      '| updated:', updated,
      '| expired:', expired,
      '| cacheSize:', aircraftLiveCache.size,
      '| growthDelta:', (delta >= 0 ? '+' : '') + delta
    );

    _audit.injected   += created + updated;
    _audit.expired    += expired;
    _audit.lastPollMs  = nowMs;
    _audit.lastError   = null;
  }

  // ── Netlify-proxy poll ────────────────────────────────────────────────────────
  // Calls /.netlify/functions/fetch-opensky. Requires window._argusReqCache.
  // Blocked when OpenSky rejects AWS/Netlify IP ranges — use browser-direct mode instead.
  function _pollOpenSky() {
    if (!_enabled || !window._argusReqCache) return;
    _audit.polls++;

    window._argusReqCache.fetch(OPENSKY_FN)
      .then(function (json) {
        if (!json || !Array.isArray(json.aircraft)) return;
        _ingestAircraftArray(json.aircraft);
      })
      .catch(function (err) {
        _audit.lastError = err.message;
        // Silent failure — primary aircraft pipeline continues unaffected.
      });
  }

  // ── adsb.lol poll via Cloudflare Worker ──────────────────────────────────────
  // Worker proxies api.adsb.lol, adds CORS headers. No auth needed (open API).
  // Single in-flight guard prevents overlapping requests.
  function _pollOpenSkyBrowser() {
    if (!_enabled || _browserPollActive) return;
    _browserPollActive = true;
    _audit.polls++;

    var center = _getViewportCenter();
    var lat    = center ? center.lat.toFixed(2) : '0';
    var lon    = center ? center.lon.toFixed(2) : '0';
    var url    = ADSB_WORKER_BASE + '?lat=' + lat + '&lon=' + lon + '&dist=' + ADSB_DIST_NM;

    var controller = new AbortController();
    var timeoutId  = setTimeout(function () { controller.abort(); }, 20000);

    fetch(url, { headers: { 'Accept': 'application/json' }, signal: controller.signal })
      .then(function (resp) {
        clearTimeout(timeoutId);
        if (resp.status === 429) throw new Error('adsb.fi rate limit (429)');
        if (!resp.ok) throw new Error('adsb.fi HTTP ' + resp.status);
        return resp.json();
      })
      .then(function (json) {
        _browserPollActive = false;
        var records  = (json && Array.isArray(json.ac)) ? json.ac : [];
        var aircraft = [];
        for (var i = 0; i < records.length; i++) {
          var norm = _normalizeAdsbLol(records[i]);
          if (norm) { aircraft.push(norm); } else { _audit.skipped++; }
        }
        console.log('[ArgusProviderCache] adsb.lol raw:', records.length, '→ normalised:', aircraft.length);
        _ingestAircraftArray(aircraft);
      })
      .catch(function (err) {
        clearTimeout(timeoutId);
        _browserPollActive = false;
        _audit.lastError = err.message;
        // Silent failure — primary aircraft pipeline continues unaffected.
      });
  }

  // ── Publish globals ──────────────────────────────────────────────────────────
  // window._argusProviderAircraft  — live Map reference consumed by renderAircraft()
  // window._argusCurrentIcao24s    — Set populated by renderAircraft() for staleness checks
  // window.aircraftLiveCache       — canonical public name per architecture spec
  window._argusProviderAircraft = aircraftLiveCache;  // live reference — always current
  window._argusCurrentIcao24s   = new Set();          // populated by renderAircraft() on each pass
  window.aircraftLiveCache      = aircraftLiveCache;  // canonical alias

  // ── Start / stop ─────────────────────────────────────────────────────────────
  function start() {
    if (_openskyTimer) return; // already running

    if (ENABLE_BROWSER_OPENSKY) {
      // Cloudflare Worker path — Worker handles Basic Auth server-side.
      // No credential fetch needed; browser sends plain GET to Worker URL.
      setTimeout(_pollOpenSkyBrowser, 20 * 1000);
      _openskyTimer = setInterval(_pollOpenSkyBrowser, OPENSKY_BROWSER_POLL);
      console.log('[ArgusProviderCache] started — OpenSky browser-direct every',
        Math.round(OPENSKY_BROWSER_POLL / 60000), 'min');
    } else {
      // Netlify-proxy path — requires window._argusReqCache.
      setTimeout(_pollOpenSky, 20 * 1000);
      _openskyTimer = setInterval(_pollOpenSky, OPENSKY_POLL);
      console.log('[ArgusProviderCache] started — OpenSky Netlify proxy every',
        Math.round(OPENSKY_POLL / 60000), 'min');
    }
  }

  function stop() {
    if (_openskyTimer) { clearInterval(_openskyTimer); _openskyTimer = null; }
    aircraftLiveCache.clear();
    _enabled = false;
  }

  function status() {
    return {
      enabled:     _enabled,
      mode:        ENABLE_BROWSER_OPENSKY ? 'adsb.fi-worker' : 'netlify-proxy',
      cacheSize:   aircraftLiveCache.size,
      polls:       _audit.polls,
      injected:    _audit.injected,
      skipped:     _audit.skipped,
      expired:     _audit.expired,
      lastPollMs:  _audit.lastPollMs,
      lastError:   _audit.lastError,
      inFlight:    _browserPollActive,
    };
  }

  window.ArgusProviderCache = { start: start, stop: stop, status: status };

  // Auto-start — defer one tick so all modules complete init first.
  // Browser-direct mode does not need _argusReqCache; start unconditionally.
  // Netlify-proxy mode requires _argusReqCache — retry once after 3s if not ready.
  setTimeout(function () {
    if (ENABLE_BROWSER_OPENSKY) {
      start();
    } else if (window._argusReqCache) {
      start();
    } else {
      setTimeout(function () { if (window._argusReqCache) start(); }, 3000);
    }
  }, 0);

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusProviderCache');

}());
