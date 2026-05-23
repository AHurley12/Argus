'use strict';
// modules/argusAnalytics.js
// Multi-source intelligence analytics — GEM / NOAA / ACLED
//
// Architecture:
//   Isolated analytics environment inside the Neural Web panel Analytics tab.
//   Three independent data feeds: polling, normalization, render state are fully
//   decoupled per source. Zero coupling to globe rendering or neural web graph.
//
//   Data → normalization → metrics state → render
//
// Tabs:
//   GEM   — Global Energy & Macro (infrastructure, supply chain, energy footprint)
//   NOAA  — Atmospheric Intelligence (storm ISR, severity scoring, cyclone tracking)
//   ACLED — Conflict & Instability (geopolitical events, escalation index, actor mapping)
//
// Polling:  GEM 30m | NOAA 15m | ACLED 30m
//           Uses _argusReqCache if available (transparent deduplication).
//           Staggered initial polls to avoid simultaneous cold-start burst.
//
// Init:     Lazy — mounts on first Analytics tab click.
//           Auto-inits if pane is already active on load.
//
// Globals:
//   window.ArgusAnalytics — { init, refresh, status }
//
// Load order: after argusWeatherLayer.js

window.ArgusAnalytics = (function () {
  'use strict';

  // ── Endpoints ─────────────────────────────────────────────────────────────────
  var GEM_FN   = '/.netlify/functions/fetch-gem';
  var NOAA_FN  = '/.netlify/functions/fetch-noaa';
  var ACLED_FN = '/.netlify/functions/fetch-acled';

  var POLL_GEM   = 30 * 60 * 1000;
  var POLL_NOAA  = 15 * 60 * 1000;
  var POLL_ACLED = 30 * 60 * 1000;

  // ── Module state ──────────────────────────────────────────────────────────────
  var _initialized = false;
  var _mounted     = false;
  var _activeTab   = 'gem';

  var _state = {
    gem:   { metrics: null, ts: null, loading: false, error: null },
    noaa:  { metrics: null, ts: null, loading: false, error: null },
    acled: { metrics: null, ts: null, loading: false, error: null },
  };

  var _timers = { gem: null, noaa: null, acled: null };

  // ── Fetch helper ──────────────────────────────────────────────────────────────
  // Uses shared request cache when available — deduplicates concurrent fetches.
  function _fetch(url) {
    var rc = window._argusReqCache;
    if (rc && typeof rc.fetch === 'function') return rc.fetch(url);
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // ── Normalization — GEM ───────────────────────────────────────────────────────
  function _sortDesc(obj, limit) {
    var arr = [];
    for (var k in obj) { if (obj.hasOwnProperty(k)) arr.push({ k: k, v: obj[k] }); }
    arr.sort(function (a, b) { return b.v - a.v; });
    return arr.slice(0, limit || 8);
  }

  function _normalizeGem(raw) {
    if (!raw || !Array.isArray(raw.infrastructure)) return null;
    var items = raw.infrastructure;
    var byFuel = {}, byStatus = {}, byType = {}, byCountry = {};
    var operational = 0, construction = 0;

    for (var i = 0; i < items.length; i++) {
      var it      = items[i];
      var fuel    = it.fuel    || 'Unknown';
      var status  = it.status  || 'Unknown';
      var type    = it.type    || 'Unknown';
      var country = it.country || 'Unknown';

      byFuel[fuel]       = (byFuel[fuel]       || 0) + 1;
      byStatus[status]   = (byStatus[status]   || 0) + 1;
      byType[type]       = (byType[type]       || 0) + 1;
      byCountry[country] = (byCountry[country] || 0) + 1;

      if (status === 'Operational') operational++;
      if (status && status.indexOf('Construction') >= 0) construction++;
    }

    return {
      total:        items.length,
      operational:  operational,
      construction: construction,
      countries:    Object.keys(byCountry).length,
      byFuel:       _sortDesc(byFuel,    8),
      byStatus:     _sortDesc(byStatus,  6),
      byType:       _sortDesc(byType,    7),
      topCountries: _sortDesc(byCountry, 5),
    };
  }

  // ── Normalization — NOAA ──────────────────────────────────────────────────────
  function _normalizeNoaa(raw) {
    if (!raw || !Array.isArray(raw.alerts)) return null;
    var alerts = raw.alerts;
    var sev    = { Extreme: 0, Severe: 0, Moderate: 0, Minor: 0 };
    var byType = {};
    var cyclones = 0;
    var CY_RE = /hurricane|typhoon|cyclone|tropical/i;

    for (var i = 0; i < alerts.length; i++) {
      var al = alerts[i];
      var s  = al.severity || 'Minor';
      if (sev.hasOwnProperty(s)) sev[s]++; else sev.Minor++;
      var et = al.eventType || 'Unknown';
      byType[et] = (byType[et] || 0) + 1;
      if (CY_RE.test(et)) cyclones++;
    }

    // Weighted intensity index — 0–100
    var n = Math.max(1, alerts.length);
    var intensity = Math.min(100, Math.round(
      (sev.Extreme * 12 + sev.Severe * 5 + sev.Moderate * 2 + sev.Minor * 0.5) / n * 16
    ));

    return {
      total:     alerts.length,
      extreme:   sev.Extreme,
      severe:    sev.Severe,
      moderate:  sev.Moderate,
      minor:     sev.Minor,
      cyclones:  cyclones,
      intensity: intensity,
      bySeverity: [
        { k: 'EXTREME',  v: sev.Extreme,  c: '#ff00cc' },
        { k: 'SEVERE',   v: sev.Severe,   c: '#ff4400' },
        { k: 'MODERATE', v: sev.Moderate, c: '#ffaa00' },
        { k: 'MINOR',    v: sev.Minor,    c: '#4fc3ff' },
      ],
      topTypes: _sortDesc(byType, 7),
    };
  }

  // ── Normalization — ACLED ─────────────────────────────────────────────────────
  function _normalizeAcled(raw) {
    if (!raw || !Array.isArray(raw.events)) return null;
    var events = raw.events;
    var byType = {}, byRegion = {}, byCountry = {}, byDate = {}, actors = {};
    var fatalities = 0;

    for (var i = 0; i < events.length; i++) {
      var ev      = events[i];
      var type    = ev.eventType || 'Unknown';
      var region  = ev.region    || ev.country || 'Unknown';
      var country = ev.country   || 'Unknown';
      var date    = ev.date      || null;

      byType[type]       = (byType[type]       || 0) + 1;
      byRegion[region]   = (byRegion[region]   || 0) + 1;
      byCountry[country] = (byCountry[country] || 0) + 1;
      fatalities += (ev.fatalities || 0);

      if (ev.actor1) actors[ev.actor1] = (actors[ev.actor1] || 0) + 1;
      if (ev.actor2) actors[ev.actor2] = (actors[ev.actor2] || 0) + 1;
      if (date) byDate[date] = (byDate[date] || 0) + 1;
    }

    // 14-day event tempo trend
    var dates = Object.keys(byDate).sort().slice(-14);
    var trend = dates.map(function (d) { return { d: d, v: byDate[d] }; });

    // Escalation index — events/day weighted by fatality rate
    var dayCount = Math.max(1, dates.length);
    var escalation = Math.min(100, Math.round(
      (events.length / dayCount) *
      (1 + (fatalities / Math.max(1, events.length)) * 0.3)
    ));

    return {
      total:        events.length,
      fatalities:   fatalities,
      regions:      Object.keys(byRegion).length,
      actors:       Object.keys(actors).length,
      escalation:   escalation,
      byType:       _sortDesc(byType,     7),
      topRegions:   _sortDesc(byRegion,   5),
      topCountries: _sortDesc(byCountry,  5),
      topActors:    _sortDesc(actors,     5),
      trend:        trend,
    };
  }

  // ── HTML utilities ────────────────────────────────────────────────────────────
  var _ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return _ESC_MAP[c]; });
  }

  function _fmtTs(ts) {
    if (!ts) return '--:--:-- UTC';
    var d   = new Date(ts);
    var hh  = ('0' + d.getUTCHours()).slice(-2);
    var mm  = ('0' + d.getUTCMinutes()).slice(-2);
    var ss  = ('0' + d.getUTCSeconds()).slice(-2);
    return hh + ':' + mm + ':' + ss + ' UTC';
  }

  function _fmtN(n) {
    if (n == null || isNaN(n)) return '--';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }

  // Blinking live indicator dot
  function _dot(color) {
    return '<span style="display:inline-block;width:5px;height:5px;border-radius:50%;' +
      'background:' + color + ';box-shadow:0 0 5px ' + color + ';' +
      'animation:ax-blink 2s ease-in-out infinite;vertical-align:middle;' +
      'margin-right:6px;flex-shrink:0;"></span>';
  }

  // Tab header row — feed label + last-updated timestamp
  function _tabHeader(label, ts, color) {
    return '<div style="display:flex;align-items:center;justify-content:space-between;' +
        'margin-bottom:12px;padding-bottom:7px;border-bottom:1px solid rgba(10,28,55,0.9);">' +
      '<span style="font-size:9px;letter-spacing:1.8px;color:' + color + ';font-weight:700;' +
        'display:flex;align-items:center;">' + _dot(color) + _esc(label) + '</span>' +
      '<span style="font-size:7.5px;letter-spacing:.4px;color:#12324e;">' + _esc(ts) + '</span>' +
    '</div>';
  }

  // Section label inside a data box
  function _label(txt) {
    return '<div style="font-size:7.5px;letter-spacing:1.7px;color:#1a5a7a;' +
      'margin-bottom:7px;font-weight:700;">' + _esc(txt) + '</div>';
  }

  // Framed data box
  function _box(inner, mb) {
    return '<div style="background:rgba(3,9,22,0.75);border:1px solid rgba(8,28,56,0.8);' +
      'padding:10px 12px;margin-bottom:' + (mb !== undefined ? mb : 8) + 'px;">' +
      inner + '</div>';
  }

  // 2×N metric grid
  function _metricGrid(cells) {
    var out = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:10px;">';
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      out +=
        '<div style="background:rgba(3,9,22,0.9);' +
          'border:1px solid rgba(8,28,56,0.8);' +
          'border-left:2px solid ' + (c.accent || '#0e4a6a') + ';' +
          'padding:8px 10px;">' +
          '<div style="font-size:7.5px;letter-spacing:1.2px;color:#1a4a62;margin-bottom:5px;' +
            'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
            _esc(c.label) + '</div>' +
          '<div style="font-size:20px;font-weight:700;color:' + (c.accent || '#72eeff') + ';' +
            'letter-spacing:-1px;line-height:1;font-variant-numeric:tabular-nums;">' +
            _esc(String(c.value)) + '</div>' +
          (c.sub
            ? '<div style="font-size:7.5px;color:#153a50;margin-top:4px;">' + _esc(c.sub) + '</div>'
            : '') +
        '</div>';
    }
    return out + '</div>';
  }

  // Horizontal proportion bars — pairs [{k,v,c?}], optional total for % display
  function _bars(pairs, total, accentColor) {
    if (!pairs || !pairs.length) {
      return '<div style="font-size:8px;color:#0e3050;">NO DATA</div>';
    }
    accentColor = accentColor || '#72eeff';
    var maxV = pairs[0].v || 1;
    var out  = '';
    for (var i = 0; i < pairs.length; i++) {
      var p    = pairs[i];
      var barW = Math.round(p.v / maxV * 100);
      var pct  = total ? ' · ' + Math.round(p.v / total * 100) + '%' : '';
      var barC = p.c || accentColor;
      out +=
        '<div style="margin-bottom:5px;">' +
          '<div style="display:flex;justify-content:space-between;' +
            'align-items:baseline;margin-bottom:2px;">' +
            '<span style="font-size:8px;color:#3a7a9a;max-width:155px;overflow:hidden;' +
              'text-overflow:ellipsis;white-space:nowrap;">' + _esc(p.k) + '</span>' +
            '<span style="font-size:7.5px;color:#1a567a;font-variant-numeric:tabular-nums;">' +
              p.v + _esc(pct) + '</span>' +
          '</div>' +
          '<div style="height:2px;background:rgba(8,28,56,0.7);border-radius:1px;">' +
            '<div style="height:2px;width:' + barW + '%;background:' + barC + ';' +
              'opacity:0.75;border-radius:1px;"></div>' +
          '</div>' +
        '</div>';
    }
    return out;
  }

  // Indexed intensity meter — value 0–100
  function _meter(value, label, color) {
    var pct    = Math.max(0, Math.min(100, value || 0));
    var meterC = pct >= 80 ? '#ff2200' : pct >= 60 ? '#ff8800' : pct >= 35 ? color : '#1a6a8a';
    return '<div style="margin-bottom:10px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px;">' +
        '<span style="font-size:8px;letter-spacing:1.5px;color:#1a5070;">' + _esc(label) + '</span>' +
        '<span style="font-size:15px;font-weight:700;color:' + meterC + ';letter-spacing:-0.5px;' +
          'font-variant-numeric:tabular-nums;">' + pct + '</span>' +
      '</div>' +
      '<div style="height:3px;background:rgba(8,28,56,0.7);border-radius:2px;">' +
        '<div style="height:3px;width:' + pct + '%;background:' + meterC + ';' +
          'border-radius:2px;box-shadow:0 0 6px ' + meterC + ';"></div>' +
      '</div>' +
    '</div>';
  }

  // SVG mini trend line — trend: [{d, v}]
  function _trendSvg(trend, label) {
    if (!trend || trend.length < 2) return '';
    var W    = 200;
    var H    = 40;
    var vals = trend.map(function (t) { return t.v; });
    var maxV = Math.max.apply(null, vals) || 1;
    var minV = Math.min.apply(null, vals);
    var rng  = (maxV - minV) || 1;

    var pts  = vals.map(function (v, i) {
      var x = (i / (vals.length - 1)) * W;
      var y = H - ((v - minV) / rng) * (H - 8) - 4;
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');

    var areaPts = '0,' + H + ' ' + pts + ' ' + W + ',' + H;

    var dots = vals.map(function (v, i) {
      var x = (i / (vals.length - 1)) * W;
      var y = H - ((v - minV) / rng) * (H - 8) - 4;
      return '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="2" fill="#72eeff" opacity=".85"/>';
    }).join('');

    return (label ? _label(label) : '') +
      '<svg width="100%" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" ' +
        'style="display:block;height:' + H + 'px;margin-bottom:3px;">' +
        '<defs>' +
          '<linearGradient id="ax-g" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%" stop-color="#4fc3ff" stop-opacity=".22"/>' +
            '<stop offset="100%" stop-color="#4fc3ff" stop-opacity=".01"/>' +
          '</linearGradient>' +
        '</defs>' +
        '<polygon points="' + areaPts + '" fill="url(#ax-g)"/>' +
        '<polyline points="' + pts + '" fill="none" stroke="#4fc3ff" ' +
          'stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/>' +
        dots +
      '</svg>' +
      '<div style="display:flex;justify-content:space-between;">' +
        '<span style="font-size:7px;color:#0d2a40;">' + _esc(trend[0].d) + '</span>' +
        '<span style="font-size:7px;color:#0d2a40;">' + _esc(trend[trend.length - 1].d) + '</span>' +
      '</div>';
  }

  // Loading skeleton
  function _skeleton() {
    return '<div style="padding:20px 0;text-align:center;">' +
      '<div style="font-size:8px;letter-spacing:2px;color:#0e3050;' +
        'animation:ax-blink 1.4s ease-in-out infinite;">FETCHING TELEMETRY</div>' +
    '</div>';
  }

  // Error state
  function _errState(msg) {
    return '<div style="padding:9px 12px;border:1px solid rgba(200,40,0,0.2);' +
      'background:rgba(200,40,0,0.04);margin-bottom:8px;">' +
      '<span style="font-size:8px;letter-spacing:1.2px;color:#cc3300;">' +
        _esc(msg || 'FEED OFFLINE') + '</span>' +
    '</div>';
  }

  // ── GEM render ────────────────────────────────────────────────────────────────
  function _renderGem() {
    var s  = _state.gem;
    var ts = _fmtTs(s.ts);
    var out = _tabHeader('GLOBAL ENERGY & MACRO', ts, '#4fc3ff');

    if (!s.metrics) {
      return out + (s.error ? _errState(s.error) : _skeleton());
    }
    var m      = s.metrics;
    var opPct  = m.total ? Math.round(m.operational  / m.total * 100) : 0;
    var conPct = m.total ? Math.round(m.construction / m.total * 100) : 0;

    out += _metricGrid([
      { label: 'INFRASTRUCTURE',  value: _fmtN(m.total),        accent: '#4fc3ff', sub: 'tracked globally' },
      { label: 'OPERATIONAL',     value: _fmtN(m.operational),  accent: '#00cc77', sub: opPct  + '% of total' },
      { label: 'UNDER CONSTR.',   value: _fmtN(m.construction), accent: '#ffaa00', sub: conPct + '% pipeline' },
      { label: 'NATIONS',         value: _fmtN(m.countries),    accent: '#72eeff', sub: 'coverage footprint' },
    ]);

    out += _box(_label('ENERGY FUEL MATRIX')       + _bars(m.byFuel,       m.total, '#4fc3ff'));
    out += _box(_label('FACILITY TYPE BREAKDOWN')   + _bars(m.byType,       m.total, '#2299cc'));
    out += _box(_label('OPERATIONAL STATUS')        + _bars(m.byStatus,     m.total, '#00cc77'));
    out += _box(_label('TOP NATIONS BY COVERAGE')   + _bars(m.topCountries, null,    '#0ea5e9'), 0);

    return out;
  }

  // ── NOAA render ───────────────────────────────────────────────────────────────
  function _renderNoaa() {
    var s  = _state.noaa;
    var ts = _fmtTs(s.ts);
    var out = _tabHeader('ATMOSPHERIC INTELLIGENCE', ts, '#72eeff');

    if (!s.metrics) {
      return out + (s.error ? _errState(s.error) : _skeleton());
    }
    var m = s.metrics;

    out += _metricGrid([
      { label: 'ACTIVE ALERTS', value: m.total,    accent: '#72eeff', sub: 'NWS + NHC combined' },
      { label: 'EXTREME SEV.',  value: m.extreme,  accent: m.extreme  > 0 ? '#ff00cc' : '#72eeff', sub: 'critical systems' },
      { label: 'SEVERE SEV.',   value: m.severe,   accent: m.severe   > 0 ? '#ff4400' : '#4fc3ff', sub: 'major impact' },
      { label: 'CYCLONE SYS.', value: m.cyclones, accent: '#4fc3ff', sub: 'tropical activity' },
    ]);

    out += _meter(m.intensity, 'STORM INTENSITY INDEX', '#72eeff');

    // Severity distribution — colored bars per severity tier
    var sevHtml = _label('SEVERITY DISTRIBUTION');
    for (var i = 0; i < m.bySeverity.length; i++) {
      var sv = m.bySeverity[i];
      if (!sv.v) continue;
      var pct = Math.round(sv.v / Math.max(1, m.total) * 100);
      sevHtml +=
        '<div style="margin-bottom:5px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:2px;">' +
            '<span style="font-size:8px;color:' + sv.c + ';letter-spacing:1px;opacity:0.9;">' + _esc(sv.k) + '</span>' +
            '<span style="font-size:7.5px;color:#1a567a;">' + sv.v + ' · ' + pct + '%</span>' +
          '</div>' +
          '<div style="height:2px;background:rgba(8,28,56,0.7);">' +
            '<div style="height:2px;width:' + pct + '%;background:' + sv.c + ';opacity:0.85;"></div>' +
          '</div>' +
        '</div>';
    }
    out += _box(sevHtml);
    out += _box(_label('ALERT TYPE FREQUENCY') + _bars(m.topTypes, m.total, '#72eeff'), 0);

    return out;
  }

  // ── ACLED render ──────────────────────────────────────────────────────────────
  function _renderAcled() {
    var s  = _state.acled;
    var ts = _fmtTs(s.ts);
    var out = _tabHeader('CONFLICT & INSTABILITY INTEL', ts, '#ff6644');

    if (!s.metrics) {
      return out + (s.error ? _errState(s.error) : _skeleton());
    }
    var m = s.metrics;

    var fatAccent = m.fatalities > 500 ? '#ff2200' : m.fatalities > 100 ? '#ff5500' : '#ff9966';

    out += _metricGrid([
      { label: 'TOTAL EVENTS',   value: _fmtN(m.total),      accent: '#ff6644', sub: 'active feed window' },
      { label: 'FATALITIES',     value: _fmtN(m.fatalities), accent: fatAccent, sub: 'reported casualties' },
      { label: 'ACTIVE REGIONS', value: m.regions,           accent: '#ffaa44', sub: 'geographic spread' },
      { label: 'ACTIVE ACTORS',  value: m.actors,            accent: '#cc8844', sub: 'identified parties' },
    ]);

    out += _meter(m.escalation, 'ESCALATION INDEX', '#ff6644');

    if (m.trend && m.trend.length >= 2) {
      out += _box(_trendSvg(m.trend, 'EVENT TEMPO — 14-DAY WINDOW'));
    }

    out += _box(_label('EVENT TYPE BREAKDOWN')   + _bars(m.byType,       m.total, '#ff6644'));
    out += _box(_label('HIGH-ACTIVITY REGIONS')  + _bars(m.topRegions,   null,    '#ff8844'));
    out += _box(_label('TOP NATIONS BY EVENTS')  + _bars(m.topCountries, null,    '#ffaa44'));

    if (m.topActors && m.topActors.length) {
      out += _box(_label('ACTOR ACTIVITY INDEX') + _bars(m.topActors, null, '#cc6633'), 0);
    }

    return out;
  }

  // ── CSS injection ─────────────────────────────────────────────────────────────
  function _injectStyles() {
    if (document.getElementById('ax-css')) return;
    var el = document.createElement('style');
    el.id = 'ax-css';
    el.textContent =
      '@keyframes ax-blink{0%,100%{opacity:1}50%{opacity:0.15}}' +

      // Tab buttons
      '.ax-tab{' +
        'flex:1;background:transparent;border:none;' +
        'border-bottom:2px solid transparent;' +
        'color:rgba(50,110,150,0.32);' +
        'font-size:8px;letter-spacing:2px;' +
        'padding:8px 4px;cursor:pointer;' +
        'transition:color 160ms ease,border-color 160ms ease,text-shadow 160ms ease;' +
        'font-family:inherit;text-align:center;font-weight:700;outline:none;}' +
      '.ax-tab:hover{color:rgba(72,150,190,0.6);}' +

      // Per-tab active color
      '.ax-tab-gem.ax-on{'  + 'color:#4fc3ff;border-bottom-color:#4fc3ff;text-shadow:0 0 8px rgba(79,195,255,0.5);}' +
      '.ax-tab-noaa.ax-on{' + 'color:#72eeff;border-bottom-color:#72eeff;text-shadow:0 0 8px rgba(114,238,255,0.5);}' +
      '.ax-tab-acled.ax-on{color:#ff6644;border-bottom-color:#ff6644;text-shadow:0 0 8px rgba(255,102,68,0.4);}' +

      // Pane visibility + fade-in
      '.ax-pane{display:none;}' +
      '.ax-pane.ax-show{display:block;animation:ax-fadein 160ms ease;}' +
      '@keyframes ax-fadein{from{opacity:0}to{opacity:1}}';

    document.head.appendChild(el);
  }

  // ── Shell ─────────────────────────────────────────────────────────────────────
  function _buildShell() {
    return '<div id="ax-root" style="font-family:var(--font-mono,\'Courier New\',monospace);">' +
      '<div id="ax-tabbar" style="display:flex;border-bottom:1px solid rgba(8,24,50,0.95);margin-bottom:14px;">' +
        '<button class="ax-tab ax-tab-gem ax-on"  data-ax="gem">GEM</button>' +
        '<button class="ax-tab ax-tab-noaa"        data-ax="noaa">NOAA</button>' +
        '<button class="ax-tab ax-tab-acled"       data-ax="acled">ACLED</button>' +
      '</div>' +
      '<div id="ax-pane-gem"   class="ax-pane ax-show"></div>' +
      '<div id="ax-pane-noaa"  class="ax-pane"></div>' +
      '<div id="ax-pane-acled" class="ax-pane"></div>' +
    '</div>';
  }

  // ── DOM mount ─────────────────────────────────────────────────────────────────
  function _mount() {
    var body = document.getElementById('nw-analytics-body');
    if (!body) return false;

    // Suppress old placeholder
    var ph = document.getElementById('nw-analytics-placeholder');
    if (ph) ph.style.display = 'none';

    // Inject shell if not already present
    if (!document.getElementById('ax-root')) {
      var tmp = document.createElement('div');
      tmp.innerHTML = _buildShell();
      body.appendChild(tmp.firstChild);
    }

    // Wire tab clicks
    var tabbar = document.getElementById('ax-tabbar');
    if (tabbar) {
      tabbar.addEventListener('click', function (e) {
        var btn = e.target;
        if (!btn || typeof btn.getAttribute !== 'function') return;
        var tab = btn.getAttribute('data-ax');
        if (tab) _switchTab(tab);
      });
    }

    _mounted = true;
    return true;
  }

  // ── Tab switching ─────────────────────────────────────────────────────────────
  function _switchTab(tab) {
    _activeTab = tab;

    var btns = document.querySelectorAll('#ax-tabbar .ax-tab');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.remove('ax-on');
    }
    var active = document.querySelector('#ax-tabbar [data-ax="' + tab + '"]');
    if (active) active.classList.add('ax-on');

    var allTabs = ['gem', 'noaa', 'acled'];
    for (var j = 0; j < allTabs.length; j++) {
      var pane = document.getElementById('ax-pane-' + allTabs[j]);
      if (!pane) continue;
      if (allTabs[j] === tab) pane.classList.add('ax-show');
      else                     pane.classList.remove('ax-show');
    }

    // Fetch if this pane has never loaded
    if (!_state[tab].metrics && !_state[tab].loading) _pollTab(tab);
  }

  // ── Repaint ───────────────────────────────────────────────────────────────────
  function _repaint(tab) {
    var pane = document.getElementById('ax-pane-' + tab);
    if (!pane) return;
    var html = tab === 'gem' ? _renderGem() : tab === 'noaa' ? _renderNoaa() : _renderAcled();
    pane.innerHTML = html;
  }

  // ── Polling ───────────────────────────────────────────────────────────────────
  function _pollTab(tab) {
    var url = tab === 'gem' ? GEM_FN : tab === 'noaa' ? NOAA_FN : ACLED_FN;
    var s   = _state[tab];
    s.loading = true;
    // Show skeleton only on first load (don't flash existing data on refresh)
    if (!s.metrics) _repaint(tab);

    _fetch(url)
      .then(function (json) {
        s.loading = false;
        s.ts      = Date.now();
        s.error   = null;
        s.metrics = tab === 'gem'
          ? _normalizeGem(json)
          : tab === 'noaa'
          ? _normalizeNoaa(json)
          : _normalizeAcled(json);
        _repaint(tab);
      })
      .catch(function (err) {
        s.loading = false;
        s.error   = (err && err.message) || 'FETCH ERROR';
        _repaint(tab);
      });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────
  function init() {
    if (_initialized) return;
    _initialized = true;

    _injectStyles();

    if (!_mount()) {
      _initialized = false;
      setTimeout(init, 800);
      return;
    }

    // Staggered initial polls — avoid simultaneous cold-start burst
    _pollTab('gem');
    setTimeout(function () { _pollTab('noaa');  }, 4000);
    setTimeout(function () { _pollTab('acled'); }, 8000);

    // Periodic refresh timers
    _timers.gem   = setInterval(function () { _pollTab('gem');   }, POLL_GEM);
    _timers.noaa  = setInterval(function () { _pollTab('noaa');  }, POLL_NOAA);
    _timers.acled = setInterval(function () { _pollTab('acled'); }, POLL_ACLED);
  }

  function refresh() {
    _pollTab('gem');
    _pollTab('noaa');
    _pollTab('acled');
  }

  function status() {
    return {
      activeTab:   _activeTab,
      initialized: _initialized,
      mounted:     _mounted,
      gem:   { hasData: !!_state.gem.metrics,   ts: _state.gem.ts,   error: _state.gem.error   },
      noaa:  { hasData: !!_state.noaa.metrics,  ts: _state.noaa.ts,  error: _state.noaa.error  },
      acled: { hasData: !!_state.acled.metrics, ts: _state.acled.ts, error: _state.acled.error },
    };
  }

  // ── Auto-init wiring ──────────────────────────────────────────────────────────
  // Lazy init — fires on first Analytics tab click so the globe/neural
  // web systems have fully settled before we touch the DOM.
  setTimeout(function () {
    var btn = document.querySelector('.nw-tab-btn[data-tab="analytics"]');
    if (btn) {
      btn.addEventListener('click', function () {
        if (!_initialized) init();
      });
    }
    // Also init immediately if the analytics pane is already active on load
    var pane = document.getElementById('nw-pane-analytics');
    if (pane && pane.classList.contains('is-active')) init();
  }, 1500);

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusAnalytics');

  return { init: init, refresh: refresh, status: status };

}());
