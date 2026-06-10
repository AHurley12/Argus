'use strict';
// core/runtime/argusVesselSelection.js
// Deterministic vessel selection — screen-space hit test before any 3D raycast.
//
// Design mirrors ArgusFlightSelection (aircraft) with vessel-specific adaptations:
//
//   Click → _hitTest() → 0 hits: miss  → return false (fall through to events)
//                      → 1 hit:  direct selectVessel(sprite)
//                      → N hits: _openDropdown(hits) → user picks → selectVessel(sprite)
//
//   selectVessel(sprite):
//     1. selectedVesselId = sprite.userData.mmsi  (single source of truth)
//     2. Debug log: Clicked / Selected / Focused all match
//     3. ArgusSelection.lockSprite(sprite)        (delegates all visuals unchanged)
//
// _hitTest() is fully fresh on every call — no cache, no TTL:
//   - AIS sprites (parent !== null): getWorldPosition() traverses aisGroup → dataGroup ✓
//   - Ship ghosts (parent === null): applyMatrix4(dataGroup.matrixWorld) to apply globe rotation ✓
//   - Hit radius scales with zoom: 16px base at default z=225, clamped [10, 45]
//     Slightly larger base than aircraft (14) — vessels cluster in ports and anchorages.
//
// Disambiguation panel (shown when N > 1):
//   - Vessel-specific accent color (teal) to distinguish from flight panel (blue)
//   - Detail row shows typeCategory + speed (sog / velocity) from userData
//   - Capped at 8 rows; shows count if more overlap
//
// NOT handled here (remain in ArgusSelection):
//   Hover dim/highlight  — ArgusSelection.onHover
//   Event selection      — ArgusSelection.onClick fallback
//
// Dependencies (window globals):
//   window.THREE, window.ArgusEntityRegistry, window.ArgusLayerState,
//   window.ArgusGlobe (.camera, .dataGroup), window.ArgusSelection (.lockSprite)
//
// Public API: window.ArgusVesselSelection
//   .onClick(mx, my)   → true if vessel handled; false if miss
//   .getSelectedId()   → current selectedVesselId string | null
//   .getAudit()        → debug record { selectedVesselId, hitRadius, ... }

