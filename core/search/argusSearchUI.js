'use strict';
// core/search/argusSearchUI.js
// ARGUS Search and Navigation UI — Phase 1 (Countries) + Phase 2 (Infrastructure).
//
// Placement: position:fixed bar directly beneath the header (#header, 76px tall).
// Centered at 50% width, max 460px. Overlays the globe — does not shift any layout.
//
// Flow: type → ArgusSearchRegistry.query() → dropdown → select result →
//   ArgusGlobe.focusEntity(lat, lon) + ArgusUI.showStaticDetail(metadata)
//
// Design constraints:
//   - Reuses ArgusUI.showStaticDetail — no new panel created
//   - No camera logic — all focus delegated to ArgusGlobe.focusEntity
//   - No live data queries on keystroke — registry is pre-built at init
//   - Keyboard: ArrowUp/ArrowDown navigate, Enter selects, Escape clears
//
// Dependencies: window.ArgusSearchRegistry, window.ArgusGlobe, window.ArgusUI
// Public API: window.ArgusSearchUI
//   (self-initializing — no external init() call needed)

window.ArgusSearchUI = (function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────────────
  var _bar      = null;   // wrapper div
  var _input    = null;   // text input element
  var _drop     = null;   // dropdown div
  var _results  = [];     // current query result entries
  var _hi       = -1;     // highlighted row index (-1 = none)

  // ── Visual constants ──────────────────────────────────────────────────────
  var _HEADER_H = 76;  // px — matches --header-height CSS var

  var _TYPE_ICON = { country: '\u25c8', chokepoint: '\u2B21', port: '\u25b8', lng: '\u25C9' };
  // ◈ ⬡ ▸ ◉
  var _TYPE_LABEL  = { country: 'COUNTRY', chokepoint: 'CHOKEPOINT', port: 'PORT', lng: 'LNG' };
  var _TYPE_GROUP  = { country: 'COUNTRIES', chokepoint: 'CHOKEPOINTS', port: 'PORTS', lng: 'LNG FACILITIES' };
  var _TYPE_COLOR  = { country: '#0099ff', chokepoint: '#ffcc00', port: '#00ccaa', lng: '#ff9933' };

  // ── DOM construction ──────────────────────────────────────────────────────
  function _buildDOM() {
    // Read actual header height in case CSS var differs at render time
    var hEl = document.getElementById('header');
    var hTop = (hEl ? hEl.offsetHeight : _HEADER_H);

    // ── Inject styles ──────────────────────────────────────────────────────
    var st = document.createElement('style');
    st.textContent = [
      '#argus-search-bar *{box-sizing:border-box}',
      '#argus-search-input::placeholder{color:#2a4a68;letter-spacing:2px}',
      '#argus-search-input:focus{outline:none}',
      '.asr-row{display:flex;align-items:flex-start;padding:7px 12px;cursor:pointer;',
        'border-bottom:1px solid rgba(15,39,68,0.35)}',
      '.asr-row:last-child{border-bottom:none}',
      '.asr-row:hover,.asr-row.is-hi{background:rgba(0,153,255,0.07)}',
      '.asr-group{padding:4px 12px 3px;font-size:7px;letter-spacing:2px;color:#2a4a68;',
        'border-bottom:1px solid rgba(15,39,68,0.4);background:rgba(4,12,24,0.5)}',
      '.asr-group:first-child{border-top:none}',
    ].join('');
    document.head.appendChild(st);

    // ── Wrapper ────────────────────────────────────────────────────────────
    _bar = document.createElement('div');
    _bar.id = 'argus-search-bar';
    // Center bar vertically inside the header (header is ~76px tall, bar ~40px tall)
    var barTop = Math.round((hTop - 40) / 2);
    _bar.style.cssText = [
      'position:fixed',
      'top:' + barTop + 'px',
      'left:calc(50% + 80px)',
      'transform:translateX(-50%)',
      'z-index:25',
      'width:380px',
      'max-width:calc(100vw - 400px)',
      'pointer-events:all',
      'font-family:"JetBrains Mono",monospace',
    ].join(';');

    // ── Input row ─────────────────────────────────────────────────────────
    var row = document.createElement('div');
    row.style.cssText = [
      'display:flex',
      'align-items:center',
      'background:rgba(2,8,18,0.96)',
      'border:1px solid #0f2744',
      'border-left:3px solid #0099ff',
      'backdrop-filter:blur(14px)',
      '-webkit-backdrop-filter:blur(14px)',
    ].join(';');

    var icon = document.createElement('span');
    icon.textContent = '\u25c8';  // ◈
    icon.setAttribute('aria-hidden', 'true');
    icon.style.cssText = 'padding:0 9px;color:#0099ff;font-size:10px;user-select:none;flex-shrink:0';

    _input = document.createElement('input');
    _input.id          = 'argus-search-input';
    _input.type        = 'text';
    _input.placeholder = 'NAVIGATE — COUNTRIES \u00b7 PORTS \u00b7 CHOKEPOINTS \u00b7 LNG';
    _input.autocomplete = 'off';
    _input.setAttribute('spellcheck', 'false');
    _input.setAttribute('aria-label', 'ARGUS navigation search');
    _input.setAttribute('aria-autocomplete', 'list');
    _input.style.cssText = [
      'flex:1',
      'min-width:0',
      'background:transparent',
      'border:none',
      'outline:none',
      'color:#c5d7e8',
      'font-family:"JetBrains Mono",monospace',
      'font-size:10px',
      'letter-spacing:0.8px',
      'padding:10px 0',
      'caret-color:#0099ff',
    ].join(';');

    var clearBtn = document.createElement('button');
    clearBtn.textContent = '\u00d7';  // ×
    clearBtn.setAttribute('aria-label', 'Clear search');
    clearBtn.style.cssText = [
      'background:transparent',
      'border:none',
      'color:#2a4a68',
      'font-size:15px',
      'line-height:1',
      'padding:0 11px',
      'cursor:pointer',
      'flex-shrink:0',
    ].join(';');

    row.appendChild(icon);
    row.appendChild(_input);
    row.appendChild(clearBtn);
    _bar.appendChild(row);

    // ── Results dropdown ──────────────────────────────────────────────────
    _drop = document.createElement('div');
    _drop.id = 'argus-search-results';
    _drop.setAttribute('role', 'listbox');
    _drop.style.cssText = [
      'display:none',
      'background:rgba(2,8,18,0.98)',
      'border:1px solid #0f2744',
      'border-top:none',
      'max-height:340px',
      'overflow-y:auto',
      'box-shadow:0 8px 32px rgba(0,0,0,0.75)',
      'backdrop-filter:blur(14px)',
      '-webkit-backdrop-filter:blur(14px)',
    ].join(';');
    _bar.appendChild(_drop);

    document.body.appendChild(_bar);

    // ── Event wiring ──────────────────────────────────────────────────────
    _input.addEventListener('input', _onInput);
    _input.addEventListener('keydown', _onKeyDown);
    _input.addEventListener('focus', function () {
      if (_results.length) _showDrop();
    });

    clearBtn.addEventListener('click', function () { _clear(); _input.focus(); });
    clearBtn.addEventListener('mouseenter', function () { clearBtn.style.color = '#c5d7e8'; });
    clearBtn.addEventListener('mouseleave', function () { clearBtn.style.color = '#2a4a68'; });

    // Close dropdown on outside click — stored ref so it can be removed if needed
    document.addEventListener('click', function (ev) {
      if (_bar && !_bar.contains(ev.target)) _hideDrop();
    });
  }

  // ── Input handler ─────────────────────────────────────────────────────────
  function _onInput() {
    var q = _input.value;
    if (!q || q.trim().length < 2) {
      _results = [];
      _hideDrop();
      return;
    }
    if (!window.ArgusSearchRegistry) return;
    _results = window.ArgusSearchRegistry.query(q);
    _hi = -1;
    if (_results.length) {
      _renderDrop();
    } else {
      _hideDrop();
    }
  }

  // ── Keyboard navigation ───────────────────────────────────────────────────
  function _onKeyDown(ev) {
    if (ev.key === 'Escape') { ev.preventDefault(); _clear(); return; }
    if (!_results.length) return;
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      _hi = Math.min(_hi + 1, _results.length - 1);
      _updateHi();
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      _hi = Math.max(_hi - 1, 0);
      _updateHi();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      var idx = (_hi >= 0) ? _hi : 0;
      if (_results[idx]) _select(_results[idx]);
    }
  }

  function _updateHi() {
    var rows = _drop.querySelectorAll('.asr-row');
    for (var i = 0; i < rows.length; i++) {
      if (i === _hi) {
        rows[i].classList.add('is-hi');
      } else {
        rows[i].classList.remove('is-hi');
      }
    }
  }

  // ── Dropdown render ────────────────────────────────────────────────────────
  function _renderDrop() {
    var html     = '';
    var lastType = null;
    var rowIdx   = 0;

    for (var i = 0; i < _results.length; i++) {
      var e   = _results[i];
      var col = _TYPE_COLOR[e.type]  || '#c5d7e8';
      var ico = _TYPE_ICON[e.type]   || '\u25c8';
      var lbl = _TYPE_LABEL[e.type]  || e.type.toUpperCase();

      // Group header when type changes
      if (e.type !== lastType) {
        var grp = _TYPE_GROUP[e.type] || e.type.toUpperCase();
        html += '<div class="asr-group">' + grp + '</div>';
        lastType = e.type;
      }

      // Sub-label: country, region, or operator depending on type
      var sub = '';
      if (e.metadata) {
        if (e.type === 'country')    sub = e.metadata.pop ? e.metadata.pop + ' \u00b7 ' + e.metadata.risk : '';
        if (e.type === 'chokepoint') sub = e.metadata.traffic || '';
        if (e.type === 'port')       sub = e.metadata.country + ' \u00b7 ' + (e.metadata.teu || '');
        if (e.type === 'lng')        sub = e.metadata.country + ' \u00b7 ' + (e.metadata.capacity || '');
      }

      html += '<div class="asr-row" data-ri="' + rowIdx + '" role="option">';
      html += '<span style="color:' + col + ';font-size:11px;margin-right:9px;margin-top:2px;flex-shrink:0">' + ico + '</span>';
      html += '<span style="flex:1;min-width:0">';
      html += '<div style="color:#e8f4ff;font-size:10px;letter-spacing:0.4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + e.name + '</div>';
      if (sub) {
        html += '<div style="color:#4a7da8;font-size:8px;margin-top:1px;letter-spacing:0.5px">' + sub + '</div>';
      }
      html += '</span>';
      html += '<span style="font-size:7px;letter-spacing:1.5px;color:' + col + ';opacity:0.75;white-space:nowrap;margin-left:10px;flex-shrink:0">' + lbl + '</span>';
      html += '</div>';
      rowIdx++;
    }

    _drop.innerHTML = html;

    // Wire click + hover on each row
    var rows = _drop.querySelectorAll('.asr-row');
    for (var j = 0; j < rows.length; j++) {
      (function (row, idx) {
        row.addEventListener('click', function (ev) {
          ev.stopPropagation();
          _select(_results[idx]);
        });
        row.addEventListener('mouseenter', function () {
          _hi = idx;
          _updateHi();
        });
      })(rows[j], j);
    }

    _showDrop();
  }

  function _showDrop() { _drop.style.display = 'block'; }
  function _hideDrop() { _drop.style.display = 'none';  }

  function _clear() {
    _input.value = '';
    _results = [];
    _hi = -1;
    _hideDrop();
  }

  // ── Selection handler ─────────────────────────────────────────────────────
  // Autofocus via ArgusGlobe.focusEntity, then open the appropriate panel
  // via the existing ArgusUI.showStaticDetail. No camera logic lives here.
  function _select(entry) {
    // 1. Camera focus — centralized in ArgusGlobe
    if (window.ArgusGlobe && window.ArgusGlobe.focusEntity) {
      window.ArgusGlobe.focusEntity(entry.lat, entry.lon);
    }

    // 2. Open existing information panel — showStaticDetail handles country,
    //    chokepoint, and (after Phase 2 additive edit) port and lng branches.
    if (window.ArgusUI && window.ArgusUI.showStaticDetail) {
      window.ArgusUI.showStaticDetail(entry.metadata);
    }

    // 3. Close search UI after selection
    _hideDrop();
    _input.blur();

    console.log('[ArgusSearchUI] selected:', entry.type, entry.id, entry.name);
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    _buildDOM();

    // Populate the registry from all available static data globals
    if (window.ArgusSearchRegistry) {
      window.ArgusSearchRegistry.init();
      console.log('[ArgusSearchUI] registry ready — ' + window.ArgusSearchRegistry.getCount() + ' entries');
    } else {
      console.warn('[ArgusSearchUI] ArgusSearchRegistry not found — search will not function');
    }

    if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusSearchUI');
  }

  // Self-initialize once DOM is ready (scripts load after DOM parse completes)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { clear: _clear };

}());
