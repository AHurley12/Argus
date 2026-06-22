// modules/argusAIS.js
// AISstream Realtime Layer — WebSocket vessel tracking
// Extracted from index.html SCRIPT 4b. Zero logic changes.
// Dependencies (globals): window.THREE, window.ArgusGlobe, window.ArgusEntityRegistry,
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
var AIS_DIM_F    = 0.12 / 0.92;  // ArgusSelection.CFG.DIM_OPACITY / AIS_OPACITY — keep in sync with ArgusSelection
var AIS_ALTITUDE = 101.3;  // must match R.AIS defined in globe init — no z-fighting with R.SHIP (101.5)
// Cap how many unique vessels we keep in memory. Longest-resident get evicted
// once this limit is hit so the globe doesn't accumulate stale ghosts.
// 4000 supports 28 regions × ~150 vessels average, with headroom for satellite AIS
// (mid-ocean vessels that update every 30–60 min via satellite pass).
var AIS_MAX_MARKERS = 4000;
// Interval between buffer drain + diff render passes.
// Ingest (onmessage → buffer.push) is uncapped; only rendering is rate-limited.
var AIS_RENDER_INTERVAL = 300; // ms — "real-time feel" without flooding the render loop
// Minimum meaningful change thresholds for diff-based rendering.
// Below these values the vessel sprite is NOT re-synced this tick, reducing churn.
var AIS_DIFF_LAT   = 0.0001; // ~11m at equator
var AIS_DIFF_LON   = 0.0001;
var AIS_DIFF_HDG   = 2;      // degrees

// Dead reckoning — extrapolates position for vessels not heard from recently.
// Satellite AIS revisit time is 45–90 min; without DR these vessels freeze in place.
// DR activates after AIS_DR_ACTIVATE_MS of silence and extrapolates up to AIS_DR_MAX_AGE_MS.
// Only vessels with a valid heading + SOG are extrapolated; anchored/slow vessels are skipped.
var AIS_DR_ACTIVATE_MS  = 120000;    // 2 min — start DR after 2 min with no update
var AIS_DR_MAX_AGE_MS   = 21600000;  // 6 hr  — drop DR after 6 hours of silence
var AIS_DR_MIN_SOG      = 0.5;       // knots — skip vessels that are effectively stationary
var AIS_DR_INTERVAL_MS  = 30000;     // 30 s  — re-extrapolate stale vessels every 30 seconds

// ── State ──────────────────────────────────────────────────────────────────────
var aisGroup    = null;      // THREE.Group containing all AIS sprites
var aisMarkers  = new Map(); // mmsi → { sprite, updatedAt }
var aisOn       = true;      // default ON (button initialised is-active)
var wsAIS       = null;     // live WebSocket to wss://stream.aisstream.io
var reconnTimer = null;     // reconnect timeout handle
var _aisMsgCount = 0;       // diagnostic counter — how many WS messages received

// Expose Map for console inspection. Sprite array access goes through ArgusEntityRegistry.
window._aisMarkers = aisMarkers;

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

var _processingInProgress = false; // re-entrancy guard for chunked batch processing

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
  selectedVesselId: null,       // mmsi of highlighted AIS vessel — set each render tick
  _prevSelectedId:  null,       // selectedVesselId from the previous tick — drives dim/scale sync
};
var _ingestBuffer = [];         // raw normalized vessel objects pushed by handleAISMessage
var _dirtyVessels = new Set();  // MMSIs that actually changed and need sprite sync this tick
var _staticCache  = new Map();  // mmsi → {shipType, name} from ShipStaticData messages

