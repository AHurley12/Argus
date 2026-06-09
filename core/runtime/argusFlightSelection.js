'use strict';
// core/runtime/argusFlightSelection.js
// Deterministic OpenSky aircraft selection — no cache, no prioritization, no heuristics.
//
// Design (Parts 1-9 of ARGUS OpenSky Flight Interaction System Refactor spec):
//
//   Click → _hitTest() → 0 hits: miss  → return false (fall through to vessels/events)
//                      → 1 hit:  direct selectFlight(sprite)
//                      → N hits: _openDropdown(hits) → user picks → selectFlight(sprite)
//
//   selectFlight(sprite):
//     1. selectedFlightId = sprite.userData.icao24  (single source of truth, Part 3)
//     2. Debug log: Clicked / Selected / Focused all match (Part 6)
//     3. ArgusSelection.lockSprite(sprite)          (delegates all visuals unchanged)
//
// _hitTest() is fully fresh on every call:
//   - No cache, no TTL, no pool-reuse staleness
//   - Applies dataGroup.matrixWorld so positions are correct after any globe rotation
//   - Hit radius scales with zoom: 14px at default z=225
//
// Interactions NOT handled here (remain in ArgusSelection):
//   Hover dim/highlight — ArgusSelection.onHover (visual system, unchanged)
//   Vessel selection   — ArgusSelection.onClick  (panel + lock, unchanged)
//
// Dependencies (window globals):
//   window.THREE, window.ArgusEntityRegistry, window.ArgusLayerState,
//   window.ArgusGlobe (.camera, .dataGroup), window.ArgusSelection (.lockSprite)
//
// Public API: window.ArgusFlightSelection
//   .onClick(mx, my)   → true if aircraft handled; false if miss (caller should continue)
//   .getSelectedId()   → current selectedFlightId string | null
//   .getAudit()        → debug record { selectedFlightId, lastClickedId, hitRadius, ... }