window.ArgusVesselSelection = (function () {
  'use strict';

  // ── Single source of truth ────────────────────────────────────────────────
  var selectedVesselId = null;

  // ── Debug audit record ────────────────────────────────────────────────────
  var _dbg = { lastClickedId: null, lastSelectedId: null, lastFocusedId: null };

  // ── Hit radius ────────────────────────────────────────────────────────────
  // Base 16px at default camera z=225 — slightly wider than aircraft (14px)
  // because vessels often anchor in tight clusters.
  // Scales inversely with camera distance; clamped [10, 45].
  var HIT_RADIUS_BASE = 16;

  function _hitRadius() {
    var G = window.ArgusGlobe;
    var z = (G && G.camera) ? G.camera.position.z : 225;
    return Math.max(10, Math.min(45, HIT_RADIUS_BASE * (225 / z)));
  }

  // ── Scratch vectors ───────────────────────────────────────────────────────
  var _wp = new THREE.Vector3();
  var _rv = new THREE.Vector3();

  // ── Disambiguation panel state ────────────────────────────────────────────
  var _panel   = null;
  var _panelOc = null;

  // ── Helpers ───────────────────────────────────────────────────────────────

  // Returns all vessel sprites visible under current layer state.
  // Queries both 'ship' (VesselAPI, orphaned ghost) and 'ais_vessel' (AISstream, scene-attached).
  function _sprites() {
    if (!window.ArgusEntityRegistry) return [];
    var ls    = window.ArgusLayerState;
    var types = [];
    if (!ls || ls.vessels)    types.push('ship');
    if (!ls || ls.aisVessels) types.push('ais_vessel');
    if (!types.length) return [];
    return window.ArgusEntityRegistry.getSprites(types);
  }

  // ── Hit test — fully fresh, no cache ─────────────────────────────────────
  // Two projection paths because the two vessel classes live in different parts
  // of the scene graph:
  //
  //   Ship ghosts (parent === null):
  //     Orphaned sprites placed by argusTracking.renderShips/placeShip.
  //     .position carries the raw latLonToVector output — correct at placement
  //     time but stale after globe rotation.  Manually apply dataGroup.matrixWorld
  //     to get the world-space position that matches where InstancedMesh renders it.
  //
  //   AIS sprites (parent !== null):
  //     Scene-attached (aisGroup → eventMarkerGroup → dataGroup).
  //     getWorldPosition() traverses the parent chain and correctly accounts for
  //     dataGroup's current rotation.  No manual matrix application needed.
  //
  // Returns all sprites within _hitRadius() of (mx, my), sorted closest-first.
  function _hitTest(mx, my) {
    var G = window.ArgusGlobe;
    if (!G || !G.camera || !G.dataGroup) return [];

    var cam = G.camera;
    var W   = window.innerWidth;
    var H   = window.innerHeight;
    var R   = _hitRadius();

    // Snapshot dataGroup matrixWorld once — used for orphaned ship ghosts only.
    G.dataGroup.updateWorldMatrix(true, false);
    var mat = G.dataGroup.matrixWorld;

    var sprites = _sprites();
    var hits    = [];

    for (var i = 0; i < sprites.length; i++) {
      var s = sprites[i];
      if (!s || !s.userData) continue;
      if (!s.userData.isShip && !s.userData.isAISVessel) continue;

      // Projection — branch on parent presence (see comment above).
      if (s.parent) {
        s.getWorldPosition(_wp);
      } else {
        _wp.copy(s.position).applyMatrix4(mat);
      }
      _rv.copy(_wp).project(cam);

      // Reject back-of-globe
      if (_rv.z < -1 || _rv.z > 1) continue;

      var sx = (_rv.x * 0.5 + 0.5) * W;
      var sy = (1 - (_rv.y * 0.5 + 0.5)) * H;
      var dx = sx - mx, dy = sy - my;
      var dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= R) hits.push({ sprite: s, dist: dist });
    }

    // Sort closest-first.  No type priority between ship/ais_vessel — proximity wins.
    hits.sort(function (a, b) { return a.dist - b.dist; });
    return hits;
  }

  // ── selectVessel — the one function that sets selectedVesselId ────────────
  // Delegates all visuals (dim, ring, info panel, focusEntity) to ArgusSelection.lockSprite.
  function selectVessel(sprite) {
    var ud = sprite.userData;
    var id = ud.mmsi || ud.title || (ud.lat + ',' + ud.lon);

    selectedVesselId = id;

    _dbg.lastClickedId  = id;
    _dbg.lastSelectedId = id;
    _dbg.lastFocusedId  = id;

    console.log(
      '[ArgusVesselSelection] Clicked:', _dbg.lastClickedId,
      '| Selected:', _dbg.lastSelectedId,
      '| Focused:', _dbg.lastFocusedId
    );

    if (_dbg.lastClickedId !== _dbg.lastSelectedId ||
        _dbg.lastSelectedId !== _dbg.lastFocusedId) {
      console.warn('[ArgusVesselSelection] MISMATCH — selection triangle violated');
    }

    if (window.ArgusSelection && window.ArgusSelection.lockSprite) {
      window.ArgusSelection.lockSprite(sprite);
    }
  }

  // ── Dense-cluster disambiguation panel ───────────────────────────────────
  // Teal accent (#00ccaa) distinguishes this panel from the flight panel (blue #0099ff).
  // Detail row: typeCategory + speed.  Velocity field covers both ship (velocity)
  // and AIS (also velocity; sog as fallback for any future provider variance).
  function _getPanel() {
    if (_panel) return _panel;
    _panel = document.createElement('div');
    _panel.id = 'argus-vsl-panel';
    _panel.style.cssText = [
      'position:fixed', 'z-index:9100', 'display:none',
      'background:rgba(2,10,21,0.97)', 'border:1px solid #0f2744',
      'border-left:2px solid #00ccaa',
      'font-family:"JetBrains Mono",monospace', 'font-size:10px',
      'color:#c5d7e8', 'min-width:215px', 'max-width:275px',
      'pointer-events:all', 'backdrop-filter:blur(12px)',
      'box-shadow:0 4px 32px rgba(0,0,0,0.6)',
    ].join(';');
    document.body.appendChild(_panel);
    var st = document.createElement('style');
    st.textContent = '#argus-vsl-panel .avp-r:last-child{border-bottom:none!important}';
    document.head.appendChild(st);
    return _panel;
  }

  function _closePanel() {
    if (_panel) _panel.style.display = 'none';
    if (_panelOc) { document.removeEventListener('click', _panelOc); _panelOc = null; }
  }

  function _vesselDetail(ud) {
    var parts = [];
    if (ud.typeCategory) parts.push(ud.typeCategory.toUpperCase());
    // velocity is the canonical speed field for both argusAIS and argusTracking sprites;
    // sog is the normalised field from ArgusNormalizeVessel — accept both.
    var spd = (ud.velocity != null) ? ud.velocity : ud.sog;
    if (spd != null) parts.push(Math.round(spd) + 'kt');
    return parts.join(' \u00b7 ');
  }

  function _openDropdown(hits, px, py) {
    var panel = _getPanel();
    var shown = Math.min(hits.length, 8);

    var html = '<div style="padding:5px 12px 5px;border-bottom:1px solid #0f2744;'
             + 'color:#3a9e8a;letter-spacing:2px;font-size:8px">'
             + 'SELECT VESSEL \u2014 ' + hits.length + ' OVERLAPPING</div>';

    for (var i = 0; i < shown; i++) {
      var ud     = hits[i].sprite.userData;
      var name   = (ud.title || ud.mmsi || 'VESSEL').replace(/ \[.*\]$/, '');
      var detail = _vesselDetail(ud);

      html += '<div class="avp-r" data-i="' + i + '" style="'
            + 'padding:5px 12px 4px;cursor:pointer;'
            + 'border-bottom:1px solid rgba(15,39,68,0.4);transition:background 0.1s">';
      html += '<div style="color:#e8f4ff;letter-spacing:0.5px">\u26F5 ' + name + '</div>';
      if (detail) {
        html += '<div style="color:#3a9e8a;font-size:9px;margin-top:1px">' + detail + '</div>';
      }
      html += '<div style="color:#2a3a50;font-size:8px;margin-top:1px;letter-spacing:1px">'
            + Math.round(hits[i].dist) + 'px from cursor</div>';
      html += '</div>';
    }

    panel.innerHTML = html;

    var rows = panel.querySelectorAll('.avp-r');
    for (var j = 0; j < rows.length; j++) {
      (function (row, idx) {
        row.addEventListener('mouseenter', function () { row.style.background = 'rgba(0,204,170,0.07)'; });
        row.addEventListener('mouseleave', function () { row.style.background = ''; });
        row.addEventListener('click', function (ev) {
          ev.stopPropagation();
          selectVessel(hits[idx].sprite);
          _closePanel();
        });
      })(rows[j], j);
    }

    var W = window.innerWidth, H = window.innerHeight;
    var pw = 275, ph = shown * 55 + 30;
    panel.style.left    = Math.min(px + 14, W - pw - 8) + 'px';
    panel.style.top     = Math.max(8, Math.min(py - 10, H - ph - 8)) + 'px';
    panel.style.display = 'block';

    if (_panelOc) document.removeEventListener('click', _panelOc);
    setTimeout(function () {
      _panelOc = function (ev) {
        if (_panel && !_panel.contains(ev.target)) _closePanel();
      };
      document.addEventListener('click', _panelOc);
    }, 120);
  }

  // ── Public: onClick ───────────────────────────────────────────────────────
  // Called at the top of the index.html click handler, before any 3D raycast.
  // Returns true if a vessel was hit (caller returns early).
  // Returns false on miss so events/chokepoints/countries fall through.
  function onClick(mx, my) {
    var hits = _hitTest(mx, my);
    if (!hits.length) return false;

    if (hits.length === 1) {
      selectVessel(hits[0].sprite);
    } else {
      _openDropdown(hits, mx, my);
    }
    return true;
  }

  // ── Public accessors ──────────────────────────────────────────────────────
  function getSelectedId() { return selectedVesselId; }

  function getAudit() {
    return {
      selectedVesselId: selectedVesselId,
      lastClickedId:    _dbg.lastClickedId,
      lastSelectedId:   _dbg.lastSelectedId,
      lastFocusedId:    _dbg.lastFocusedId,
      hitRadiusNow:     _hitRadius(),
      hitRadiusBase:    HIT_RADIUS_BASE,
    };
  }

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusVesselSelection');

  return {
    onClick:       onClick,
    getSelectedId: getSelectedId,
    getAudit:      getAudit,
  };

}());