// AIS vessel type codes (ITU-R M.1371-5) → color hex
// NavStatus 0 = under way, 1 = at anchor, 5 = moored
function aisColor(shipType) {
  var map = {
    cargo: 0x4488ff, tanker: 0xff9933, military: 0xff4444,
    passenger: 0xc5d7e8, fishing: 0x44cc88, tug: 0xffcc44,
    port_service: 0xaaaaaa, recreational: 0xcc88ff,
    other: 0x14b8a6, unknown: 0x5577aa,
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
// ── Post-batch finalization — runs after all chunks complete ──────────────────
// Calls renderAIS(), syncs selection state and InstancedMesh dim/scale.
function _finishProcessAndRender() {
  // Reset re-entrancy flag immediately — must run even if renderAIS() or dim
  // sync throws, so subsequent setInterval ticks are not permanently blocked.
  _processingInProgress = false;
  renderAIS();

  // ── Rate sample cleanup — once per tick, not once per vessel ─────────────
  // The per-vessel path only pushed; trimming here is O(window-size) once
  // instead of O(window-size × batch-size) that the old inline code produced.
  var _rCutoff = Date.now() - 10000;
  var _rTrim   = 0;
  while (_rTrim < _diag._rateSamples.length && _diag._rateSamples[_rTrim] < _rCutoff) _rTrim++;
  if (_rTrim > 0) _diag._rateSamples.splice(0, _rTrim);
  // Safety cap: prevent unbounded growth if all samples fall inside the 10 s window
  if (_diag._rateSamples.length > 4000) _diag._rateSamples.splice(0, _diag._rateSamples.length - 2000);

  // ── Selection tracking — O(1) read from ArgusSelection instead of O(N) scan ─
  // The old code used scale.x > 1.2 to detect the highlighted vessel — ArgusSelection
  // scales the highlighted sprite to 0.89 × 1.45 = 1.29 on BOTH hover and lock.
  // getDimmedExcept() returns _dimmedExcept, which is the sprite at full brightness
  // (set by _applyDim on every hover and click, cleared by _restore on mouse-leave /
  // unlock).  This matches the old scan exactly: hover and lock both trigger dim sync.
  // getLocked() alone was wrong — it only reflects click/lock, not hover.
  var _AS = window.ArgusSelection;
  var _activeSprite = _AS && (_AS.getDimmedExcept ? _AS.getDimmedExcept() : _AS.getLocked());
  var _activeMmsi   = (_activeSprite && _activeSprite.userData) ? _activeSprite.userData.mmsi : undefined;
  _aisState.selectedVesselId = (_activeMmsi != null && aisMarkers.has(_activeMmsi)) ? _activeMmsi : null;

  // ── Sync InstancedMesh visual state from sprite state ───────────────────
  // ArgusSelection drives sprite.material.opacity (dim) and sprite.scale (highlight).
  // Since sprites are invisible (material.visible=false), we mirror to InstancedMesh.
  if (window.ArgusAISInstanced) {
    // ── Dim sync — event-driven, O(N) only on selection transitions ───────────
    // Previous: O(1500) forEach reading sprite opacity every 300ms tick while
    // any vessel was selected.
    // New: compare current vs previous selected MMSI — only act when state changes.
    //   none → AIS selected  : O(N) dim-all + highlight selected (unavoidable)
    //   AIS selected → none  : O(N) restore-all               (unavoidable)
    //   AIS A → AIS B        : O(1) swap — dim prev, highlight new
    //   same vessel, no change: O(0) — nothing written
    var _curSel  = _aisState.selectedVesselId;
    var _prevSel = _aisState._prevSelectedId;
    var _inst    = window.ArgusAISInstanced;
    if (_curSel !== _prevSel) {
      if (_curSel !== null && _prevSel === null) {
        // New AIS selection: dim every vessel, then restore the selected one
        aisMarkers.forEach(function(entry, mmsi) {
          _inst.setDimFactor(mmsi, mmsi === _curSel ? 1.0 : AIS_DIM_F);
        });
        _inst.commitBatch();
      } else if (_curSel === null && _prevSel !== null) {
        // Selection cleared: restore all to full brightness
        aisMarkers.forEach(function(entry, mmsi) {
          _inst.setDimFactor(mmsi, 1.0);
        });
        _inst.commitBatch();
      } else {
        // Locked vessel changed: update only the two affected entries
        _inst.setDimFactor(_prevSel, AIS_DIM_F);
        if (aisMarkers.has(_curSel)) _inst.setDimFactor(_curSel, 1.0);
        _inst.commitBatch();
      }
    }

    // ── Scale sync — O(1), only on selection change ────────────────────────
    if (_curSel !== _prevSel) {
      // Reset previously selected vessel to base scale
      if (_prevSel != null) {
        var _pEnt = aisMarkers.get(_prevSel);
        if (_pEnt) {
          var _pud = _pEnt.sprite.userData;
          _inst.setScale(_prevSel, 0.89, _pud.lat, _pud.lon, _pud.heading);
        }
      }
      // Apply enlarged scale to newly selected vessel
      if (_curSel != null) {
        var _sEnt = aisMarkers.get(_curSel);
        if (_sEnt) {
          var _ssp = _sEnt.sprite;
          var _sud = _ssp.userData;
          _inst.setScale(_curSel, _ssp.scale.x, _sud.lat, _sud.lon, _sud.heading);
        }
      }
      _aisState._prevSelectedId = _curSel;
    }
  }
}

// ── Chunked batch processor — 250 vessels per tick, yields via setTimeout(0) ──
var AIS_CHUNK_SIZE = 250;
function _processBatchChunk(batch, start, now) {
  var end = Math.min(start + AIS_CHUNK_SIZE, batch.length);
  for (var i = start; i < end; i++) {
    var v    = batch[i];
    var mmsi = v.mmsi;

    // ── Throttle gate (per-vessel min interval) ───────────────────────────
    if (_diag.throttleMs > 0 && _aisState.vessels.has(mmsi)) {
      if (now - _aisState.vessels.get(mmsi).updatedAt < _diag.throttleMs) continue;
    }

    // ── Rate sampling — push only; cleanup runs once per tick in _finishProcessAndRender ──
    // Moving the O(array) scan out of the per-vessel loop prevents O(batch × array)
    // growth: at 100 vessels/tick and a 3000-entry window the old code did 300,000
    // comparisons per tick; the new path does 3000 once.
    _diag._rateSamples.push(now);

    // ── Diff check — only mark dirty if the vessel actually moved/changed ─
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

  if (end < batch.length) {
    // More chunks remain — yield to let browser handle frames/input
    if (window.ArgusSchedulerAudit) window.ArgusSchedulerAudit.yieldedTasks++;
    setTimeout(function () { _processBatchChunk(batch, end, now); }, 0);
  } else {
    // All chunks done — finalize
    _finishProcessAndRender();
  }
}

function _processAndRender() {
  if (document.hidden) return;  // tab not visible — skip processing, preserve buffer
  if (!_ingestBuffer.length) return;
  if (_processingInProgress) return;  // previous chunked pass still running

  // ── Diagnostic freeze gate — checked BEFORE draining buffer so messages
  // are preserved and replayed when freeze is lifted.
  if (_diag.freeze) return;

  // Drain the entire buffer in one pass — most recent value per MMSI wins naturally
  // because we overwrite state on each write (Map.set is idempotent by key).
  var batch = _ingestBuffer.splice(0, _ingestBuffer.length);

  var now = Date.now();

  if (batch.length > AIS_CHUNK_SIZE) {
    // Large batch — process cooperatively in 250-vessel chunks with setTimeout yields
    _processingInProgress = true;
    _processBatchChunk(batch, 0, now);
  } else {
    // Small batch — process synchronously (no yield overhead for typical ticks)
    _processBatchChunk(batch, 0, now);
  }
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
  // Flush batched needsUpdate flags once after all upserts — avoids per-vessel GPU flag churn
  if (window.ArgusAISInstanced) window.ArgusAISInstanced.commitBatch();
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
    sprite.updateWorldMatrix(false, false);  // keep matrixWorld valid for click raycast
    sprite.material.rotation = cogRad;
    sprite.material.color.setHex(aisColor(tc));
    sprite.userData.lat       = lat;
    sprite.userData.lon       = lon;
    sprite.userData.heading   = heading;
    sprite.userData.velocity  = velocity;
    sprite.userData.navStatus = navStatus;
    sprite.userData.title     = label;
    entry.updatedAt = now;
    if (window.ArgusAISInstanced) window.ArgusAISInstanced.upsert(mmsi, lat, lon, heading, aisColor(tc));
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
    // Add to aisGroup so the sprite lives inside globeGroup's coordinate frame.
    // getWorldPosition() then correctly applies globeGroup.rotation.y (PI/2) when
    // ArgusSelection projects to screen — orphaned sprites (parent=null) returned
    // globe-local coords which were -90° off from world space, breaking all hover/click.
    // material.visible=false: no draw call (InstancedMesh handles all visual rendering).
    mat.visible = false;
    aisGroup.add(sprite);
    sprite.updateWorldMatrix(false, false);  // sync matrixWorld immediately for this tick's raycasts
    aisMarkers.set(mmsi, { sprite: sprite, updatedAt: now, firstSeenAt: now });
    if (window.ArgusEntityRegistry) window.ArgusEntityRegistry.register(mmsi, 'ais_vessel', sprite, sprite.userData);
    if (window.ArgusAISInstanced) {
      window.ArgusAISInstanced.upsert(mmsi, lat, lon, heading, aisColor(tc));
      // One-time log: confirm first vessel reached the InstancedMesh
      if (aisMarkers.size === 1) {
        console.log('[ArgusAIS] first vessel upserted to InstancedMesh — mmsi=' + mmsi + ' lat=' + lat.toFixed(2) + ' lon=' + lon.toFixed(2));
        if (!window.ArgusAISInstanced.getMesh()) {
          console.warn('[ArgusAIS] ⚠ InstancedMesh is NULL — ArgusAISInstanced.init() did not complete. Call ArgusAIS.diagReport() for details.');
        }
      }
    } else if (aisMarkers.size === 1) {
      console.warn('[ArgusAIS] ⚠ ArgusAISInstanced not available — vessels will not render visually. Check instancedAIS.js loaded before argusAIS.js.');
    }
  }
}

function evictOldest() {
  // Evict by firstSeenAt (longest-resident vessel) rather than updatedAt.
  // Using updatedAt would structurally evict mid-ocean vessels that get satellite
  // AIS updates every 30–60 min while coastal vessels update every 30 sec — the
  // satellite vessels always have the oldest updatedAt and get continuously purged.
  // firstSeenAt is fair: equal opportunity regardless of update frequency; a
  // long-tenured coastal vessel is evicted before a newly discovered mid-ocean ship.
  // Evicted coastal vessels reappear immediately on next message; mid-ocean vessels
  // may not resurface until the next satellite pass (potentially 45+ minutes later).
  var oldest = null, oldestTime = Infinity;
  var oldestFallback = null, oldestTimeFallback = Infinity;
  aisMarkers.forEach(function(entry, mmsi) {
    // Track overall oldest (fallback)
    var t = entry.firstSeenAt || entry.updatedAt;  // firstSeenAt added in current version; updatedAt fallback for safety
    if (t < oldestTimeFallback) {
      oldestTimeFallback = t;
      oldestFallback = mmsi;
    }
    // Skip the currently selected vessel for normal eviction
    if (mmsi === _aisState.selectedVesselId) return;
    if (t < oldestTime) { oldestTime = t; oldest = mmsi; }
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

    if (window.ArgusAISInstanced) window.ArgusAISInstanced.remove(oldest);
    if (window.ArgusEntityRegistry) window.ArgusEntityRegistry.remove(oldest);
    if (aisGroup) aisGroup.remove(_evSprite);
    // Dispose the SpriteMaterial to free the GPU program allocation.
    // The shared texture (_shTex / shTex) is NOT disposed — it is owned by argusTracking.js.
    if (window.ArgusResourceTracker) window.ArgusResourceTracker.safeDisposeSprite(_evSprite, 'ais_sprite');
    aisMarkers.delete(oldest);
    _aisState.vessels.delete(oldest);  // keep state layer in sync
    _dirtyVessels.delete(oldest);      // cancel any pending sprite sync for this MMSI
  }
}

// ── Dead reckoning — extrapolate position for satellite-gap vessels ───────────
// Runs every AIS_DR_INTERVAL_MS (30 s). Iterates _aisState.vessels, finds any vessel
// that has not been heard from in AIS_DR_ACTIVATE_MS+ but has a valid heading + SOG,
// and moves its sprite + InstancedMesh instance to an extrapolated position.
//
// Uses ArgusAISInstanced.updatePosition() (matrix-only) rather than upsert() so that
// selection dim state is not disturbed — upsert() resets _lastDim to 1.0, which would
// un-dim a selection-dimmed vessel on every DR tick.
//
// Position math mirrors argusTracking.js aircraft dead reckoning:
//   distNm = SOG (knots) × dtHours
//   dLat   = distNm × cos(heading) / 60          (1° lat = 60 nm)
//   dLon   = distNm × sin(heading) / (60 × cos(lat))
function _runDeadReckoning() {
  if (document.hidden) return;
  if (!aisGroup || !window.ArgusGlobe || !window.ArgusAISInstanced) return;
  var now     = Date.now();
  var RAD     = Math.PI / 180;
  var inst    = window.ArgusAISInstanced;
  var AG      = window.ArgusGlobe;
  var drCount = 0;

  _aisState.vessels.forEach(function(v, mmsi) {
    var age = now - v.updatedAt;
    if (age < AIS_DR_ACTIVATE_MS)                          return;  // updated recently
    if (age > AIS_DR_MAX_AGE_MS)                           return;  // too stale — unreliable
    if (v.velocity == null || v.velocity < AIS_DR_MIN_SOG) return;  // stationary / anchored
    if (v.heading  == null)                                return;  // no direction vector

    var dtHours = age / 3600000;
    var distNm  = v.velocity * dtHours;
    var dLat    = distNm * Math.cos(v.heading * RAD) / 60;
    var dLon    = distNm * Math.sin(v.heading * RAD) / (60 * Math.max(0.05, Math.cos(v.lat * RAD)));
    var drLat   = v.lat + dLat;
    var drLon   = v.lon + dLon;

    if (drLat < -90 || drLat > 90) return;  // pole crossing — skip

    var entry = aisMarkers.get(mmsi);
    if (!entry) return;

    // Move invisible sprite (drives raycasting / ArgusSelection hover accuracy)
    entry.sprite.position.copy(AG.latLonToVector(drLat, drLon, AIS_ALTITUDE));
    entry.sprite.updateWorldMatrix(false, false);
    entry.sprite.userData.lat = drLat;
    entry.sprite.userData.lon = drLon;

    // Move InstancedMesh visual (matrix only — colour and dim factor left untouched)
    inst.updatePosition(mmsi, drLat, drLon, v.heading);
    drCount++;
  });

  if (drCount > 0) {
    inst.commitBatch();
    if (_diag.logRate) console.log('[ArgusAIS DR] extrapolated ' + drCount + ' vessels');
  }
}

// ── Toggle ─────────────────────────────────────────────────────────────────────
function toggle() {
  aisOn = !aisOn;
  if (aisGroup) aisGroup.visible = aisOn;
  if (window.ArgusAISInstanced) window.ArgusAISInstanced.setVisible(aisOn);
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
  if (window.ArgusPerf) ArgusPerf.mark('AIS_WEBSOCKET_CONNECTING');
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
    var meta = msg.MetaData || {};

    // ── ShipStaticData — carries ShipType and vessel name; no position ────
    if (msg.Message && msg.Message.ShipStaticData) {
      var ssd   = msg.Message.ShipStaticData;
      var smmsi = String(meta.MMSI || ssd.UserID || '');
      if (!smmsi) return;
      var stype = ssd.Type != null ? ssd.Type : null;
      var sname = (ssd.Name || meta.ShipName || '').trim();
      _staticCache.set(smmsi, { shipType: stype, name: sname });
      // Patch existing vessel state immediately so next render picks it up
      if (_aisState.vessels.has(smmsi)) {
        var ev = _aisState.vessels.get(smmsi);
        if (stype != null) ev.shipType = stype;
        if (sname)         ev.name     = sname;
        _dirtyVessels.add(smmsi);
      }
      return;
    }

    var report = (msg.Message && msg.Message.PositionReport) || {};

    var lat = meta.latitude  != null ? meta.latitude  : report.Latitude;
    var lon = meta.longitude != null ? meta.longitude : report.Longitude;
    if (lat == null || lon == null) return;
    if (lat === 0   && lon === 0)   return;

    var mmsi = String(meta.MMSI || meta.UserId || report.UserID || '');
    if (!mmsi) return;

    // Resolve ship type: position reports rarely carry it; fall back to static cache
    var cached   = _staticCache.get(mmsi);
    var shipType = report.ShipType != null ? report.ShipType
                 : (cached ? cached.shipType : null);
    var name     = meta.ShipName || (cached ? cached.name : '') || '';

    // ── Noise filter: skip low-intel-value vessel types ───────────────────
    // These burn marker slots without adding geopolitical signal.
    // Kept: fishing (30) — illegal fishing in contested waters has intel value.
    // Kept: tugs (31,32,52) — port-activity indicator.
    var _stn = parseInt(shipType, 10);
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
      name,
      lat,
      lon,
      hdg,
      report.Sog != null ? report.Sog : null,
      shipType,
      report.NavigationalStatus != null ? report.NavigationalStatus : null
    );
  }

  ws.onopen = function () {
    if (window.ArgusPerf) ArgusPerf.mark('AIS_WEBSOCKET_OPEN');
    console.log('[ArgusAIS] AISstream connected — subscribing (28 strategic regions)');
    // 26 strategic maritime regions.
    // Regional targeting gives proportional global coverage while avoiding the
    // European AIS receiver density bias that a single global bbox produces.
    // Format: [[minLat, minLon], [maxLat, maxLon]]
    // NOTE: Free tier test — using original 10 boxes only (1009 = subscription too large or banned).
    // If this connects cleanly, restore extra boxes gradually or upgrade plan.
    // Commented boxes were added progressively — re-enable once we confirm tier limit.
    ws.send(JSON.stringify({
      APIKey: AISSTREAM_KEY,
      BoundingBoxes: [
        [[ 50, -10], [ 70,  30]],  // North Sea & Baltic
        [[ 30,  -6], [ 46,  36]],  // Mediterranean
        [[ 12,  32], [ 32,  50]],  // Suez Canal & Red Sea
        [[ -2,  95], [  8, 110]],  // Strait of Malacca
        [[  5, -85], [ 25, -60]],  // Panama Canal & Caribbean
        [[ 23,  48], [ 30,  60]],  // Persian Gulf
        [[  0, 105], [ 25, 125]],  // South China Sea
        [[-12,  35], [ 15,  55]],  // East Africa & Horn
        [[ 30, -60], [ 60, -10]],  // North Atlantic
        [[ 20,-135], [ 50,-115]],  // US West Coast & Pacific
        /* DISABLED — restore if plan allows more boxes:
        [[ 25, -98], [ 45, -65]],  // US East Coast & Gulf of Mexico
        [[ 10,  55], [ 28,  78]],  // Arabian Sea
        [[ -5,  65], [ 25,  90]],  // Bay of Bengal & Indian Ocean N
        [[-35,  15], [-25,  40]],  // Cape of Good Hope
        [[-10, 105], [  8, 130]],  // Indonesia / Java / Banda Sea
        [[ 30, 125], [ 45, 145]],  // Japan & Korea
        [[ 40,  27], [ 48,  42]],  // Black Sea
        [[-10, -18], [ 10,  15]],  // West Africa / Gulf of Guinea
        [[-45, 110], [-10, 155]],  // Australia
        [[-35, -55], [ -5, -30]],  // South Atlantic / Brazil coast
        [[-60, -70], [-45, -50]],  // Cape Horn / Drake Passage
        [[-30,  80], [ 10, 110]],  // Indian Ocean (central)
        [[ 42, 145], [ 55, 180]],  // North Pacific routing corridor
        [[-40, -85], [ -5, -70]],  // South America Pacific coast
        [[ 68,  25], [ 78,  80]],  // Arctic / Northern Sea Route
        [[ 15,-175], [ 30,-140]],  // Central Pacific / OPAC routes
        [[-25, -45], [  5, -10]],  // South Atlantic transatlantic
        [[  0,-175], [ 22,-130]],  // Mid-Pacific
        */
      ],
      FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
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
    console.warn('[ArgusAIS] AISstream disconnected (code=' + e.code + ', reason="' + (e.reason || 'none') + '", clean=' + e.wasClean + ') — reconnecting in 5 s');
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

      // ── Initialise InstancedMesh visual layer ────────────────────────────
      if (window.ArgusAISInstanced) window.ArgusAISInstanced.init(aisGroup);

      // AIS sprite exposure is now handled by ArgusEntityRegistry:
      //   window._aisSprites  → registry getter → AIS ghost sprites (raycasters)
      //   ArgusSelection._all() queries 'ais_vessel' type from registry directly
      // No patchVesselMarkers needed — registry provides both ship and AIS sprites
      // to all interaction systems via separate type-indexed arrays.

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

      // ── Start dead reckoning interval ────────────────────────────────────
      // Extrapolates position for vessels not heard from in AIS_DR_ACTIVATE_MS+.
      // Satellite AIS revisit gaps (45–90 min) would otherwise freeze mid-ocean vessels.
      // First run delayed 5 s so the initial render pass completes before DR starts.
      setTimeout(function() {
        setInterval(_runDeadReckoning, AIS_DR_INTERVAL_MS);
        console.log('[ArgusAIS] dead reckoning interval started (' + AIS_DR_INTERVAL_MS + 'ms)');
      }, 5000);

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
  console.log('── Bootstrap / Visual Layer ─────────────────────────');
  console.log('  ArgusAISInstanced  :', window.ArgusAISInstanced ? 'LOADED' : '⚠ MISSING (instancedAIS.js load failure?)');
  console.log('  _argusShTex        :', window._argusShTex ? 'SET' : '⚠ NULL (patchShTex not resolved)');
  console.log('  aisGroup           :', aisGroup ? 'CREATED' : '⚠ NULL (ArgusGlobe not ready)');
  if (window.ArgusAISInstanced) {
    var _inst = window.ArgusAISInstanced;
    var _mesh = _inst.getMesh();
    console.log('  instanced ready    :', _mesh ? 'YES (count=' + _mesh.count + ')' : '⚠ NO — init() did not complete');
    console.log('  instanced vessels  :', _inst.getCount());
  }
  console.log('  wsAIS state        :', wsAIS ? ('OPEN state=' + wsAIS.readyState) : '⚠ NULL (not connected)');
  console.log('  _processingInProg  :', _processingInProgress);
  console.log('  _ingestBuffer.len  :', _ingestBuffer.length);
  console.log('  msg received       :', _aisMsgCount);
  console.log('');
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
  if (window.ArgusAISInstanced) window.ArgusAISInstanced.visualReport();
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

if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusAIS');
}());
