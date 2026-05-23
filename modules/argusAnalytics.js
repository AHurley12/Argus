'use strict';
// modules/argusAnalytics.js
// Unified intelligence analytics workspace — AIS | PORT WATCH | NOAA | INTEL
//
// Architecture:
//   Four isolated analytics modules inside the Neural Web Analytics tab.
//   AIS + PORT WATCH read live global state (no network fetch).
//   NOAA + INTEL (ACLED/GEM) fetch from Netlify functions on independent timers.
//   Expand mode transitions #nw-intel-panel width: 272→500px (180ms).
//
// Data bridges:
//   AIS    — window.ArgusNeuralWeb.getAnalyticsData() → {snap, cpAnalytics}
//   PORTS  — window.ArgusNeuralWeb.getPortAnalytics() → portAnalytics object
//   NOAA   — /.netlify/functions/fetch-noaa
//   ACLED  — /.netlify/functions/fetch-acled
//   GEM    — /.netlify/functions/fetch-gem
//
// Globals:
//   window.ArgusAnalytics — { init, refresh, status }
//
// Load order: after argusNeuralWeb.js

window.ArgusAnalytics = (function () {
  'use strict';

  // ── Endpoints + poll intervals ────────────────────────────────────────────────
  var NOAA_FN  = '/.netlify/functions/fetch-noaa';
  var ACLED_FN = '/.netlify/functions/fetch-acled';
  var GEM_FN   = '/.netlify/functions/fetch-gem';

  var POLL_NOAA  = 15 * 60 * 1000;
  var POLL_ACLED = 30 * 60 * 1000;
  var POLL_GEM   = 30 * 60 * 1000;
  var REFRESH_AIS_MS   =  30 * 1000;   // reads live state, no fetch
  var REFRESH_PORTS_MS =  60 * 1000;

  // ── Module state ──────────────────────────────────────────────────────────────
  var _initialized = false;
  var _mounted     = false;
  var _activeTab   = 'ais';
  var _expanded    = false;

  var _state = {
    ais:   { data: null, ts: null },
    ports: { data: null, ts: null },
    noaa:  { metrics: null, ts: null, loading: false, error: null },
    intel: { gem: null, acled: null, ts: null, loading: false, error: null },
  };

  var _timers = {};

  // ── Fetch (shared request cache when available) ───────────────────────────────
  function _fetch(url) {
    var rc = window._argusReqCache;
    if (rc && typeof rc.fetch === 'function') return rc.fetch(url);
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // ── Shared utilities ──────────────────────────────────────────────────────────
  var _ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return _ESC[c]; });
  }

  function _fmtTs(ts) {
    if (!ts) return '--:--:-- UTC';
    var d = new Date(ts);
    return ('0' + d.getUTCHours()).slice(-2) + ':' +
           ('0' + d.getUTCMinutes()).slice(-2) + ':' +
           ('0' + d.getUTCSeconds()).slice(-2) + ' UTC';
  }

  function _fmtN(n) {
    if (n == null || isNaN(n)) return '--';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }

  function _sortDesc(obj, limit) {
    var arr = [];
    for (var k in obj) { if (obj.hasOwnProperty(k)) arr.push({ k: k, v: obj[k] }); }
    arr.sort(function (a, b) { return b.v - a.v; });
    return arr.slice(0, limit || 8);
  }

  // Blinking live indicator
  function _dot(color) {
    return '<span style="display:inline-block;width:5px;height:5px;border-radius:50%;' +
      'background:' + color + ';box-shadow:0 0 5px ' + color + ';' +
      'animation:ax-blink 2s ease-in-out infinite;vertical-align:middle;' +
      'margin-right:6px;flex-shrink:0;"></span>';
  }

  // Tab section header
  function _tabHeader(label, ts, color) {
    return '<div style="display:flex;align-items:center;justify-content:space-between;' +
      'margin-bottom:12px;padding-bottom:7px;border-bottom:1px solid rgba(10,28,55,0.9);">' +
      '<span style="font-size:9px;letter-spacing:1.8px;color:' + color + ';font-weight:700;' +
        'display:flex;align-items:center;">' + _dot(color) + _esc(label) + '</span>' +
      '<span style="font-size:7.5px;letter-spacing:.4px;color:#12324e;">' + _esc(ts) + '</span>' +
    '</div>';
  }

  // Section divider (between sub-sections within a pane)
  function _divider(label, color) {
    color = color || '#1a5a7a';
    return '<div style="display:flex;align-items:center;gap:8px;margin:12px 0 10px;">' +
      '<div style="flex:1;height:1px;background:rgba(10,28,55,0.8);"></div>' +
      '<span style="font-size:7.5px;letter-spacing:1.8px;color:' + color + ';font-weight:700;">' + _esc(label) + '</span>' +
      '<div style="flex:1;height:1px;background:rgba(10,28,55,0.8);"></div>' +
    '</div>';
  }

  // Section label inside a box
  function _lbl(txt) {
    return '<div style="font-size:7.5px;letter-spacing:1.7px;color:#1a5a7a;margin-bottom:7px;font-weight:700;">' + _esc(txt) + '</div>';
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
        '<div style="background:rgba(3,9,22,0.9);border:1px solid rgba(8,28,56,0.8);' +
          'border-left:2px solid ' + (c.accent || '#0e4a6a') + ';padding:8px 10px;">' +
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

  // Proportion bars — pairs [{k,v,c?}]
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
          '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:2px;">' +
            '<span style="font-size:8px;color:#3a7a9a;max-width:155px;overflow:hidden;' +
              'text-overflow:ellipsis;white-space:nowrap;">' + _esc(p.k) + '</span>' +
            '<span style="font-size:7.5px;color:#1a567a;font-variant-numeric:tabular-nums;">' +
              p.v + _esc(pct) + '</span>' +
          '</div>' +
          '<div style="height:2px;background:rgba(8,28,56,0.7);border-radius:1px;">' +
            '<div style="height:2px;width:' + barW + '%;background:' + barC + ';opacity:0.8;border-radius:1px;"></div>' +
          '</div>' +
        '</div>';
    }
    return out;
  }

  // Indexed intensity meter 0–100
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

  // SVG mini trend line
  function _trendSvg(trend, label) {
    if (!trend || trend.length < 2) return '';
    var W    = 200;
    var H    = 38;
    var vals = trend.map(function (t) { return t.v; });
    var maxV = Math.max.apply(null, vals) || 1;
    var minV = Math.min.apply(null, vals);
    var rng  = (maxV - minV) || 1;
    var pts  = vals.map(function (v, i) {
      var x = (i / (vals.length - 1)) * W;
      var y = H - ((v - minV) / rng) * (H - 8) - 4;
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    var area = '0,' + H + ' ' + pts + ' ' + W + ',' + H;
    var dots = vals.map(function (v, i) {
      var x = (i / (vals.length - 1)) * W;
      var y = H - ((v - minV) / rng) * (H - 8) - 4;
      return '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="1.8" fill="#72eeff" opacity=".85"/>';
    }).join('');
    return (label ? _lbl(label) : '') +
      '<svg width="100%" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" ' +
        'style="display:block;height:' + H + 'px;margin-bottom:3px;">' +
        '<defs><linearGradient id="ax-g" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="#4fc3ff" stop-opacity=".2"/>' +
          '<stop offset="100%" stop-color="#4fc3ff" stop-opacity=".01"/>' +
        '</linearGradient></defs>' +
        '<polygon points="' + area + '" fill="url(#ax-g)"/>' +
        '<polyline points="' + pts + '" fill="none" stroke="#4fc3ff" ' +
          'stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/>' +
        dots +
      '</svg>' +
      '<div style="display:flex;justify-content:space-between;">' +
        '<span style="font-size:7px;color:#0d2a40;">' + _esc(trend[0].d || '') + '</span>' +
        '<span style="font-size:7px;color:#0d2a40;">' + _esc(trend[trend.length - 1].d || '') + '</span>' +
      '</div>';
  }

  function _skeleton() {
    return '<div style="padding:20px 0;text-align:center;">' +
      '<div style="font-size:8px;letter-spacing:2px;color:#0e3050;' +
        'animation:ax-blink 1.4s ease-in-out infinite;">FETCHING TELEMETRY</div>' +
    '</div>';
  }

  function _noData(msg) {
    return '<div style="padding:16px 0;text-align:center;">' +
      '<div style="font-size:8px;letter-spacing:1.5px;color:#0e3050;line-height:2;">' +
        _esc(msg || 'NO DATA') + '</div>' +
    '</div>';
  }

  function _errState(msg) {
    return '<div style="padding:9px 12px;border:1px solid rgba(200,40,0,0.2);' +
      'background:rgba(200,40,0,0.04);margin-bottom:8px;">' +
      '<span style="font-size:8px;letter-spacing:1.2px;color:#cc3300;">' +
        _esc(msg || 'FEED OFFLINE') + '</span>' +
    '</div>';
  }

  // ── AIS normalization ─────────────────────────────────────────────────────────
  var SHIP_COLORS = {
    cargo:     '#4488ff',
    tanker:    '#ff9933',
    military:  '#ff4444',
    passenger: '#00cc77',
    fishing:   '#ffcc00',
    other:     '#4a7a9a',
  };

  var FLIGHT_COLORS = {
    commercial: '#66ddff',
    cargo:      '#4488ff',
    military:   '#ff4444',
    private:    '#cc99ff',
    unknown:    '#4a7a9a',
  };

  function _cpStressColor(ships) {
    if (ships >= 30) return '#ff2200';
    if (ships >= 15) return '#ff8800';
    if (ships >= 5)  return '#4488ff';
    return '#1a5a8a';
  }

  function _normalizeAIS(snap, cpAnalytics) {
    var ships   = snap ? (snap.ships   || []) : [];
    var flights = snap ? (snap.flights || []) : [];

    var shipCatCounts   = {};
    var flightCatCounts = {};

    ships.forEach(function (s) {
      var k = s.category || 'other';
      shipCatCounts[k] = (shipCatCounts[k] || 0) + 1;
    });
    flights.forEach(function (f) {
      var k = f.category || 'unknown';
      flightCatCounts[k] = (flightCatCounts[k] || 0) + 1;
    });

    // Vessel type pairs with color coding
    var shipPairs = _sortDesc(shipCatCounts, 6).map(function (p) {
      return { k: p.k.toUpperCase(), v: p.v, c: SHIP_COLORS[p.k] || '#4a7a9a' };
    });
    var flightPairs = _sortDesc(flightCatCounts, 4).map(function (p) {
      return { k: p.k.toUpperCase(), v: p.v, c: FLIGHT_COLORS[p.k] || '#4a7a9a' };
    });

    // Tanker count (strategic metric)
    var tankers  = shipCatCounts.tanker  || 0;
    var military = (shipCatCounts.military || 0) + (flightCatCounts.military || 0);

    // Chokepoint stress — sorted by ship count
    var cpList = [];
    if (cpAnalytics) {
      Object.keys(cpAnalytics).forEach(function (id) {
        var cp = cpAnalytics[id];
        cpList.push({
          k: cp.label || id,
          v: cp.shipCount || 0,
          c: _cpStressColor(cp.shipCount || 0),
        });
      });
      cpList.sort(function (a, b) { return b.v - a.v; });
    }

    return {
      ships:      ships.length,
      flights:    flights.length,
      tankers:    tankers,
      military:   military,
      shipPairs:  shipPairs,
      flightPairs: flightPairs,
      chokepoints: cpList.slice(0, 8),
      hasData:    (ships.length + flights.length) > 0,
    };
  }

  // ── Port Watch normalization ───────────────────────────────────────────────────
  function _normalizePort(pa) {
    if (!pa) return null;
    var G = pa.global;

    // Top 8 ports globally (flatten from regions)
    var allPorts = [];
    if (pa.topPortsByRegion) {
      Object.keys(pa.topPortsByRegion).forEach(function (r) {
        (pa.topPortsByRegion[r] || []).forEach(function (p) {
          allPorts.push(p);
        });
      });
    }
    allPorts.sort(function (a, b) { return b.calls - a.calls; });
    var topPorts = allPorts.slice(0, 7).map(function (p) {
      return {
        k: p.name + (p.country ? ' · ' + p.country : ''),
        v: p.calls,
        c: p.chokepointId ? '#ffcc00' : '#00ccff',
      };
    });

    // Top 6 regions by port calls
    var topRegions = (pa.regions || []).slice(0, 6).map(function (R) {
      return {
        k: R.name,
        v: R.totalCalls,
        c: R.dominantCargo === 'TANKER' ? '#ff9933' : '#4488ff',
      };
    });

    return {
      portCount:  pa.portCount,
      calls:      G.totalCalls,
      imports:    G.imports,
      exports:    G.exports,
      balance:    G.balance,
      ieRatio:    G.ieRatio,
      contPct:    G.contPct,
      tankPct:    G.tankPct,
      period:     pa.period,
      topPorts:   topPorts,
      topRegions: topRegions,
    };
  }

  // ── NOAA normalization ────────────────────────────────────────────────────────
  function _normalizeNoaa(raw) {
    if (!raw || !Array.isArray(raw.alerts)) return null;
    var alerts = raw.alerts;
    var sev    = { Extreme: 0, Severe: 0, Moderate: 0, Minor: 0 };
    var byType = {};
    var cyclones = 0;
    var CY_RE  = /hurricane|typhoon|cyclone|tropical/i;
    for (var i = 0; i < alerts.length; i++) {
      var al = alerts[i];
      var s  = al.severity || 'Minor';
      if (sev.hasOwnProperty(s)) sev[s]++; else sev.Minor++;
      var et = al.eventType || 'Unknown';
      byType[et] = (byType[et] || 0) + 1;
      if (CY_RE.test(et)) cyclones++;
    }
    var n = Math.max(1, alerts.length);
    var intensity = Math.min(100, Math.round(
      (sev.Extreme * 12 + sev.Severe * 5 + sev.Moderate * 2 + sev.Minor * 0.5) / n * 16
    ));
    return {
      total: alerts.length, extreme: sev.Extreme, severe: sev.Severe,
      moderate: sev.Moderate, minor: sev.Minor, cyclones: cyclones,
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

  // ── ACLED normalization ───────────────────────────────────────────────────────
  function _normalizeAcled(raw) {
    if (!raw || !Array.isArray(raw.events)) return null;
    var events = raw.events;
    var byType = {}, byRegion = {}, byCountry = {}, byDate = {}, actors = {};
    var fatalities = 0;
    for (var i = 0; i < events.length; i++) {
      var ev   = events[i];
      var type = ev.eventType  || 'Unknown';
      var reg  = ev.region     || ev.country || 'Unknown';
      var ctry = ev.country    || 'Unknown';
      var date = ev.date       || null;
      byType[type]   = (byType[type]   || 0) + 1;
      byRegion[reg]  = (byRegion[reg]  || 0) + 1;
      byCountry[ctry]= (byCountry[ctry]|| 0) + 1;
      fatalities += (ev.fatalities || 0);
      if (ev.actor1) actors[ev.actor1] = (actors[ev.actor1] || 0) + 1;
      if (ev.actor2) actors[ev.actor2] = (actors[ev.actor2] || 0) + 1;
      if (date) byDate[date] = (byDate[date] || 0) + 1;
    }
    var dates = Object.keys(byDate).sort().slice(-14);
    var trend = dates.map(function (d) { return { d: d, v: byDate[d] }; });
    var escalation = Math.min(100, Math.round(
      (events.length / Math.max(1, dates.length)) *
      (1 + (fatalities / Math.max(1, events.length)) * 0.3)
    ));
    return {
      total: events.length, fatalities: fatalities,
      regions: Object.keys(byRegion).length,
      actors:  Object.keys(actors).length,
      escalation: escalation,
      byType:      _sortDesc(byType,    7),
      topRegions:  _sortDesc(byRegion,  5),
      topCountries:_sortDesc(byCountry, 5),
      trend:       trend,
    };
  }

  // ── GEM normalization ─────────────────────────────────────────────────────────
  function _normalizeGem(raw) {
    if (!raw || !Array.isArray(raw.infrastructure)) return null;
    var items = raw.infrastructure;
    var byFuel = {}, byStatus = {}, byType = {}, byCountry = {};
    var operational = 0, construction = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
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
      total: items.length, operational: operational, construction: construction,
      countries: Object.keys(byCountry).length,
      byFuel:   _sortDesc(byFuel,   6),
      byType:   _sortDesc(byType,   6),
      byStatus: _sortDesc(byStatus, 5),
    };
  }

  // ── AIS render ────────────────────────────────────────────────────────────────
  function _renderAIS() {
    var s   = _state.ais;
    var ts  = _fmtTs(s.ts);
    var out = _tabHeader('MARITIME INTELLIGENCE', ts, '#4488ff');

    if (!s.data || !s.data.hasData) {
      return out + _noData('ENABLE AIS OR AIRCRAFT LAYER\nTO LOAD LIVE FEED');
    }
    var d = s.data;

    out += _metricGrid([
      { label: 'VESSELS',    value: _fmtN(d.ships),   accent: '#4488ff', sub: 'live AIS feed' },
      { label: 'FLIGHTS',    value: _fmtN(d.flights),  accent: '#66ddff', sub: 'ADS-B tracked' },
      { label: 'TANKERS',    value: _fmtN(d.tankers),  accent: '#ff9933', sub: 'energy cargo' },
      { label: 'MILITARY',   value: _fmtN(d.military), accent: '#ff4444', sub: 'tracked contacts' },
    ]);

    if (d.shipPairs && d.shipPairs.length) {
      out += _box(_lbl('VESSEL FLEET COMPOSITION') + _bars(d.shipPairs, d.ships, '#4488ff'));
    }
    if (d.flightPairs && d.flightPairs.length) {
      out += _box(_lbl('FLIGHT CATEGORY MIX') + _bars(d.flightPairs, d.flights, '#66ddff'));
    }
    if (d.chokepoints && d.chokepoints.length) {
      out += _box(_lbl('CHOKEPOINT TRAFFIC DENSITY') + _bars(d.chokepoints, null, '#4488ff'), 0);
    }

    return out;
  }

  // ── Port Watch render ─────────────────────────────────────────────────────────
  function _renderPorts() {
    var s   = _state.ports;
    var ts  = _fmtTs(s.ts);
    var out = _tabHeader('IMF PORT WATCH', ts, '#00ccff');

    if (!s.data) {
      return out + _noData('PORTWATCH LAYER LOADING...\nEnable vessel layer for AIS cross-layer data.');
    }
    var d = s.data;

    var ieCol  = d.ieRatio
      ? (d.ieRatio > 1.2 ? '#00cc77' : d.ieRatio < 0.83 ? '#ff9933' : '#4a7da8')
      : '#4a7da8';
    var balCol = d.balance > 0 ? '#00cc77' : d.balance < 0 ? '#ff4466' : '#4a7da8';
    var ieLabel = d.ieRatio
      ? (d.ieRatio > 1.1 ? 'import-heavy' : d.ieRatio < 0.9 ? 'export-heavy' : 'balanced')
      : '--';

    out += _metricGrid([
      { label: 'PORT CALLS',  value: _fmtN(d.calls),   accent: '#00ccff', sub: (d.period || '') + ' · ' + d.portCount + ' ports' },
      { label: 'IMPORTS',     value: _fmtN(d.imports),  accent: '#00cc77', sub: 'container + tanker' },
      { label: 'EXPORTS',     value: _fmtN(d.exports),  accent: '#ff9933', sub: 'container + tanker' },
      { label: 'I/E RATIO',   value: d.ieRatio ? d.ieRatio.toFixed(2) + ':1' : '--', accent: ieCol, sub: ieLabel },
    ]);

    // Cargo mix
    var cargoHtml = _lbl('GLOBAL CARGO MIX');
    cargoHtml +=
      '<div style="margin-bottom:5px;">' +
        '<div style="display:flex;justify-content:space-between;margin-bottom:2px;">' +
          '<span style="font-size:8px;color:#4488ff;">CONTAINER</span>' +
          '<span style="font-size:7.5px;color:#1a567a;">' + d.contPct + '%</span>' +
        '</div>' +
        '<div style="height:2px;background:rgba(8,28,56,0.7);">' +
          '<div style="height:2px;width:' + d.contPct + '%;background:#4488ff;opacity:0.8;"></div>' +
        '</div>' +
      '</div>' +
      '<div style="margin-bottom:0;">' +
        '<div style="display:flex;justify-content:space-between;margin-bottom:2px;">' +
          '<span style="font-size:8px;color:#ff9933;">TANKER</span>' +
          '<span style="font-size:7.5px;color:#1a567a;">' + d.tankPct + '%</span>' +
        '</div>' +
        '<div style="height:2px;background:rgba(8,28,56,0.7);">' +
          '<div style="height:2px;width:' + d.tankPct + '%;background:#ff9933;opacity:0.8;"></div>' +
        '</div>' +
      '</div>';
    out += _box(cargoHtml);

    if (d.topRegions && d.topRegions.length) {
      out += _box(_lbl('REGIONAL ACTIVITY RANKING') + _bars(d.topRegions, d.calls, '#00ccff'));
    }
    if (d.topPorts && d.topPorts.length) {
      out += _box(
        _lbl('TOP PORTS BY CALLS') +
        '<div style="font-size:7px;color:#0d2a40;margin-bottom:6px;">⬡ = CHOKEPOINT ADJACENT</div>' +
        _bars(d.topPorts, d.calls, '#00ccff'),
        0
      );
    }

    return out;
  }

  // ── NOAA render ───────────────────────────────────────────────────────────────
  function _renderNoaa() {
    var s   = _state.noaa;
    var ts  = _fmtTs(s.ts);
    var out = _tabHeader('ATMOSPHERIC INTELLIGENCE', ts, '#72eeff');

    if (!s.metrics) {
      return out + (s.error ? _errState(s.error) : _skeleton());
    }
    var m = s.metrics;

    out += _metricGrid([
      { label: 'ACTIVE ALERTS', value: m.total,    accent: '#72eeff', sub: 'NWS + NHC' },
      { label: 'EXTREME SEV.',  value: m.extreme,  accent: m.extreme  > 0 ? '#ff00cc' : '#72eeff', sub: 'critical' },
      { label: 'SEVERE SEV.',   value: m.severe,   accent: m.severe   > 0 ? '#ff4400' : '#4fc3ff', sub: 'major impact' },
      { label: 'CYCLONE SYS.', value: m.cyclones, accent: '#4fc3ff', sub: 'tropical' },
    ]);

    out += _meter(m.intensity, 'STORM INTENSITY INDEX', '#72eeff');

    var sevHtml = _lbl('SEVERITY DISTRIBUTION');
    for (var i = 0; i < m.bySeverity.length; i++) {
      var sv = m.bySeverity[i];
      if (!sv.v) continue;
      var pct = Math.round(sv.v / Math.max(1, m.total) * 100);
      sevHtml +=
        '<div style="margin-bottom:5px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:2px;">' +
            '<span style="font-size:8px;color:' + sv.c + ';letter-spacing:1px;">' + _esc(sv.k) + '</span>' +
            '<span style="font-size:7.5px;color:#1a567a;">' + sv.v + ' · ' + pct + '%</span>' +
          '</div>' +
          '<div style="height:2px;background:rgba(8,28,56,0.7);">' +
            '<div style="height:2px;width:' + pct + '%;background:' + sv.c + ';opacity:0.85;"></div>' +
          '</div>' +
        '</div>';
    }
    out += _box(sevHtml);
    out += _box(_lbl('ALERT TYPE FREQUENCY') + _bars(m.topTypes, m.total, '#72eeff'), 0);

    return out;
  }

  // ── INTEL render (ACLED + GEM) ────────────────────────────────────────────────
  function _renderIntel() {
    var s   = _state.intel;
    var ts  = _fmtTs(s.ts);
    var out = _tabHeader('CONFLICT & ENERGY INTEL', ts, '#cc99ff');

    if (!s.acled && !s.gem) {
      return out + (s.error ? _errState(s.error) : _skeleton());
    }

    // ── ACLED section ──────────────────────────────────────────────────────────
    if (s.acled) {
      var ac = s.acled;
      var fatAccent = ac.fatalities > 500 ? '#ff2200' : ac.fatalities > 100 ? '#ff5500' : '#ff9966';

      out += _metricGrid([
        { label: 'EVENTS',       value: _fmtN(ac.total),      accent: '#ff6644', sub: 'active feed' },
        { label: 'FATALITIES',   value: _fmtN(ac.fatalities), accent: fatAccent, sub: 'reported' },
        { label: 'REGIONS',      value: ac.regions,           accent: '#ffaa44', sub: 'geographic spread' },
        { label: 'ACTORS',       value: ac.actors,            accent: '#cc8844', sub: 'identified' },
      ]);

      out += _meter(ac.escalation, 'ESCALATION INDEX', '#ff6644');

      if (ac.trend && ac.trend.length >= 2) {
        out += _box(_trendSvg(ac.trend, 'EVENT TEMPO — 14-DAY WINDOW'));
      }
      out += _box(_lbl('EVENT TYPE BREAKDOWN')  + _bars(ac.byType, ac.total, '#ff6644'));
      out += _box(_lbl('HIGH-ACTIVITY REGIONS') + _bars(ac.topRegions, null, '#ff8844'));
    }

    // ── GEM section ────────────────────────────────────────────────────────────
    if (s.gem) {
      out += _divider('ENERGY INFRASTRUCTURE', '#1a5a7a');
      var gm = s.gem;
      var opPct = gm.total ? Math.round(gm.operational / gm.total * 100) : 0;
      out += _metricGrid([
        { label: 'FACILITIES',   value: _fmtN(gm.total),        accent: '#4fc3ff', sub: 'tracked globally' },
        { label: 'OPERATIONAL',  value: _fmtN(gm.operational),  accent: '#00cc77', sub: opPct + '% of total' },
        { label: 'UNDER CONSTR.',value: _fmtN(gm.construction), accent: '#ffaa00', sub: 'pipeline' },
        { label: 'NATIONS',      value: _fmtN(gm.countries),    accent: '#72eeff', sub: 'footprint' },
      ]);
      out += _box(_lbl('FUEL TYPE MATRIX')   + _bars(gm.byFuel,   gm.total, '#4fc3ff'));
      out += _box(_lbl('FACILITY TYPES')     + _bars(gm.byType,   gm.total, '#2299cc'), 0);
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

      // Tab bar row
      '#ax-tabrow{display:flex;align-items:stretch;border-bottom:1px solid rgba(8,24,50,0.95);margin-bottom:14px;}' +
      '#ax-tabbar{display:flex;flex:1;}' +

      // Individual tabs
      '.ax-tab{flex:1;background:transparent;border:none;border-bottom:2px solid transparent;' +
        'color:rgba(50,110,150,0.32);font-size:8px;letter-spacing:1.8px;' +
        'padding:8px 3px;cursor:pointer;' +
        'transition:color 160ms ease,border-color 160ms ease,text-shadow 160ms ease;' +
        'font-family:inherit;text-align:center;font-weight:700;outline:none;}' +
      '.ax-tab:hover{color:rgba(72,150,190,0.6);}' +
      '.ax-tab-ais.ax-on{color:#4488ff;border-bottom-color:#4488ff;text-shadow:0 0 8px rgba(68,136,255,0.5);}' +
      '.ax-tab-ports.ax-on{color:#00ccff;border-bottom-color:#00ccff;text-shadow:0 0 8px rgba(0,204,255,0.5);}' +
      '.ax-tab-noaa.ax-on{color:#72eeff;border-bottom-color:#72eeff;text-shadow:0 0 8px rgba(114,238,255,0.5);}' +
      '.ax-tab-intel.ax-on{color:#cc99ff;border-bottom-color:#cc99ff;text-shadow:0 0 8px rgba(204,153,255,0.4);}' +

      // Expand button
      '#ax-expand{background:none;border:none;border-left:1px solid rgba(8,28,56,0.6);' +
        'color:rgba(50,110,150,0.3);font-size:11px;padding:0 8px;cursor:pointer;flex-shrink:0;' +
        'transition:color 150ms ease,background 150ms ease;outline:none;line-height:1;}' +
      '#ax-expand:hover{color:#4fc3ff;background:rgba(79,195,255,0.05);}' +
      '#ax-expand.ax-on{color:#4fc3ff;background:rgba(79,195,255,0.08);}' +

      // Pane visibility
      '.ax-pane{display:none;}.ax-pane.ax-show{display:block;animation:ax-fadein 160ms ease;}' +
      '@keyframes ax-fadein{from{opacity:0}to{opacity:1}}' +

      // Panel expand mode — width transition on #nw-intel-panel
      '#nw-intel-panel{transition:width 180ms cubic-bezier(0.4,0,0.2,1);}' +
      '#nw-intel-panel.ax-expanded{width:500px;}';

    document.head.appendChild(el);
  }

  // ── Shell HTML ────────────────────────────────────────────────────────────────
  function _buildShell() {
    return '<div id="ax-root" style="font-family:var(--font-mono,\'Courier New\',monospace);">' +
      '<div id="ax-tabrow">' +
        '<div id="ax-tabbar">' +
          '<button class="ax-tab ax-tab-ais ax-on"  data-ax="ais">AIS</button>'   +
          '<button class="ax-tab ax-tab-ports"       data-ax="ports">PORTS</button>' +
          '<button class="ax-tab ax-tab-noaa"        data-ax="noaa">NOAA</button>'  +
          '<button class="ax-tab ax-tab-intel"       data-ax="intel">INTEL</button>' +
        '</div>' +
        '<button id="ax-expand" title="Expand analytics workspace">⊲</button>' +
      '</div>' +
      '<div id="ax-pane-ais"   class="ax-pane ax-show"></div>' +
      '<div id="ax-pane-ports" class="ax-pane"></div>' +
      '<div id="ax-pane-noaa"  class="ax-pane"></div>' +
      '<div id="ax-pane-intel" class="ax-pane"></div>' +
    '</div>';
  }

  // ── DOM mount ─────────────────────────────────────────────────────────────────
  function _mount() {
    var body = document.getElementById('nw-analytics-body');
    if (!body) return false;

    var ph = document.getElementById('nw-analytics-placeholder');
    if (ph) ph.style.display = 'none';

    if (!document.getElementById('ax-root')) {
      var tmp = document.createElement('div');
      tmp.innerHTML = _buildShell();
      body.appendChild(tmp.firstChild);
    }

    // Tab bar clicks
    var tabbar = document.getElementById('ax-tabbar');
    if (tabbar) {
      tabbar.addEventListener('click', function (e) {
        var btn = e.target;
        if (!btn || typeof btn.getAttribute !== 'function') return;
        var tab = btn.getAttribute('data-ax');
        if (tab) _switchTab(tab);
      });
    }

    // Expand button
    var expBtn = document.getElementById('ax-expand');
    if (expBtn) {
      expBtn.addEventListener('click', _toggleExpand);
    }

    _mounted = true;
    return true;
  }

  // ── Tab switching ─────────────────────────────────────────────────────────────
  function _switchTab(tab) {
    _activeTab = tab;

    var btns = document.querySelectorAll('#ax-tabbar .ax-tab');
    for (var i = 0; i < btns.length; i++) btns[i].classList.remove('ax-on');
    var active = document.querySelector('#ax-tabbar [data-ax="' + tab + '"]');
    if (active) active.classList.add('ax-on');

    var allTabs = ['ais', 'ports', 'noaa', 'intel'];
    for (var j = 0; j < allTabs.length; j++) {
      var pane = document.getElementById('ax-pane-' + allTabs[j]);
      if (!pane) continue;
      if (allTabs[j] === tab) pane.classList.add('ax-show');
      else                     pane.classList.remove('ax-show');
    }

    // On first activation of each tab, trigger data load
    if (tab === 'ais'   && !_state.ais.data)                 _refreshAIS();
    if (tab === 'ports' && !_state.ports.data)               _refreshPorts();
    if (tab === 'noaa'  && !_state.noaa.metrics  && !_state.noaa.loading)  _pollNoaa();
    if (tab === 'intel' && !_state.intel.acled   && !_state.intel.loading) _pollIntel();
  }

  // ── Expand mode ───────────────────────────────────────────────────────────────
  function _toggleExpand() {
    _expanded = !_expanded;
    var panel  = document.getElementById('nw-intel-panel');
    var btn    = document.getElementById('ax-expand');
    if (panel) panel.classList.toggle('ax-expanded', _expanded);
    if (btn)   {
      btn.classList.toggle('ax-on', _expanded);
      btn.textContent = _expanded ? '⊳' : '⊲';
      btn.title = _expanded ? 'Collapse analytics workspace' : 'Expand analytics workspace';
    }
  }

  // ── Repaint ───────────────────────────────────────────────────────────────────
  function _repaint(tab) {
    var pane = document.getElementById('ax-pane-' + tab);
    if (!pane) return;
    var html = tab === 'ais'   ? _renderAIS()   :
               tab === 'ports' ? _renderPorts() :
               tab === 'noaa'  ? _renderNoaa()  : _renderIntel();
    pane.innerHTML = html;
  }

  // ── Data refresh — AIS (live state, no fetch) ─────────────────────────────────
  function _refreshAIS() {
    var snap = null;
    var cpAnalytics = null;
    var nw = window.ArgusNeuralWeb;
    if (nw && typeof nw.getAnalyticsData === 'function') {
      var d = nw.getAnalyticsData();
      snap        = d.snap;
      cpAnalytics = d.cpAnalytics;
    } else {
      // Direct fallback
      var ships = [], flights = [];
      (window._vesselMarkers || []).forEach(function (m) {
        var ud = m && m.userData;
        if (ud && ud.isShip && ud.lat != null) {
          ships.push({ lat: ud.lat, lon: ud.lon, category: (ud.typeCategory || 'other').toLowerCase() });
        }
      });
      (window._aircraftMarkers || []).forEach(function (m) {
        var ud = m && m.userData;
        if (ud && ud.isAircraft && ud.lat != null) {
          flights.push({ lat: ud.lat, lon: ud.lon, category: (ud.flightType || 'unknown').toLowerCase() });
        }
      });
      snap = { ships: ships, flights: flights };
    }
    _state.ais.data = _normalizeAIS(snap, cpAnalytics);
    _state.ais.ts   = Date.now();
    _repaint('ais');
  }

  // ── Data refresh — Port Watch (live state, no fetch) ─────────────────────────
  function _refreshPorts() {
    var pa = null;
    var nw = window.ArgusNeuralWeb;
    if (nw && typeof nw.getPortAnalytics === 'function') {
      pa = nw.getPortAnalytics();
    }
    _state.ports.data = pa ? _normalizePort(pa) : null;
    _state.ports.ts   = Date.now();
    _repaint('ports');
  }

  // ── Data fetch — NOAA ─────────────────────────────────────────────────────────
  function _pollNoaa() {
    var s = _state.noaa;
    s.loading = true;
    if (!s.metrics) _repaint('noaa');
    _fetch(NOAA_FN)
      .then(function (json) {
        s.loading = false; s.ts = Date.now(); s.error = null;
        s.metrics = _normalizeNoaa(json);
        _repaint('noaa');
      })
      .catch(function (err) {
        s.loading = false; s.error = (err && err.message) || 'FETCH ERROR';
        _repaint('noaa');
      });
  }

  // ── Data fetch — INTEL (ACLED + GEM staggered) ───────────────────────────────
  function _pollIntel() {
    var s = _state.intel;
    s.loading = true;
    if (!s.acled && !s.gem) _repaint('intel');

    _fetch(ACLED_FN)
      .then(function (json) {
        s.acled = _normalizeAcled(json);
        s.ts    = Date.now();
        _repaint('intel');
      })
      .catch(function (err) {
        s.error = (err && err.message) || 'ACLED OFFLINE';
        _repaint('intel');
      });

    // GEM staggered by 3s to avoid burst
    setTimeout(function () {
      _fetch(GEM_FN)
        .then(function (json) {
          s.gem     = _normalizeGem(json);
          s.loading = false;
          s.ts      = Date.now();
          _repaint('intel');
        })
        .catch(function () { s.loading = false; _repaint('intel'); });
    }, 3000);
  }

  // ── Init & lifecycle ──────────────────────────────────────────────────────────
  function init() {
    if (_initialized) return;
    _initialized = true;

    _injectStyles();
    if (!_mount()) {
      _initialized = false;
      setTimeout(init, 800);
      return;
    }

    // Load active tab immediately, others staggered
    _refreshAIS();
    setTimeout(_refreshPorts, 2000);
    setTimeout(_pollNoaa,  5000);
    setTimeout(_pollIntel, 9000);

    // Periodic refresh timers
    _timers.ais   = setInterval(_refreshAIS,   REFRESH_AIS_MS);
    _timers.ports = setInterval(_refreshPorts, REFRESH_PORTS_MS);
    _timers.noaa  = setInterval(_pollNoaa,     POLL_NOAA);
    _timers.intel = setInterval(_pollIntel,    POLL_ACLED);
  }

  function refresh() {
    _refreshAIS();
    _refreshPorts();
    _pollNoaa();
    _pollIntel();
  }

  function status() {
    return {
      activeTab:   _activeTab,
      expanded:    _expanded,
      initialized: _initialized,
      mounted:     _mounted,
      ais:   { hasData: !!(_state.ais.data && _state.ais.data.hasData),  ts: _state.ais.ts   },
      ports: { hasData: !!_state.ports.data,  ts: _state.ports.ts  },
      noaa:  { hasData: !!_state.noaa.metrics, ts: _state.noaa.ts  },
      intel: { hasData: !!(_state.intel.acled || _state.intel.gem), ts: _state.intel.ts },
    };
  }

  // ── Auto-init — lazy on first Analytics tab click ────────────────────────────
  setTimeout(function () {
    var btn = document.querySelector('.nw-tab-btn[data-tab="analytics"]');
    if (btn) {
      btn.addEventListener('click', function () { if (!_initialized) init(); });
    }
    var pane = document.getElementById('nw-pane-analytics');
    if (pane && pane.classList.contains('is-active')) init();
  }, 1500);

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusAnalytics');

  return { init: init, refresh: refresh, status: status };

}());