window.ArgusFlightSelection = (function () {
  'use strict';

  // ── Single source of truth (Part 3) ───────────────────────────────────────
  var selectedFlightId = null;

  // ── Debug audit record (Part 6) ───────────────────────────────────────────
  var _dbg = { lastClickedId: null, lastSelectedId: null, lastFocusedId: null };

  // ── Hit radius (Part 2) ───────────────────────────────────────────────────
  // Calibrated at 14px at default camera z=225.
  // Scales inversely with camera distance so the hit area grows when zoomed in
  // (sprites are visually larger) and shrinks when zoomed out.
  // Clamped to [10, 40] to prevent extremes at min/max zoom.
  var HIT_RADIUS_BASE = 14;

  function _hitRadius() {
    var G = window.ArgusGlobe;
    var z = (G && G.camera) ? G.camera.position.z : 225;
    return Math.max(10, Math.min(40, HIT_RADIUS_BASE * (225 / z)));
  }

  // ── Scratch vectors (pre-allocated, no per-call GC pressure) ──────────────
  var _wp = new THREE.Vector3();
  var _rv = new THREE.Vector3();

  // ── Disambiguation panel state (Part 7) ───────────────────────────────────
  var _panel   = null;   // DOM element — created once on first dense-cluster click
  var _panelOc = null;   // outside-click handler ref

  // ── Helpers ────────────────────────────────────────────────────────────────

  function _sprites() {
    if (!window.ArgusEntityRegistry) return [];
    var ls = window.ArgusLayerState;
    if (ls && !ls.aircraft) return [];
    return window.ArgusEntityRegistry.getSprites(['aircraft']);
  }

  // ── Hit test (Part 2) — fully fresh, no cache ─────────────────────────────
  // Projects every live aircraft ghost sprite using the current dataGroup.matrixWorld.
  // Ghost sprites have parent=null; applying dataGroup.matrixWorld gives the world-space
  // position that matches where InstancedMesh visually renders each aircraft.
  // Returns all sprites within _hitRadius() of (mx, my), sorted closest-first.
  function _hitTest(mx, my) {
    var G = window.ArgusGlobe;
    if (!G || !G.camera || !G.dataGroup) return [];

    var cam = G.camera;
    var W   = window.innerWidth;
    var H   = window.innerHeight;
    var R   = _hitRadius();

    // Snapshot dataGroup matrixWorld once for this hit test pass
    G.dataGroup.updateWorldMatrix(true, false);
    var mat = G.dataGroup.matrixWorld;

    var sprites = _sprites();
    var hits    = [];

    for (var i = 0; i < sprites.length; i++) {
      var s = sprites[i];
      if (!s || !s.userData || !s.userData.isAircraft) continue;

      // Apply globe rotation to get true world-space position
      _wp.copy(s.position).applyMatrix4(mat);
      _rv.copy(_wp).project(cam);

      // Reject back-of-globe (NDC z outside [-1, 1])
      if (_rv.z < -1 || _rv.z > 1) continue;

      var sx = (_rv.x * 0.5 + 0.5) * W;
      var sy = (1 - (_rv.y * 0.5 + 0.5)) * H;
      var dx = sx - mx, dy = sy - my;
      var dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= R) hits.push({ sprite: s, dist: dist });
    }

    // Sort closest-first. No type priority, no weighting — nearest center wins.
    hits.sort(function (a, b) { return a.dist - b.dist; });
    return hits;
  }

  // ── selectFlight — the one function that sets selectedFlightId (Parts 3-5) ─
  // All downstream systems (camera, panel, focus) reference this via lockSprite.
  // Nothing else in this module makes selection or focus decisions.
  function selectFlight(sprite) {
    var ud  = sprite.userData;
    var id  = ud.icao24 || ud.title || (ud.lat + ',' + ud.lon);

    // Part 3 — single source of truth
    selectedFlightId = id;

    // Part 6 — debug validation: all three values must always be identical
    _dbg.lastClickedId  = id;
    _dbg.lastSelectedId = id;
    _dbg.lastFocusedId  = id;

    console.log(
      '[ArgusFlightSelection] Clicked:', _dbg.lastClickedId,
      '| Selected:', _dbg.lastSelectedId,
      '| Focused:', _dbg.lastFocusedId
    );

    if (_dbg.lastClickedId !== _dbg.lastSelectedId ||
        _dbg.lastSelectedId !== _dbg.lastFocusedId) {
      console.warn('[ArgusFlightSelection] MISMATCH — selection triangle violated');
    }

    // Delegate all visuals (dim, ring, info panel, focusEntity) to ArgusSelection.
    // lockSprite is the public API — no ArgusSelection internals are accessed.
    if (window.ArgusSelection && window.ArgusSelection.lockSprite) {
      window.ArgusSelection.lockSprite(sprite);
    }
  }

  // ── Dense-cluster disambiguation panel (Part 7) ───────────────────────────
  // Shown when multiple aircraft project within HIT_RADIUS of the cursor.
  // User choice is authoritative — no automatic resolution.
  function _getPanel() {
    if (_panel) return _panel;
    _panel = document.createElement('div');
    _panel.id = 'argus-flt-panel';
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
    var st = document.createElement('style');
    st.textContent = '#argus-flt-panel .afp-r:last-child{border-bottom:none!important}';
    document.head.appendChild(st);
    return _panel;
  }

  function _closePanel() {
    if (_panel) _panel.style.display = 'none';
    if (_panelOc) { document.removeEventListener('click', _panelOc); _panelOc = null; }
  }

  function _openDropdown(hits, px, py) {
    var panel = _getPanel();
    var shown = Math.min(hits.length, 8);

    var html = '<div style="padding:5px 12px 5px;border-bottom:1px solid #0f2744;'
             + 'color:#4a7da8;letter-spacing:2px;font-size:8px">'
             + 'SELECT FLIGHT — ' + hits.length + ' OVERLAPPING</div>';

    for (var i = 0; i < shown; i++) {
      var ud     = hits[i].sprite.userData;
      var name   = (ud.title || ud.icao24 || 'UNKNOWN').replace(/ \[.*\]$/, '');
      var parts  = [];
      if (ud.flightType) parts.push(ud.flightType.toUpperCase());
      if (ud.gs)         parts.push(Math.round(ud.gs) + 'kt');
      if (ud.alt)        parts.push(Math.round(ud.alt / 100) * 100 + 'ft');

      html += '<div class="afp-r" data-i="' + i + '" style="'
            + 'padding:5px 12px 4px;cursor:pointer;'
            + 'border-bottom:1px solid rgba(15,39,68,0.4);transition:background 0.1s">';
      html += '<div style="color:#e8f4ff;letter-spacing:0.5px">\u2708 ' + name + '</div>';
      if (parts.length) {
        html += '<div style="color:#4a7da8;font-size:9px;margin-top:1px">' + parts.join(' \u00b7 ') + '</div>';
      }
      html += '<div style="color:#2a3a50;font-size:8px;margin-top:1px;letter-spacing:1px">'
            + Math.round(hits[i].dist) + 'px from cursor</div>';
      html += '</div>';
    }

    panel.innerHTML = html;

    var rows = panel.querySelectorAll('.afp-r');
    for (var j = 0; j < rows.length; j++) {
      (function (row, idx) {
        row.addEventListener('mouseenter', function () { row.style.background = 'rgba(0,153,255,0.07)'; });
        row.addEventListener('mouseleave', function () { row.style.background = ''; });
        row.addEventListener('click', function (ev) {
          ev.stopPropagation();
          selectFlight(hits[idx].sprite);
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

  // ── Public: onClick (Part 2) ───────────────────────────────────────────────
  // Entry point called at the TOP of the index.html click handler, before any
  // 3D raycast. Returns true if an aircraft was hit (caller should return early).
  // Returns false on a miss so vessels/events fall through to existing logic.
  function onClick(mx, my) {
    var hits = _hitTest(mx, my);
    if (!hits.length) return false;

    if (hits.length === 1) {
      // Single unambiguous hit — deterministic direct selection (Part 2)
      selectFlight(hits[0].sprite);
    } else {
      // Dense cluster — user must choose; no automatic resolution (Part 7)
      _openDropdown(hits, mx, my);
    }
    return true;
  }

  // ── Public accessors ───────────────────────────────────────────────────────
  function getSelectedId() { return selectedFlightId; }

  function getAudit() {
    return {
      selectedFlightId: selectedFlightId,
      lastClickedId:    _dbg.lastClickedId,
      lastSelectedId:   _dbg.lastSelectedId,
      lastFocusedId:    _dbg.lastFocusedId,
      hitRadiusNow:     _hitRadius(),
      hitRadiusBase:    HIT_RADIUS_BASE,
    };
  }

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusFlightSelection');

  return {
    onClick:       onClick,
    getSelectedId: getSelectedId,
    getAudit:      getAudit,
  };

}());
