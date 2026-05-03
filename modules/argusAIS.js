// modules/argusAIS.js
// AISstream Realtime Layer — WebSocket vessel tracking
// Extracted from index.html SCRIPT 4b. Zero logic changes.
// Dependencies (globals): window.THREE, window.ArgusGlobe, window._aisSprites,
//   window._argusShTex (set by argusTracking.js patchShTex shim)
// Public API: window.ArgusAIS

window.ArgusAIS = (function () {
'use strict';

// ── AISstream API key ──────────────────────────────────────────────────────────
// Key is fetched from /.netlify/functions/ais-config at runtime.
// Set AISSTREAM_KEY in Netlify → Site → Environment variables.
// Never hardcode it here — this file is committed to git.
var AISSTREAM_KEY = '';

// ── Config ─────────────────────────────────────────────────────────────────────
var AIS_OPACITY  = 0.92;   // matches VesselAPI — required for ArgusSelection dim/restore parity
var AIS_ALTITUDE = 101.3;  // must match R.AIS defined in globe init — no z-fighting with R.SHIP (101.5)
// Cap how many unique vessels we keep in memory. Oldest-updated get evicted
// once this limit is hit so the globe doesn't accumulate stale ghosts.
// 1500 supports ~1800 total between WebSocket stream + REST supplement.
var AIS_MAX_MARKERS = 1500;
// Interval between buffer drain + diff render passes.
// Ingest (onmessage → buffer.push) is uncapped; only rendering is rate-limited.
var AIS_RENDER_INTERVAL = 300; // ms — "real-time feel" without flooding the render loop
// Minimum meaningful change thresholds for diff-based rendering.
// Below these values the vessel sprite is NOT re-synced this tick, reducing churn.
var AIS_DIFF_LAT   = 0.0001; // ~11m at equator
var AIS_DIFF_LON   = 0.0001;
var AIS_DIFF_HDG   = 2;      // degrees

// ── State ──────────────────────────────────────────────────────────────────────
var aisGroup   = null;      // THREE.Group containing all AIS sprites
var aisMarkers  = new Map(); // mmsi → { sprite, updatedAt }
var _aisSprites = [];        // flat sprite array — mirrors aisMarkers, consumed by raycasters
var aisOn       = true;      // default ON (button initialised is-active)
var wsAIS       = null;     // live WebSocket to wss://stream.aisstream.io
var reconnTimer = null;     // reconnect timeout handle
var _aisMsgCount = 0;       // diagnostic counter — how many WS messages received

// Expose for console inspection and raycaster access
window._aisMarkers  = aisMarkers;
window._aisSprites  = _aisSprites;

// ── Diagnostics — all flags default to NO-OP, no behavior change unless set ──
// Access from console: ArgusAIS.diag  /  ArgusAIS.diagReport()
//
//   ArgusAIS.diag.freeze      = true   → pause all upsertAISMarker calls (freeze test)
//   ArgusAIS.diag.throttleMs  = 500    → skip updates arriving < 500ms since last update per vessel
//   ArgusAIS.diag.logEvictions= true   → log every eviction + warn if selected vessel evicted
//   ArgusAIS.diag.logRate     = true   → log update rate every 5 seconds
var _diag = {
  freeze:       false,  // Step 3A: freeze test — pauses all updates
  throttleMs:   0,      // Step 3B: throttle test — 0 = disabled, e.g. 500 = 500ms min/vessel
  logEvictions: false,  // Step 2/4: log evictions (set true before clicking a vessel to test)
  logRate:      false,  // Step 1: periodically log updates/sec
  // ── Internal counters (read-only from console) ──
  updateCount:  0,      // upserts that hit an EXISTING sprite (object identity stable)
  createCount:  0,      // upserts that CREATED a new sprite
  evictCount:   0,      // total evictions
  evictWhileLocked: 0,  // evictions where scale suggests vessel was selected
  _rateSamples: [],     // rolling timestamps for rate calculation
  _rateLogTimer: null,
};

// ── State layer ───────────────────────────────────────────────────────────────
// _aisState is the source of truth for vessel data; aisMarkers holds the sprites.
// Architecture:
//   onmessage → _ingestBuffer.push()           (fast, sync, no state write)
//   setInterval → _processAndRender()          (controlled, 300ms)
//     ├─ drain _ingestBuffer                   (normalize + diff)
//     ├─ write _aisState.vessels               (state store)
//     ├─ mark _dirtyVessels                    (only truly changed MMSIs)
//     └─ renderAIS()                           (sprite sync, O(dirty))
var _aisState = {
  vessels:          new Map(),  // mmsi → { name, lat, lon, heading, velocity, shipType, navStatus, updatedAt }
  selectedVesselId: null,       // mmsi of currently locked vessel — set by scale-scan after each render
};
var _ingestBuffer = [];         // raw normalized vessel objects pushed by handleAISMessage
var _dirtyVessels = new Set();  // MMSIs that actually changed and need sprite sync this tick

// AIS vessel type codes (ITU-R M.1371-5) → color hex
// NavStatus 0 = under way, 1 = at anchor, 5 = moored
function aisColor(shipType) {
  var map = {
    cargo: 0x4488ff, tanker: 0xff9933, military: 0xff4444,
    passenger: 0xffffff, fishing: 0x44cc88, tug: 0xffcc44,
    port_service: 0xaaaaaa, recreational: 0xcc88ff,
    other: 0x14b8a6, unknown: 0x888888,
  };
  var t = (shipType || 'other').toLowerCase();
  return map[t] !== undefined ? map[t] : map.other;
}

// Classify the raw AIS numeric ship-type code into our category strings.
// Mirrors classifyVessel() in fetch-vessels.js — kept in sync manually.
function classifyAISType(rawType) {
  var n = parseInt(rawType, 10);
  if (isNaN(n) || n <= 0) return 'other';
  if (n === 35)                  return 'military';
  if (n === 30)                  return 'fishing';
  if (n === 31 || n === 32 || n === 52) return 'tug';
  if (n === 36 || n === 37)      return 'recreational';
  if (n >= 50 && n <= 59)        return 'port_service';
  if (n >= 60 && n <= 69)        return 'passenger';
  if (n >= 70 && n <= 79)        return 'cargo';
  if (n >= 80 && n <= 89)        return 'tanker';
  return 'unknown';
}

// ── Init — create the AIS THREE.Group once ArgusGlobe is ready ────────────────
function ensureGroup() {
  var AG = window.ArgusGlobe;
  if (!AG || !AG.eventMarkerGroup || !AG.latLonToVector) return false;
  if (!aisGroup) {
    aisGroup         = new THREE.Group();
    aisGroup.name    = 'ArgusAIS';
    aisGroup.visible = aisOn;
    AG.eventMarkerGroup.add(aisGroup);
  }
  return true;
}

// ── Fast ingest — synchronous buffer push, zero state writes ─────────────────
// Called by handleAISMessage for every decoded WS message.
// Normalization is minimal (just validate + type-cast); diff/state write is deferred
// to _processAndRender() so the WS thread is never blocked by render work.
function updateVesselState(mmsi, name, lat, lon, heading, velocity, shipType, navStatus) {
  _ingestBuffer.push({ mmsi: mmsi, name: name, lat: lat, lon: lon,
    heading: heading, velocity: velocity, shipType: shipType, navStatus: navStatus });
}

// ── Controlled render tick — runs every AIS_RENDER_INTERVAL ms ───────────────
// Drains _ingestBuffer, diffs each entry against _aisState.vessels, writes state,
// marks _dirtyVessels for entries that meaningfully changed, then calls renderAIS().
// Diagnostic gates and rate sampling live here (not in ingest or sprite paths).
function _processAndRender() {
  if (!_ingestBuffer.length) return;

  // Drain the entire buffer in one pass — most recent value per MMSI wins naturally
  // because we overwrite state on each write (Map.set is idempotent by key).
  var batch = _ingestBuffer.splice(0, _ingestBuffer.length);

  // ── Diagnostic freeze gate ────────────────────────────────────────────────
  if (_diag.freeze) return;

  var now = Date.now();

  for (var i = 0; i < batch.length; i++) {
    var v    = batch[i];
    var mmsi = v.mmsi;

    // ── Throttle gate (per-vessel min interval) ───────────────────────────
    if (_diag.throttleMs > 0 && _aisState.vessels.has(mmsi)) {
      if (now - _aisState.vessels.get(mmsi).updatedAt < _diag.throttleMs) continue;
    }

    // ── Rate sampling ─────────────────────────────────────────────────────
    _diag._rateSamples.push(now);
    if (_diag._rateSamples.length > 2000) {
      var _cutoff = now - 10000;
      var _si = 0;
      while (_si < _diag._rateSamples.length && _diag._rateSamples[_si] < _cutoff) _si++;
      if (_si > 0) _diag._rateSamples.splice(0, _si);
    }

    // ── Diff check — only mark dirty if the vessel actually moved/changed ─
    // New vessels are always dirty. Existing vessels only if position or
    // heading changed beyond the threshold, or name/type changed.
    var existing = _aisState.vessels.get(mmsi);
    var dirty;
    if (!existing) {
      dirty = true;
      _diag.createCount++;
    } else {
      _diag.updateCount++;
      dirty = (
        Math.abs(v.lat     - existing.lat)     > AIS_DIFF_LAT ||
        Math.abs(v.lon     - existing.lon)     > AIS_DIFF_LON ||
        (v.heading != null && existing.heading != null &&
          Math.abs(v.heading - existing.heading) > AIS_DIFF_HDG) ||
        // null ↔ value transitions always count as changed
        (v.heading == null) !== (existing.heading == null) ||
        v.name     !== existing.name ||
        v.shipType !== existing.shipType
      );
    }

    // ── Write to state (always — keep timestamps + velocity current) ──────
    _aisState.vessels.set(mmsi, {
      name: v.name, lat: v.lat, lon: v.lon,
      heading: v.heading, velocity: v.velocity,
      shipType: v.shipType, navStatus: v.navStatus,
      updatedAt: now,
    });

    if (dirty) _dirtyVessels.add(mmsi);
  }

  renderAIS();

  // ── Selection tracking — scan sprite scales to keep selectedVesselId current ─
  // ArgusSelection highlights the locked sprite to scale ~1.29 (0.89 × 1.45); normal is 0.89.
  // We read this externally rather than patching ArgusSelection internals.
  var foundSelected = false;
  aisMarkers.forEach(function (entry, mmsi) {
    if (entry.sprite.scale.x > 1.2) {
      _aisState.selectedVesselId = mmsi;
      foundSelected = true;
    }
  });
  if (!foundSelected) _aisState.selectedVesselId = null;
}

// ── renderAIS — syncs dirty vessel state → THREE sprites ─────────────────────
// Internal path (no arg): iterates _dirtyVessels only — O(changed) not O(all).
// External path (array arg): accepts [{mmsi, name, lat, lon, ...}] from callers
// that bypass the state layer (e.g. test harness).
function renderAIS(externalVessels) {
  if (externalVessels) {
    externalVessels.forEach(function (v) {
      upsertAISMarker(v.mmsi, v.name, v.lat, v.lon, v.heading, v.velocity, v.shipType, v.navStatus);
    });
    return;
  }
  _dirtyVessels.forEach(function (mmsi) {
    var v = _aisState.vessels.get(mmsi);
    if (!v) return;
    upsertAISMarker(mmsi, v.name, v.lat, v.lon, v.heading, v.velocity, v.shipType, v.navStatus);
  });
  _dirtyVessels.clear();
}

// ── Pure sprite-sync — no gates, no diagnostics, just THREE.js ───────────────
function upsertAISMarker(mmsi, name, lat, lon, heading, velocity, shipType, navStatus) {
  if (!ensureGroup()) return;
  if (lat == null || lon == null) return;
  if (lat === 0 && lon === 0)    return;

  var shTex = window._argusShTex;
  if (!shTex) {
    console.warn('[ArgusAIS] upsertAISMarker: _argusShTex not ready — marker dropped for', mmsi);
    return;
  }

  var AG     = window.ArgusGlobe;
  var cogRad = (heading != null && !isNaN(heading)) ? -heading * Math.PI / 180 : 0;
  var tc     = classifyAISType(shipType);
  var label  = (name || '').trim() || String(mmsi) || 'AIS VESSEL';
  var now    = Date.now();

  if (aisMarkers.has(mmsi)) {
    var entry  = aisMarkers.get(mmsi);
    var sprite = entry.sprite;
    sprite.position.copy(AG.latLonToVector(lat, lon, AIS_ALTITUDE));
    sprite.material.rotation = cogRad;
    sprite.material.color.setHex(aisColor(tc));
    sprite.userData.lat       = lat;
    sprite.userData.lon       = lon;
    sprite.userData.heading   = heading;
    sprite.userData.velocity  = velocity;
    sprite.userData.navStatus = navStatus;
    sprite.userData.title     = label;
    entry.updatedAt = now;
  } else {
    // Evict oldest entry if we're at the cap
    if (aisMarkers.size >= AIS_MAX_MARKERS) evictOldest();

    var pos = AG.latLonToVector(lat, lon, AIS_ALTITUDE);
    var mat = new THREE.SpriteMaterial({
      map:         shTex,
      color:       new THREE.Color(aisColor(tc)),
      transparent: true,
      opacity:     AIS_OPACITY,
      rotation:    cogRad,
      depthTest:   false,
    });
    var sprite = new THREE.Sprite(mat);
    sprite.position.copy(pos);
    sprite.scale.set(0.89, 0.89, 1);
    sprite.userData = {
      isShip:       true,       // enables canInteract(), click routing, ArgusSelection
      isAISVessel:  true,       // source tag — keeps AIS identity without breaking anything
      title:        label,
      type:         'VESSEL',   // matches VesselAPI type — selection panel icon + detail
      typeCategory: tc,
      severity:     'LOW',
      source:       'aisstream',
      lat: lat, lon: lon,
      mmsi:         mmsi,
      heading:      heading,
      velocity:     velocity,
      navStatus:    navStatus,
    };
    aisGroup.add(sprite);
    aisMarkers.set(mmsi, { sprite: sprite, updatedAt: now });
    _aisSprites.push(sprite);   // register in flat array for raycasters + ArgusSelection
  }
}

function evictOldest() {
  // Find the oldest NON-SELECTED vessel. Evicting the selected vessel would
  // invalidate ArgusSelection._locked (stale sprite ref → auto-unlock next tick).
  // If somehow every vessel is selected (impossible in practice), fall back to oldest.
  var oldest = null, oldestTime = Infinity;
  var oldestFallback = null, oldestTimeFallback = Infinity;
  aisMarkers.forEach(function(entry, mmsi) {
    // Track overall oldest (fallback)
    if (entry.updatedAt < oldestTimeFallback) {
      oldestTimeFallback = entry.updatedAt;
      oldestFallback = mmsi;
    }
    // Skip the currently selected vessel for normal eviction
    if (mmsi === _aisState.selectedVesselId) return;
    if (entry.updatedAt < oldestTime) { oldestTime = entry.updatedAt; oldest = mmsi; }
  });
  // If all vessels are somehow selected, fall back to true oldest
  if (oldest === null) oldest = oldestFallback;
  if (oldest !== null) {
    var _evSprite = aisMarkers.get(oldest).sprite;

    // ── Diagnostic: eviction logging (Step 2/4) ────────────────────────────
    // A highlighted sprite has scale ~1.29 (BASE_SCALE_SH 0.89 × HIGHLIGHT_SCALE 1.45).
    // Normal scale is 1.05. If scale > 1.2 we're likely evicting the selected vessel,
    // which WILL cause ArgusSelection.tick() → unlock() on the next frame.
    // This is the primary suspected breakage vector for click/selection loss.
    _diag.evictCount++;
    if (_diag.logEvictions || _evSprite.scale.x > 1.2) {
      var _evSc   = _evSprite.scale.x.toFixed(3);
      var _evOp   = _evSprite.material ? _evSprite.material.opacity.toFixed(3) : '?';
      var _locked = _evSprite.scale.x > 1.2;
      if (_locked) {
        _diag.evictWhileLocked++;
        console.warn('[AISDebug] ⚠ EVICTING SELECTED VESSEL — this WILL break selection state!',
          'MMSI=' + oldest, 'scale=' + _evSc, 'opacity=' + _evOp,
          '| Total locked-evictions:', _diag.evictWhileLocked);
      } else if (_diag.logEvictions) {
        console.log('[AISDebug] evict MMSI=' + oldest,
          'scale=' + _evSc, 'opacity=' + _evOp, '(normal — not selected)');
      }
    }

    aisGroup.remove(_evSprite);
    aisMarkers.delete(oldest);
    var _evIdx = _aisSprites.indexOf(_evSprite);
    if (_evIdx !== -1) _aisSprites.splice(_evIdx, 1);  // keep flat array in sync
    _aisState.vessels.delete(oldest);  // keep state layer in sync
    _dirtyVessels.delete(oldest);      // cancel any pending sprite sync for this MMSI
  }
}

// ── Toggle ─────────────────────────────────────────────────────────────────────
function toggle() {
  aisOn = !aisOn;
  if (aisGroup) aisGroup.visible = aisOn;
  if (window.ArgusLayerState) window.ArgusLayerState.aisVessels = aisOn;  // keeps canInteract() + raycasters in sync
  var btn = document.getElementById('btn-track-ais');
  if (btn) {
    if (aisOn) btn.classList.add('is-active');
    else       btn.classList.remove('is-active');
  }
}

// ── AISstream WebSocket — direct browser connection ───────────────────────────
// No edge function, no Supabase table, no Realtime subscription.
// Messages go: AISstream → browser WebSocket → upsertAISMarker → THREE globe.
function connectAISStream() {
  if (!AISSTREAM_KEY) {
    // Key not fetched yet — retrieve from Netlify config endpoint then connect
    fetch('/.netlify/functions/ais-config')
      .then(function(r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function(cfg) {
        if (!cfg.key) {
          console.warn('[ArgusAIS] ais-config returned empty key — set AISSTREAM_KEY in Netlify env vars');
          return;
        }
        AISSTREAM_KEY = cfg.key;
        connectAISStream(); // retry now that we have the key
      })
      .catch(function(err) {
        console.warn('[ArgusAIS] could not fetch ais-config:', err);
      });
    return;
  }
  if (wsAIS) {
    try { wsAIS.close(); } catch(e) {}
    wsAIS = null;
  }

  console.log('[ArgusAIS] connecting to AISstream…');
  var ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
  wsAIS  = ws;

  // ── Message queue — decouples async Blob.text() from the render loop ──────────
  // AISstream sends binary frames. The browser delivers them as Blob objects.
  // We cannot force string mode from the client when the server sends binary.
  // Strategy: push raw data onto a queue in the sync onmessage handler,
  // then drain the queue asynchronously so Blob.text() never blocks rAF.
  var _msgQueue  = [];
  var _queueBusy = false;

  function processQueue() {
    if (_queueBusy || _msgQueue.length === 0) return;
    _queueBusy = true;

    // Shift one item, resolve it to a string, then recurse
    var data = _msgQueue.shift();
    var p;
    if (data instanceof Blob)        p = data.text();
    else if (data instanceof ArrayBuffer) p = Promise.resolve(new TextDecoder().decode(data));
    else                             p = Promise.resolve(String(data));

    p.then(function (text) {
      var msg;
      try { msg = JSON.parse(text); } catch(e) {
        console.warn('[ArgusAIS] JSON parse fail:', e.message, text.slice(0, 80));
        _queueBusy = false;
        // Use setTimeout instead of direct recursion — direct recursion inside a
        // .then() microtask chains ALL queued messages into one uninterrupted
        // microtask checkpoint, which can run 100+ ms and trips LONG_TASK warnings.
        // setTimeout(fn, 0) yields to the browser between each message (~1 macrotask
        // per message) so no single task exceeds ~2 ms.
        if (_msgQueue.length) setTimeout(processQueue, 0);
        return;
      }

      _aisMsgCount++;
      if (_aisMsgCount === 1) {
        console.log('[ArgusAIS] first message decoded:', JSON.stringify(msg).slice(0, 400));
      }
      if (_aisMsgCount % 500 === 0) {
        console.log('[ArgusAIS] messages processed:', _aisMsgCount, '| markers:', aisMarkers.size);
      }

      handleAISMessage(msg);

      _queueBusy = false;
      if (_msgQueue.length) setTimeout(processQueue, 0);
    });
  }

  function handleAISMessage(msg) {
    var meta   = msg.MetaData   || {};
    var report = (msg.Message && msg.Message.PositionReport) || {};

    var lat = meta.latitude  != null ? meta.latitude  : report.Latitude;
    var lon = meta.longitude != null ? meta.longitude : report.Longitude;
    if (lat == null || lon == null) return;
    if (lat === 0   && lon === 0)   return;

    var mmsi = String(meta.MMSI || meta.UserId || report.UserID || '');
    if (!mmsi) return;

    // ── Noise filter: skip low-intel-value vessel types ───────────────────
    // These burn marker slots without adding geopolitical signal.
    // Kept: fishing (30) — illegal fishing in contested waters has intel value.
    // Kept: tugs (31,32,52) — port-activity indicator.
    var _stn = parseInt(report.ShipType, 10);
    if (!isNaN(_stn)) {
      if (_stn === 36 || _stn === 37) return; // pleasure craft / yacht
      if (_stn === 50) return;                 // pilot vessel
      if (_stn === 51) return;                 // SAR vessel
      if (_stn === 53) return;                 // port tender
      if (_stn === 54) return;                 // anti-pollution vessel
    }

    var th  = report.TrueHeading;
    var hdg = (th != null && th !== 511) ? th : (report.Cog != null ? report.Cog : null);

    updateVesselState(
      mmsi,
      meta.ShipName || '',
      lat,
      lon,
      hdg,
      report.Sog != null ? report.Sog : null,
      report.ShipType != null ? report.ShipType : null,
      report.NavigationalStatus != null ? report.NavigationalStatus : null
    );
  }

  ws.onopen = function () {
    console.log('[ArgusAIS] AISstream connected — subscribing (10 strategic regions)');
    // 10 strategic maritime regions instead of global bbox.
    // Global bbox skews heavily toward European AIS receivers; regional targeting
    // gives proportional coverage of high-value corridors: Suez, Malacca, Persian
    // Gulf, South China Sea, Panama — where geopolitical intelligence density is highest.
    // Format: [[minLat, minLon], [maxLat, maxLon]]
    ws.send(JSON.stringify({
      APIKey: AISSTREAM_KEY,
      BoundingBoxes: [
        [[ 50, -10], [ 70,  30]],  // North Sea & Baltic      (300 est.)
        [[ 30,  -6], [ 46,  36]],  // Mediterranean           (250)
        [[ 12,  32], [ 32,  50]],  // Suez Canal & Red Sea    (200) ← chokepoint
        [[ -2,  95], [  8, 110]],  // Strait of Malacca       (200) ← busiest strait
        [[  5, -85], [ 25, -60]],  // Panama Canal & Caribbean(150)
        [[ 23,  48], [ 30,  60]],  // Persian Gulf            (150) ← energy
        [[  0, 105], [ 25, 125]],  // South China Sea         (150) ← contested
        [[-12,  35], [ 15,  55]],  // East Africa & Horn      (100) ← piracy
        [[ 30, -60], [ 60, -10]],  // North Atlantic          (150)
        [[ 20,-135], [ 50,-115]],  // US West Coast & Pacific (150)
      ],
      FilterMessageTypes: ['PositionReport'],
    }));
  };

  ws.onmessage = function (evt) {
    _msgQueue.push(evt.data);
    processQueue();
  };

  ws.onerror = function () {
    console.warn('[ArgusAIS] WebSocket error — will reconnect');
  };

  ws.onclose = function (e) {
    console.warn('[ArgusAIS] AISstream disconnected (code ' + e.code + ') — reconnecting in 5 s');
    wsAIS = null;
    if (reconnTimer) clearTimeout(reconnTimer);
    reconnTimer = setTimeout(connectAISStream, 5000);
  };
}

// ── Bootstrap — wait for globe + texture, then open AISstream WebSocket ───────
(function bootstrap() {
  var attempts = 0;
  var timer = setInterval(function () {
    attempts++;
    if (ensureGroup() && window._argusShTex) {
      clearInterval(timer);

      // ── Feature parity: hook AIS sprites into all interaction systems ──────
      //
      // window._vesselMarkers getter — merges shipHits (VesselAPI) + AIS sprites.
      // Every system that reads this array gets both sources automatically:
      //   • Hover _frustumFilter (line 4463)
      //   • Click raycast target list (line 4529)
      //   • ArgusSelection._all() (line 18503) → dim / highlight / ring
      //   • renderShips() sets it via assignment → our setter captures shipHits
      //
      // IMPORTANT: renderShips() does `window._vesselMarkers = shipHits` each fetch.
      // The setter captures that array; the getter merges it with live aisMarkers
      // so neither fetch cycle nor AIS update needs to know about each other.
      (function patchVesselMarkers() {
        var _vmsBase = window._vesselMarkers || [];
        Object.defineProperty(window, '_vesselMarkers', {
          get: function () {
            var out = _vmsBase.slice();
            aisMarkers.forEach(function (e) { out.push(e.sprite); });
            return out;
          },
          set: function (v) { _vmsBase = v || []; },
          configurable: true,
        });
        console.log('[ArgusAIS] _vesselMarkers getter installed — AIS sprites now visible to hover/click/selection');
      }());

      // ── Feature parity: include AIS vessels in window._trackingData ────────
      //
      // normalizeTracking() (inside ArgusTracking closure) writes aircraft + VesselAPI
      // vessels to window._trackingData via direct assignment.  We intercept with
      // get/set: set captures normalizeTracking's output; get appends live AIS entries.
      // Result: any downstream consumer that reads _trackingData gets all three sources.
      (function patchTrackingData() {
        var _tdBase = window._trackingData || [];
        Object.defineProperty(window, '_trackingData', {
          get: function () {
            var ts = Date.now();
            var aisEntries = [];
            aisMarkers.forEach(function (entry, mmsi) {
              var ud = entry.sprite.userData;
              aisEntries.push({
                id:           'ais-' + mmsi,
                type:         'vessel',
                typeCategory: ud.typeCategory || 'other',
                lat:          ud.lat,
                lon:          ud.lon,
                velocity:     ud.velocity,
                heading:      ud.heading,
                label:        ud.title,
                source:       'aisstream',
                mmsi:         mmsi,
                timestamp:    ts,
              });
            });
            return _tdBase.concat(aisEntries);
          },
          set: function (v) { _tdBase = v || []; },
          configurable: true,
        });
        console.log('[ArgusAIS] _trackingData getter installed — AIS vessels included in analytics feed');
      }());

      // ── Start controlled render interval ────────────────────────────────
      // _processAndRender drains _ingestBuffer, diffs state, and calls renderAIS().
      // This is the ONLY place sprites are updated — ingest path just pushes to buffer.
      setInterval(_processAndRender, AIS_RENDER_INTERVAL);
      console.log('[ArgusAIS] render interval started (' + AIS_RENDER_INTERVAL + 'ms)');

console.log('[ArgusAIS] globe ready — opening AISstream WebSocket');
      connectAISStream();
    } else if (attempts > 150) {
      clearInterval(timer);
      console.warn('[ArgusAIS] timed out waiting for globe — AISstream not started');
    }
  }, 200);
}());

// ── Diagnostic report (Step 1 + 7) ────────────────────────────────────────────
// Call ArgusAIS.diagReport() from the browser console at any time.
function diagReport() {
  var now      = Date.now();
  var s1  = _diag._rateSamples.filter(function(t) { return now - t <  1000; }).length;
  var s5  = _diag._rateSamples.filter(function(t) { return now - t <  5000; }).length;
  var s10 = _diag._rateSamples.filter(function(t) { return now - t < 10000; }).length;

  var total = _diag.updateCount + _diag.createCount;
  var hitPct = total ? (((_diag.updateCount / total) * 100).toFixed(1) + '%') : '—';

  console.group('%c[ArgusAIS Diagnostic]', 'color:#00ff88;font-weight:bold');
  console.log('── Step 1: Update Rate ──────────────────────────────');
  console.log('  Current (last 1s)  :', s1,  'updates/sec');
  console.log('  Avg     (last 5s)  :', (s5 / 5).toFixed(1), 'updates/sec');
  console.log('  Avg     (last 10s) :', (s10 / 10).toFixed(1), 'updates/sec');
  console.log('  Total processed    :', total);
  console.log('');
  console.log('── Step 4: Object Identity ─────────────────────────');
  console.log('  Updates (existing sprite)  :', _diag.updateCount, '— object identity STABLE ✓');
  console.log('  Creations (new sprite)     :', _diag.createCount);
  console.log('  Sprite hit rate            :', hitPct, '(high = mostly in-place updates)');
  console.log('  Active AIS markers         :', aisMarkers.size, '/', AIS_MAX_MARKERS);
  console.log('');
  console.log('── Step 2: Selection State ─────────────────────────');
  console.log('  Total evictions            :', _diag.evictCount);
  console.log('  Evictions of selected(⚠)  :', _diag.evictWhileLocked,
    _diag.evictWhileLocked > 0 ? ' ← ROOT CAUSE CONFIRMED' : ' ← OK so far');
  console.log('');
  console.log('── Step 3: Freeze / Throttle Controls ──────────────');
  console.log('  ArgusAIS.diag.freeze      = true/false  → pause all updates (freeze test)');
  console.log('  ArgusAIS.diag.throttleMs  = 500         → 500ms min between vessel updates');
  console.log('  ArgusAIS.diag.throttleMs  = 0           → no throttle (default)');
  console.log('  ArgusAIS.diag.logEvictions= true        → log every eviction in real-time');
  console.groupEnd();
}

// ── Public API ─────────────────────────────────────────────────────────────────
return {
  toggle:     toggle,
  reconnect:  connectAISStream,
  markers:    aisMarkers,
  diag:       _diag,
  diagReport: diagReport,
  renderAIS:  renderAIS,          // external render: ArgusAIS.renderAIS([{mmsi,…}])
  state:      _aisState,          // live data store: ArgusAIS.state.vessels.get(mmsi)
  // Diagnostic helpers
  flush:      _processAndRender,  // ArgusAIS.flush() — force immediate process+render tick
  get bufferSize() { return _ingestBuffer.length; }, // ArgusAIS.bufferSize — pending messages
};

}());
