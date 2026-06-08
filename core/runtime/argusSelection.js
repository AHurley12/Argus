// ── ArgusSelection — High-density entity interaction system ───────────────────
// Screen-space candidate gathering → dim/highlight → disambiguation → lock
//
// Dependencies (all window.* globals, no closure access to index.html):
//   window.THREE               — RingGeometry, MeshBasicMaterial, Mesh, Vector3
//   window.ArgusEntityRegistry — getSprites(types)
//   window.ArgusLayerState     — .aircraft, .vessels, .aisVessels
//   window.ArgusGlobe          — .camera, .eventMarkerGroup
//   window.ArgusUI             — .showEventDetail(userData)
//   window.ArgusResourceTracker — safeDisposeMesh (for _trackRing disposal)
//
// Extracted from index.html inline script.

window.ArgusSelection = (function () {
  'use strict';

  // ── Config ─────────────────────────────────────────────────────────────────
  var CFG = {
    SCREEN_RADIUS:    24,    // px — gather candidates within this circle
    BUCKET_SIZE:      36,    // px — spatial grid cell size
    DIM_OPACITY:      0.12,  // opacity for non-selected entities
    HIGHLIGHT_SCALE:  1.45,  // multiplier on top of base scale for selected entity
    MAX_PANEL_ROWS:   8,     // max rows in disambiguation panel
    BASE_SCALE_AC:    1.75,  // matches placeAircraft scale
    BASE_SCALE_SH:    0.89,  // matches placeShip / upsertAISMarker scale (−15% from 1.05)
  };

  // ── State ──────────────────────────────────────────────────────────────────
  var _locked       = null;   // locked Sprite | null
  var _dimmed       = false;  // whether dim is currently applied
  var _dimmedExcept = null;   // the sprite currently exempted from dim (highlighted)
  var _panelOpen    = false;
  var _trackRing    = null;   // THREE.Mesh ring around locked entity
  var _panel        = null;   // disambiguation DOM element
  var _panelOc      = null;   // outside-click handler ref — kept so _closePanel can remove it

  // ── Dirty-flag audit counters ─────────────────────────────────────────────
  var _selAudit = { dimFull: 0, dimIncremental: 0, skippedHovers: 0 };

  // ── Helpers ────────────────────────────────────────────────────────────────
  function _all() {
    if (!window.ArgusEntityRegistry) return [];
    var ls    = window.ArgusLayerState;
    var types = [];
    if (!ls || ls.aircraft)   types.push('aircraft');
    if (!ls || ls.vessels)    types.push('ship');
    if (!ls || ls.aisVessels) types.push('ais_vessel');
    return window.ArgusEntityRegistry.getSprites(types);
  }


  function _baseScale(s)   { return s.userData.isAircraft ? CFG.BASE_SCALE_AC : CFG.BASE_SCALE_SH; }
  function _baseOpacity(s) { return s.userData.stale ? 0.45 : 0.92; }

  // ── Screen-space projection scratch vectors ───────────────────────────────
  var _wp = new THREE.Vector3(); // world position scratch
  var _rv = new THREE.Vector3(); // NDC scratch

  // ── Screen-position cache ──────────────────────────────────────────────────
  // Projecting 1500+ entities via getWorldPosition+project every 100ms hover
  // tick is the primary LONG_TASK source.  The cache rebuilds only when the
  // camera moves, entity count changes, or the TTL expires (250ms — one step
  // below the AIS 300ms render cycle so moving vessels stay fresh).
  // On a cache hit the entire O(N) projection loop is skipped; the lookup is
  // O(candidates_in_nearby_buckets) — typically 0–5 entities.
  //
  // Cache fields:
  //   xs, ys, zs  — Float32Array screen coords per entity (reused to avoid GC)
  //   sprites     — entity array parallel to xs/ys/zs
  //   buckets     — pre-built bucket dict keyed "bx,by" → [indices]
  //   w, h        — viewport size at build time
  var _pCache    = null;
  var _pCamPX = 0, _pCamPY = 0, _pCamPZ = 0;      // camera position snapshot
  var _pCamQX = 0, _pCamQY = 0, _pCamQW = 0;      // camera quaternion snapshot (3 of 4 components)
  var _pEntityN  = -1;                              // entity count at last build
  var _pCacheTs  = 0;                              // performance.now() at last build
  var _pLayerHash = -1;                             // layer on/off bitmask at last build
  var _pGlobeRotY = 0, _pGlobeRotX = 0;            // dataGroup rotation snapshot — invalidates on globe pan
  var _PCACHE_TTL = 250;  // ms — max age before forced rebuild (catches AIS position updates)
  var _CAM_EPS   = 1e-3;  // camera movement threshold before cache is invalidated
  // 1e-3 tolerates OrbitControls damping residuals (~0.001/frame during deceleration)
  // while still detecting intentional pans (~0.01+/frame). 1e-4 was too tight and
  // caused constant cache misses during the ~1-2s deceleration tail after any pan.

  // 3-bit hash of the three traffic layer on/off states.
  // Changes only when a toggle button/key fires — never from AIS count churn.
  // Used to immediately invalidate the position cache on layer toggle so ghost
  // sprites from a toggled-off layer do not linger in candidate results.
  function _layerHash() {
    var ls = window.ArgusLayerState;
    return (!ls || ls.aircraft   ? 1 : 0)
         | (!ls || ls.vessels    ? 2 : 0)
         | (!ls || ls.aisVessels ? 4 : 0);
  }

  function _cacheStale(cam, markers, W, H) {
    if (!_pCache) return true;
    // Layer-toggle check: immediately invalidates if any traffic layer was turned on/off.
    if (_layerHash() !== _pLayerHash) return true;
    if (W !== _pCache.w || H !== _pCache.h) return true;
    if (performance.now() - _pCacheTs > _PCACHE_TTL) return true;
    // Entity count change: aircraft/ship/AIS refresh cycles add or remove sprites.
    // Without this check a 90s aircraft rebuild would silently serve stale xs/ys for
    // up to 250ms (TTL) while the pool-reused sprite objects carry new positions.
    if (markers.length !== _pEntityN) return true;
    if (Math.abs(cam.position.x  - _pCamPX) > _CAM_EPS) return true;
    if (Math.abs(cam.position.y  - _pCamPY) > _CAM_EPS) return true;
    if (Math.abs(cam.position.z  - _pCamPZ) > _CAM_EPS) return true;
    if (Math.abs(cam.quaternion.x - _pCamQX) > _CAM_EPS) return true;
    if (Math.abs(cam.quaternion.y - _pCamQY) > _CAM_EPS) return true;
    if (Math.abs(cam.quaternion.w - _pCamQW) > _CAM_EPS) return true;
    // Globe rotation check: the camera is fixed; the globe rotates via dataGroup.
    // Aircraft/ship ghost sprites are orphaned (parent=null) — their screen positions
    // are computed using dataGroup.matrixWorld, so any globe pan must invalidate the cache.
    var _ag = window.ArgusGlobe;
    if (_ag && _ag.dataGroup) {
      if (Math.abs(_ag.dataGroup.rotation.y - _pGlobeRotY) > _CAM_EPS) return true;
      if (Math.abs(_ag.dataGroup.rotation.x - _pGlobeRotX) > _CAM_EPS) return true;
    }
    return false;
  }

  function _rebuildCache(markers, cam, W, H) {
    var n = markers.length;
    var B = CFG.BUCKET_SIZE;
    // Reuse typed arrays when size matches — avoids GC pressure
    var xs = (_pCache && _pCache.xs.length === n) ? _pCache.xs : new Float32Array(n);
    var ys = (_pCache && _pCache.ys.length === n) ? _pCache.ys : new Float32Array(n);
    var zs = (_pCache && _pCache.zs.length === n) ? _pCache.zs : new Float32Array(n);

    // Screen-space projection for two sprite classes:
    //
    //   Scene-attached (AIS in aisGroup→dataGroup): getWorldPosition() traverses the
    //   parent chain and correctly applies dataGroup's current rotation. ✓
    //
    //   Orphaned ghosts (aircraft/ship, parent=null): getWorldPosition() just copies
    //   .position with no parent transforms, so it returns the raw latLonToVector
    //   output — correct at placement time but STALE after globe rotation.
    //   Fix: manually apply dataGroup.matrixWorld to get the world-space position
    //   that matches where the InstancedMesh visually renders the entity.
    var _dataMatWorld = null;
    var _ag = window.ArgusGlobe;
    if (_ag && _ag.dataGroup) {
      _ag.dataGroup.updateWorldMatrix(true, false);  // ensure matrix is current
      _dataMatWorld = _ag.dataGroup.matrixWorld;
    }
    var buckets = Object.create(null);
    for (var i = 0; i < n; i++) {
      if (markers[i].parent) {
        markers[i].getWorldPosition(_wp);
      } else {
        _wp.copy(markers[i].position);
        if (_dataMatWorld) _wp.applyMatrix4(_dataMatWorld);
      }
      _rv.copy(_wp).project(cam);
      xs[i] = (_rv.x * 0.5 + 0.5) * W;
      ys[i] = (1 - (_rv.y * 0.5 + 0.5)) * H;
      zs[i] = _rv.z;
      markers[i]._scx = xs[i];
      markers[i]._scy = ys[i];
      // Exclude back-of-globe / beyond far-clip from buckets (z range: -1..1)
      if (zs[i] < -1 || zs[i] > 1) continue;
      var bx = Math.floor(xs[i] / B), by = Math.floor(ys[i] / B);
      var k  = bx + ',' + by;
      if (!buckets[k]) buckets[k] = [];
      buckets[k].push(i);
    }

    _pCache = { xs: xs, ys: ys, zs: zs, sprites: markers, buckets: buckets, w: W, h: H };
    _pCamPX = cam.position.x; _pCamPY = cam.position.y; _pCamPZ = cam.position.z;
    _pCamQX = cam.quaternion.x; _pCamQY = cam.quaternion.y; _pCamQW = cam.quaternion.w;
    _pEntityN  = n;
    _pLayerHash = _layerHash();
    _pCacheTs  = performance.now();
    if (_ag && _ag.dataGroup) {
      _pGlobeRotY = _ag.dataGroup.rotation.y;
      _pGlobeRotX = _ag.dataGroup.rotation.x;
    }
  }

  // ── Bucket-grid candidate query ────────────────────────────────────────────
  // Cache-hit path: O(candidates in nearby cells) — typically 0–5 entities.
  // Cache-miss path: O(N) rebuild (getWorldPosition+project), then O(1) lookup.
  // Rebuild triggers: camera moved, entity count changed, or TTL expired (250ms).
  function _candidates(mx, my, cam, W, H) {
    var B = CFG.BUCKET_SIZE, R = CFG.SCREEN_RADIUS;
    var bR = Math.ceil(R / B) + 1;
    var bx0 = Math.floor(mx / B), by0 = Math.floor(my / B);
    var markers = _all();

    if (_cacheStale(cam, markers, W, H)) _rebuildCache(markers, cam, W, H);

    var xs = _pCache.xs, ys = _pCache.ys;
    var sprites  = _pCache.sprites;
    var buckets  = _pCache.buckets;
    var out = [];

    for (var cx = bx0 - bR; cx <= bx0 + bR; cx++) {
      for (var cy = by0 - bR; cy <= by0 + bR; cy++) {
        var cell = buckets[cx + ',' + cy];
        if (!cell) continue;
        for (var j = 0; j < cell.length; j++) {
          var idx = cell[j];
          // Layer-state gate: ghost sprites remain visible=true after toggle-off because
          // they have no scene parent (InstancedMesh owns the visual). Check the current
          // layer state explicitly so stale cache entries never escape as candidates.
          var _sp = sprites[idx];
          var _ud = _sp.userData;
          var _ls = window.ArgusLayerState;
          if (_ls && _ud) {
            if (_ud.isAircraft  && !_ls.aircraft)   continue;
            if (_ud.isShip      && !_ls.vessels)    continue;
            if (_ud.isAISVessel && !_ls.aisVessels) continue;
          }
          if (!_sp.visible) continue;
          var dx = xs[idx] - mx, dy = ys[idx] - my;
          var d  = Math.sqrt(dx * dx + dy * dy);
          if (d <= R) out.push({ sprite: _sp, dist: d });
        }
      }
    }

    // Rank: aircraft > vessel, then by proximity
    out.sort(function (a, b) {
      var pa = a.sprite.userData.isAircraft ? 0 : 1;
      var pb = b.sprite.userData.isAircraft ? 0 : 1;
      return pa !== pb ? pa - pb : a.dist - b.dist;
    });
    return out;
  }

  // ── Dim/restore ────────────────────────────────────────────────────────────
  //
  // Incremental dim: after the initial O(N) scan, hover transitions between
  // entities are O(1) — only the 2 changing sprites are written.
  //
  //   Initial dim  (not yet dimmed): O(N) — unavoidable, sets all to DIM_OPACITY
  //   Hover transition (already dimmed, new entity): O(1) — write 2 sprites
  //   Same entity again (onHover skip catches it first): O(0) — no call at all
  //   Restore (unlock / mouse leaves candidates): O(N) — unavoidable, resets all
  //
  // _dimmedExcept tracks which sprite is currently at full brightness so the
  // transition path knows which sprite to send back to DIM_OPACITY.
  function _applyDim(except) {
    if (!_dimmed) {
      // ── Initial dim: full population scan (unavoidable) ──────────────────
      var markers = _all();
      for (var i = 0; i < markers.length; i++) {
        var s   = markers[i];
        var bsc = _baseScale(s);
        if (s === except) {
          s.scale.set(bsc * CFG.HIGHLIGHT_SCALE, bsc * CFG.HIGHLIGHT_SCALE, 1);
          s.material.opacity = _baseOpacity(s);
        } else {
          s.scale.set(bsc, bsc, 1);
          s.material.opacity = CFG.DIM_OPACITY;
        }
      }
      _dimmed = true;
      _selAudit.dimFull++;
    } else {
      // ── Incremental transition: only touch 2 sprites ─────────────────────
      // Dim the previously highlighted sprite (if it changed)
      if (_dimmedExcept && _dimmedExcept !== except) {
        var ps  = _dimmedExcept;
        var pbs = _baseScale(ps);
        ps.scale.set(pbs, pbs, 1);
        ps.material.opacity = CFG.DIM_OPACITY;
      }
      // Highlight the new sprite
      var ebs = _baseScale(except);
      except.scale.set(ebs * CFG.HIGHLIGHT_SCALE, ebs * CFG.HIGHLIGHT_SCALE, 1);
      except.material.opacity = _baseOpacity(except);
      _selAudit.dimIncremental++;
    }
    _dimmedExcept = except;
  }

  function _restore() {
    if (!_dimmed) return;  // guard: avoid redundant O(N) scan if not dimmed
    var markers = _all();
    for (var i = 0; i < markers.length; i++) {
      var s   = markers[i];
      var bs  = _baseScale(s);
      s.material.opacity = _baseOpacity(s);
      s.scale.set(bs, bs, 1);
    }
    _dimmed       = false;
    _dimmedExcept = null;
  }

  // ── Tracking ring (pulsing ring around locked entity in world space) ────────
  function _showRing(sprite) {
    _removeRing();
    var geo = new THREE.RingGeometry(1.5, 2.0, 48);
    var mat = new THREE.MeshBasicMaterial({
      color: 0x0099ff, transparent: true, opacity: 0.65,
      side: THREE.DoubleSide, depthTest: false
    });
    _trackRing = new THREE.Mesh(geo, mat);
    _trackRing.position.copy(sprite.position);
    var cam = window.ArgusGlobe && window.ArgusGlobe.camera;
    if (cam) _trackRing.lookAt(cam.position);
    // Ghost sprites (instanced entities) have no scene parent — attach ring to
    // eventMarkerGroup so it renders in the correct world-space coordinate frame.
    var AG = window.ArgusGlobe;
    if (sprite.parent) {
      sprite.parent.add(_trackRing);
    } else if (AG && AG.eventMarkerGroup) {
      AG.eventMarkerGroup.add(_trackRing);
    }
  }

  function _removeRing() {
    if (!_trackRing) return;
    if (_trackRing.parent) _trackRing.parent.remove(_trackRing);
    _trackRing.geometry.dispose();
    _trackRing.material.dispose();
    _trackRing = null;
  }

  // ── Entity presentation helpers ───────────────────────────────────────────
  function _entityIcon(ud) {
    if (ud.isAircraft) return '✈';
    if (ud.isShip || ud.isAISVessel) return '⛵';
    var cat = (ud.type || ud.category || '').toLowerCase();
    if (cat === 'tropical_cyclone') return '◎';
    if (cat === 'wildfire')         return '▲';
    if (cat === 'earthquake')       return '◉';
    if (cat === 'flood')            return '◈';
    if (cat === 'volcano')          return '▲';
    return '◈';
  }

  function _entityName(ud) {
    if (ud.isAircraft) return (ud.title || ud.icao24 || 'UNKNOWN').replace(/ \[.*\]$/, '');
    if (ud.isShip || ud.isAISVessel) return (ud.title || ud.mmsi || 'VESSEL');
    return (ud.title || ud.name || ud._gdacsId || ud.id || 'EVENT');
  }

  function _entityDetail(ud) {
    var parts = [];
    if (ud.isAircraft) {
      if (ud.flightType) parts.push(ud.flightType.toUpperCase());
      if (ud.gs)         parts.push(Math.round(ud.gs) + 'kt');
      if (ud.alt)        parts.push(Math.round(ud.alt / 100) * 100 + 'ft');
    } else if (ud.isShip || ud.isAISVessel) {
      if (ud.typeCategory) parts.push(ud.typeCategory.toUpperCase());
      if (ud.velocity)     parts.push(Math.round(ud.velocity) + 'kt');
    } else {
      var cat = (ud.type || ud.category || '');
      if (cat) parts.push(cat.replace(/_/g, ' ').toUpperCase());
      if (ud.severity)       parts.push(ud.severity.toUpperCase());
      if (ud.magnitude != null) parts.push(ud.magnitude + (ud.magnitudeUnit || ''));
    }
    return parts.join(' · ');
  }

  // ── Disambiguation panel ───────────────────────────────────────────────────
  function _getPanel() {
    if (_panel) return _panel;
    _panel = document.createElement('div');
    _panel.id = 'argus-sel-panel';
    _panel.style.cssText = [
      'position:fixed', 'z-index:9100', 'display:none',
      'background:rgba(2,10,21,0.97)', 'border:1px solid #0f2744',
      'border-left:2px solid #0099ff',
      'font-family:"JetBrains Mono",monospace', 'font-size:10px',
      'color:#c5d7e8', 'min-width:215px', 'max-width:275px',
      'pointer-events:all', 'backdrop-filter:blur(12px)',
      'box-shadow:0 4px 32px rgba(0,0,0,0.6)',
    ].join(';');
    document.body.appendChild(_panel);
    // Remove last row's border
    var st = document.createElement('style');
    st.textContent = '#argus-sel-panel .asl-r:last-child{border-bottom:none!important}';
    document.head.appendChild(st);
    return _panel;
  }

  function _openPanel(candidates, px, py) {
    var panel  = _getPanel();
    _panelOpen = true;
    var shown  = Math.min(candidates.length, CFG.MAX_PANEL_ROWS);

    var html = '<div style="padding:5px 12px 5px;border-bottom:1px solid #0f2744;'
             + 'color:#4a7da8;letter-spacing:2px;font-size:8px">'
             + 'SELECT ENTITY — ' + candidates.length + ' NEARBY</div>';

    for (var i = 0; i < shown; i++) {
      var c  = candidates[i];
      var ud = c.sprite.userData;
      var icon   = _entityIcon(ud);
      var name   = _entityName(ud);
      var detail = _entityDetail(ud);

      html += '<div class="asl-r" data-i="' + i + '" style="'
            + 'padding:5px 12px 4px;cursor:pointer;'
            + 'border-bottom:1px solid rgba(15,39,68,0.4);transition:background 0.1s">';
      html += '<div style="color:#e8f4ff;letter-spacing:0.5px">' + icon + ' ' + name + '</div>';
      if (detail) html += '<div style="color:#4a7da8;font-size:9px;margin-top:1px">' + detail + '</div>';
      html += '<div style="color:#2a3a50;font-size:8px;margin-top:1px;letter-spacing:1px">'
            + Math.round(c.dist) + 'px away</div>';
      html += '</div>';
    }

    panel.innerHTML = html;

    // Wire rows
    var rows = panel.querySelectorAll('.asl-r');
    for (var j = 0; j < rows.length; j++) {
      (function (row, idx) {
        row.addEventListener('mouseenter', function () {
          row.style.background = 'rgba(0,153,255,0.07)';
          _applyDim(candidates[idx].sprite);
        });
        row.addEventListener('mouseleave', function () { row.style.background = ''; });
        row.addEventListener('click', function (ev) {
          ev.stopPropagation();
          _lock(candidates[idx].sprite);
          _closePanel();
        });
      })(rows[j], j);
    }

    // Position near cursor, keep on screen
    var W = window.innerWidth, H = window.innerHeight;
    var pw = 275, ph = shown * 55 + 30;
    panel.style.left    = Math.min(px + 14, W - pw - 8) + 'px';
    panel.style.top     = Math.max(8, Math.min(py - 10, H - ph - 8)) + 'px';
    panel.style.display = 'block';

    // Outside-click closes panel. Store handler ref so _closePanel can remove it
    // even when the panel is closed by a row click rather than an outside click —
    // otherwise the self-removing pattern leaks one listener per open/close cycle.
    if (_panelOc) document.removeEventListener('click', _panelOc);
    setTimeout(function () {
      _panelOc = function (ev) {
        if (_panel && !_panel.contains(ev.target)) {
          _closePanel();
          if (!_locked) _restore();
        }
      };
      document.addEventListener('click', _panelOc);
    }, 120);
  }

  function _closePanel() {
    if (_panel) _panel.style.display = 'none';
    _panelOpen = false;
    if (_panelOc) { document.removeEventListener('click', _panelOc); _panelOc = null; }
  }

  // ── Lock / unlock ──────────────────────────────────────────────────────────
  function _lock(sprite) {
    _locked = sprite;
    _applyDim(sprite);
    _showRing(sprite);
    if (window.ArgusUI && sprite.userData) ArgusUI.showEventDetail(sprite.userData);
    var ud = sprite.userData;
    if (ud && ud.lat != null && ud.lon != null && window.ArgusGlobe && window.ArgusGlobe.focusEntity) {
      window.ArgusGlobe.focusEntity(ud.lat, ud.lon);
    }
  }

  function unlock() {
    if (!_locked && !_panelOpen) return;
    _locked = null;
    _removeRing();
    _restore();
    _closePanel();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  // Call from hover handler — runs screen-space search independently of raycast results.
  // Does NOT gate on hasTraffic: raycast often misses sprites in congested areas.
  function onHover(mx, my) {
    if (_locked || _panelOpen) return;
    var ls = window.ArgusLayerState;
    var anyTrafficLayer = !ls || ls.aircraft || ls.vessels || ls.aisVessels;
    if (!anyTrafficLayer) { if (_dimmed) _restore(); return; }
    var G = window.ArgusGlobe;
    if (!G) return;
    var W = window.innerWidth, H = window.innerHeight;
    var cs = _candidates(mx, my, G.camera, W, H);
    if (!cs.length) { if (_dimmed) _restore(); return; }
    // Same entity as last tick — skip _applyDim entirely (avoids O(N→1) write path)
    if (cs[0].sprite === _dimmedExcept) { _selAudit.skippedHovers++; return; }
    _applyDim(cs[0].sprite);
  }

  // Call from click handler when click hits vessel/aircraft area
  // Returns true if the event was handled (caller should return early)
  function onClick(mx, my) {
    if (_locked) { unlock(); return true; }
    var G = window.ArgusGlobe;
    if (!G) return false;
    var W  = window.innerWidth, H = window.innerHeight;
    // Force a full position rebuild on every click.
    // Ghost sprites (aircraft/ship, parent=null) are pool-reused on every ~90s refresh —
    // same JS objects get new positions but the TTL cache still holds old screen coords.
    // A click on empty space "hits" a stale bucket entry from the previous aircraft layout.
    // Rebuilding here is O(N) but clicks are infrequent; the hover path keeps the fast path.
    _pCacheTs = 0;
    var cs = _candidates(mx, my, G.camera, W, H);
    if (!cs.length) return false;
    var topUD = cs[0].sprite.userData;
    var isVessel = topUD.isShip || topUD.isAISVessel;
    if (isVessel) {
      // Vessels: always open panel so the user can confirm which ship in a busy
      // port/waterway — AIS traffic is dense and names/types are distinguishable.
      _applyDim(cs[0].sprite);
      _openPanel(cs, mx, my);
    } else {
      // Aircraft: always direct-lock to the nearest candidate. Flight density is
      // low enough that the closest hit is always the intended target. The panel
      // adds friction with no precision gain — callsigns alone don't help users
      // distinguish overlapping aircraft. Lock immediately → autofocus fires.
      _lock(cs[0].sprite);
    }
    return true;
  }

  // Call every animation frame
  function tick() {
    if (_trackRing && _locked) {
      _trackRing.position.copy(_locked.position);
      var cam = window.ArgusGlobe && window.ArgusGlobe.camera;
      if (cam) _trackRing.lookAt(cam.position);
      _trackRing.material.opacity = 0.35 + 0.28 * Math.sin(Date.now() / 650);
    }
    // Auto-unlock if locked entity was removed (layer toggled off / data refresh).
    // Ghost sprites (aircraft, ships, AIS) always have parent=null, so we check the
    // registry instead. Falls back to the parent check for non-registry sprites.
    if (_locked) {
      var _stillActive;
      var _lud = _locked.userData;
      var _lid = _lud && (_lud.icao24 || _lud.mmsi);
      if (window.ArgusEntityRegistry && _lid) {
        _stillActive = !!window.ArgusEntityRegistry.get(_lid);
      } else {
        _stillActive = !!_locked.parent;
      }
      if (!_stillActive) unlock();
    }
  }

  function getAudit() { return { dimFull: _selAudit.dimFull, dimIncremental: _selAudit.dimIncremental, skippedHovers: _selAudit.skippedHovers }; }

  // Returns the currently locked sprite, or null.
  function getLocked() { return _locked; }

  // Returns the sprite currently at full brightness (hover highlight OR locked entity).
  // _dimmedExcept is set by _applyDim() on every hover and on lock; cleared by _restore()
  // on mouse-leave and unlock.  This matches what the old AIS scale-scan detected
  // (scale > 1.2 = the highlighted sprite, whether from hover or click).
  function getDimmedExcept() { return _dimmedExcept; }

  // Init — keyboard ESC to unlock
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') unlock(); });

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusSelection');

  return { onHover: onHover, onClick: onClick, lockSprite: _lock, tick: tick, unlock: unlock, getAudit: getAudit, getLocked: getLocked, getDimmedExcept: getDimmedExcept };
}());
