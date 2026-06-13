'use strict';
// modules/argusAnalytics.js
// Unified intelligence analytics workspace — MARITIME | IMF ECON | ENVIRON | GEM LNG | CRISIS | UN HUMANITARIAN
//
// Architecture:
//   Six isolated analytics modules inside the Neural Web Analytics tab.
//   AIS + PORT WATCH read live global state (no network fetch).
//   NOAA + INTEL (ACLED/GEM) + GDACS fetch from Netlify functions on independent timers.
//   HUMANITARIAN reads from window.ArgusHumanitarian live store (no network fetch).
//   Expand mode transitions #nw-intel-panel width: 272→500px (180ms).
//   Timeframe selector: SNAP / 24H / 1W / 1M / 1Y — frames intelligence lens.
//
// Data bridges:
//   AIS          — window.ArgusNeuralWeb.getAnalyticsData() → {snap, cpAnalytics}
//   PORTS        — window.ArgusNeuralWeb.getPortAnalytics() → portAnalytics object
//   NOAA         — /.netlify/functions/fetch-noaa
//   ACLED        — /.netlify/functions/fetch-acled
//   GEM          — /.netlify/functions/fetch-gem
//   GDACS        — window.gdacsEventCache (live) or /.netlify/functions/fetch-gdacs
//   HUMANITARIAN — window.ArgusHumanitarian.getAllEntities() (live, no fetch)
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
  var GDACS_FN = '/.netlify/functions/fetch-gdacs';

  var POLL_NOAA  = 15 * 60 * 1000;
  var POLL_ACLED = 30 * 60 * 1000;
  var POLL_GEM   = 30 * 60 * 1000;
  var POLL_GDACS = 30 * 60 * 1000;
  var REFRESH_AIS_MS   =  30 * 1000;
  var REFRESH_PORTS_MS =  60 * 1000;

  // ── Timeframe config ──────────────────────────────────────────────────────────
  var _TF_BTNS   = ['snapshot', '24h', '1w', '1m', '1y'];
  var _TF_LABEL  = { snapshot: 'SNAP', '24h': '24H', '1w': '1W', '1m': '1M', '1y': '1Y' };
  var _TF_WINDOW = { snapshot: 'CURRENT CONDITIONS', '24h': 'PAST 24 HOURS', '1w': 'PAST 7 DAYS', '1m': 'PAST 30 DAYS', '1y': 'PAST YEAR' };
  var _TF_DAYS   = { snapshot: null, '24h': 1, '1w': 7, '1m': 30, '1y': 365 };

  // ── Module state ──────────────────────────────────────────────────────────────
  var _initialized = false;
  var _mounted     = false;
  var _activeTab   = 'ais';
  var _expanded    = false;
  var _timeframe   = 'snapshot';

  var _state = {
    ais:          { data: null, ts: null },
    ports:        { data: null, ts: null },
    noaa:         { metrics: null, ts: null, loading: false, error: null },
    intel:        { gem: null, acled: null, ts: null, loading: false, error: null },
    gdacs:        { metrics: null, ts: null, loading: false, error: null },
    humanitarian: { data: null, ts: null },
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

  // Filter a trend array to the current timeframe window
  function _scopeTrend(trend) {
    if (!trend || !trend.length) return trend;
    var days = _TF_DAYS[_timeframe];
    if (!days) return trend;
    var cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    var cutStr = cutoff.toISOString().slice(0, 10);
    var scoped = trend.filter(function (t) { return t.d >= cutStr; });
    return scoped.length >= 2 ? scoped : trend.slice(-Math.min(days, trend.length));
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
      'margin-bottom:8px;padding-bottom:7px;border-bottom:1px solid rgba(10,28,55,0.9);">' +
      '<span style="font-size:9px;letter-spacing:1.8px;color:' + color + ';font-weight:700;' +
        'display:flex;align-items:center;">' + _dot(color) + _esc(label) + '</span>' +
      '<span style="font-size:7.5px;letter-spacing:.4px;color:#12324e;">' + _esc(ts) + '</span>' +
    '</div>';
  }

  // Operational question framing block
  function _question(q, color) {
    return '<div style="font-size:7.5px;letter-spacing:.8px;color:' + (color || '#1a5a7a') + ';' +
      'line-height:1.65;margin-bottom:10px;padding:7px 10px;' +
      'border-left:2px solid ' + (color || '#1a5a7a') + ';opacity:0.75;' +
      'background:rgba(3,12,30,0.4);">' + _esc(q) + '</div>';
  }

  // Timeframe window badge (below question)
  function _tfBadge() {
    return '<div style="font-size:7px;letter-spacing:1.5px;color:#0e3050;' +
      'margin-bottom:10px;text-align:right;">' + _esc(_TF_WINDOW[_timeframe] || 'CURRENT') + '</div>';
  }

  // Intelligence insight row — label / value / detail
  function _insight(label, value, detail, accent) {
    accent = accent || '#72eeff';
    return '<div style="display:flex;align-items:flex-start;gap:8px;padding:6px 0;' +
      'border-bottom:1px solid rgba(8,24,50,0.5);">' +
      '<div style="flex:1;min-width:0;">' +
        '<div style="font-size:7px;letter-spacing:1.3px;color:#1a4a62;margin-bottom:2px;' +
          'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + _esc(label) + '</div>' +
        '<div style="font-size:9px;font-weight:700;color:' + accent + ';letter-spacing:.3px;line-height:1.3;">' +
          _esc(value) + '</div>' +
        (detail ? '<div style="font-size:7px;color:#0d2a40;margin-top:2px;line-height:1.5;">' + _esc(detail) + '</div>' : '') +
      '</div>' +
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

    var shipPairs = _sortDesc(shipCatCounts, 6).map(function (p) {
      return { k: p.k.toUpperCase(), v: p.v, c: SHIP_COLORS[p.k] || '#4a7a9a' };
    });
    var flightPairs = _sortDesc(flightCatCounts, 4).map(function (p) {
      return { k: p.k.toUpperCase(), v: p.v, c: FLIGHT_COLORS[p.k] || '#4a7a9a' };
    });

    var tankers  = shipCatCounts.tanker  || 0;
    var military = (shipCatCounts.military || 0) + (flightCatCounts.military || 0);

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

  // ── GDACS normalization ───────────────────────────────────────────────────────
  var _GDACS_CAT_COLORS = {
    earthquake:       '#ff5500',
    tropical_cyclone: '#cc44ff',
    flood:            '#2299ee',
    volcano:          '#ff2200',
    drought:          '#cc8800',
    wildfire:         '#ff4400',
    tsunami:          '#00ccff',
  };

  function _normalizeGdacs(json) {
    var events = [];

    var cache = window.gdacsEventCache;
    if (cache && typeof cache.forEach === 'function' && cache.size > 0) {
      cache.forEach(function (ev) { events.push(ev); });
    } else if (json && Array.isArray(json.events)) {
      events = json.events;
    }
    if (!events.length) return null;

    var byCategory = {};
    var bySeverity = { red: 0, orange: 0, green: 0 };
    var byRegion   = {};
    var redAlerts  = [];
    var escalationScore = 0;

    for (var i = 0; i < events.length; i++) {
      var ev  = events[i];
      var cat = ev.category || 'unknown';
      var sev = ev.severity || 'green';
      var score = typeof ev.alertScore === 'number' ? ev.alertScore : 0;

      byCategory[cat] = (byCategory[cat] || 0) + 1;

      if (bySeverity.hasOwnProperty(sev)) bySeverity[sev]++;
      else bySeverity.green++;

      (ev.affectedRegions || []).forEach(function (r) {
        if (!r || r.length <= 3) return;
        byRegion[r] = (byRegion[r] || 0) + 1;
      });

      escalationScore += (sev === 'red' ? 3 : sev === 'orange' ? 1.5 : 0.5) * (1 + score / 100);

      if (sev === 'red') {
        redAlerts.push({ title: ev.title || '—', category: cat, score: score });
      }
    }

    var escalationIndex = Math.min(100, Math.round(
      escalationScore / Math.max(1, events.length) * 20
    ));

    var topCat = _sortDesc(byCategory, 1);
    var topReg = _sortDesc(byRegion,   1);

    return {
      total:          events.length,
      redCount:       bySeverity.red,
      orangeCount:    bySeverity.orange,
      greenCount:     bySeverity.green,
      escalationIndex: escalationIndex,
      topCategory:    topCat.length ? topCat[0].k : null,
      topRegion:      topReg.length ? topReg[0].k : null,
      bySeverity: [
        { k: 'RED — EXTREME',   v: bySeverity.red,    c: '#ff3300' },
        { k: 'ORANGE — SEVERE', v: bySeverity.orange, c: '#ff8800' },
        { k: 'GREEN — WATCH',   v: bySeverity.green,  c: '#33cc77' },
      ],
      byCategory: _sortDesc(byCategory, 7),
      topRegions: _sortDesc(byRegion,   6),
      redAlerts:  redAlerts.sort(function(a,b){return b.score-a.score;}).slice(0, 5),
    };
  }

  // ── GEM normalization ─────────────────────────────────────────────────────────
  function _normalizeGem(raw) {
    if (!raw || !Array.isArray(raw.infrastructure)) return null;
    if (raw.disabled) return null;
    var items = raw.infrastructure;
    if (!items.length) return null;

    var byFuel = {}, byStatus = {}, byType = {}, byCountry = {}, byRegion = {};
    var operational = 0, construction = 0, announced = 0;
    var totalCapacity = 0, capCount = 0;

    for (var i = 0; i < items.length; i++) {
      var it      = items[i];
      var fuel    = it.fuel    || 'Unknown';
      var status  = (it.status || 'unknown').toLowerCase();
      var type    = it.type    || 'Unknown';
      var country = it.country || 'Unknown';
      var region  = it.region  || 'Unknown';

      byFuel[fuel]       = (byFuel[fuel]       || 0) + 1;
      byStatus[status]   = (byStatus[status]   || 0) + 1;
      byType[type]       = (byType[type]       || 0) + 1;
      byCountry[country] = (byCountry[country] || 0) + 1;
      byRegion[region]   = (byRegion[region]   || 0) + 1;

      if (status === 'operating'    || status === 'operational') operational++;
      if (status === 'construction' || status === 'under construction') construction++;
      if (status === 'announced'    || status === 'pre-construction')   announced++;

      var cap = parseFloat(it.capacity);
      if (!isNaN(cap) && cap > 0) { totalCapacity += cap; capCount++; }
    }

    var pipeline   = construction + announced;
    var growthIdx  = items.length ? Math.min(100, Math.round(pipeline / items.length * 100)) : 0;

    return {
      total:         items.length,
      operational:   operational,
      construction:  construction,
      announced:     announced,
      pipeline:      pipeline,
      growthIdx:     growthIdx,
      countries:     Object.keys(byCountry).length,
      totalCapacity: capCount > 0 ? Math.round(totalCapacity) : null,
      fuelFilter:    raw.fuelFilter || null,
      byFuel:        _sortDesc(byFuel,    6),
      byType:        _sortDesc(byType,    6),
      byStatus:      _sortDesc(byStatus,  6),
      byCountry:     _sortDesc(byCountry, 8),
      byRegion:      _sortDesc(byRegion,  6),
    };
  }

  // ── AIS render ─────────────────────────────────────────────────────────────────
  // Intelligence question: "What maritime behavior is changing?"
  function _renderAIS() {
    var s   = _state.ais;
    var ts  = _fmtTs(s.ts);
    var out = _tabHeader('MARITIME INTELLIGENCE', ts, '#4488ff');

    out += _question('What maritime behavior is changing?', '#2255aa');
    out += _tfBadge();

    if (!s.data || !s.data.hasData) {
      return out + _noData('ENABLE AIS OR AIRCRAFT LAYER\nTO LOAD LIVE FEED');
    }
    var d = s.data;

    // Maritime Activity Index — weighted composite
    var tankerRatio   = d.ships > 0 ? d.tankers / d.ships : 0;
    var topCpDensity  = d.chokepoints && d.chokepoints.length ? d.chokepoints[0].v : 0;
    var cpPressure    = Math.min(40, topCpDensity * 1.2);
    var tankerSignal  = Math.min(30, tankerRatio * 150);
    var milSignal     = Math.min(30, d.military * 2);
    var activityIdx   = Math.round(cpPressure + tankerSignal + milSignal);
    out += _meter(activityIdx, 'MARITIME ACTIVITY INDEX', '#4488ff');

    // Intelligence signals
    var tankerPct    = d.ships > 0 ? Math.round(tankerRatio * 100) : 0;
    var tankerDetail = tankerPct >= 25
      ? 'Elevated energy cargo concentration — supply chain pressure signal'
      : tankerPct >= 12
        ? 'Normal tanker density — energy routing stable'
        : 'Low tanker presence — reduced energy cargo movement';

    var topCpName   = d.chokepoints && d.chokepoints.length ? d.chokepoints[0].k : null;
    var topCpCount  = d.chokepoints && d.chokepoints.length ? d.chokepoints[0].v : 0;
    var cpDetail    = topCpName
      ? (topCpCount >= 30
          ? 'HIGH — potential congestion affecting transshipment times'
          : topCpCount >= 15
            ? 'MODERATE — elevated transit density, monitor for delays'
            : 'NOMINAL — normal transit volume')
      : null;

    var insightsHtml =
      _insight('TANKER CONCENTRATION', tankerPct + '% of fleet', tankerDetail, '#ff9933') +
      _insight('MILITARY CONTACTS', _fmtN(d.military), d.military > 5 ? 'Elevated military presence — heightened threat environment' : 'Background military activity', '#ff4444') +
      (topCpName ? _insight('PEAK CHOKEPOINT PRESSURE', topCpName, cpDetail, _cpStressColor(topCpCount)) : '') +
      _insight('ACTIVE VESSELS', _fmtN(d.ships) + ' AIS', d.flights > 0 ? _fmtN(d.flights) + ' aircraft tracked concurrently' : 'AIS-only feed active', '#4488ff');

    out += _box(insightsHtml);

    // Fleet composition
    if (d.shipPairs && d.shipPairs.length) {
      out += _box(_lbl('VESSEL FLEET COMPOSITION') + _bars(d.shipPairs, d.ships, '#4488ff'));
    }

    // Chokepoint traffic
    if (d.chokepoints && d.chokepoints.length) {
      out += _box(_lbl('CHOKEPOINT TRAFFIC DENSITY') + _bars(d.chokepoints, null, '#4488ff'));
    }

    // Flight overlay
    if (d.flightPairs && d.flightPairs.length) {
      out += _box(_lbl('ACTIVE FLIGHT CONTACTS') + _bars(d.flightPairs, d.flights, '#66ddff'), 0);
    }

    return out;
  }

  // ── Port Watch render ──────────────────────────────────────────────────────────
  // Intelligence question: "Where are macroeconomic conditions creating future geopolitical effects?"
  function _renderPorts() {
    var s   = _state.ports;
    var ts  = _fmtTs(s.ts);
    var out = _tabHeader('IMF PORT WATCH', ts, '#00ccff');

    out += _question('Where are macroeconomic conditions creating future geopolitical effects?', '#006688');
    out += _tfBadge();

    if (!s.data) {
      return out + _noData('PORTWATCH LAYER LOADING...\nEnable vessel layer for AIS cross-layer data.');
    }
    var d = s.data;

    // Economic Momentum Score: derived from I/E ratio + trade balance direction
    var ieScore  = d.ieRatio ? Math.min(50, Math.abs(d.ieRatio - 1) * 100) : 0;
    var balScore = d.balance != null ? Math.min(50, Math.abs(d.balance) / Math.max(1, d.calls) * 200) : 0;
    var econScore = Math.round(ieScore + balScore);
    out += _meter(econScore, 'ECONOMIC DIVERGENCE SCORE', '#00ccff');

    // Intelligence signals
    var ieDir    = d.ieRatio > 1.1 ? 'Import-heavy' : d.ieRatio < 0.9 ? 'Export-heavy' : 'Balanced';
    var ieDetail = d.ieRatio > 1.2
      ? 'Strong import surplus — deficit pressure, potential currency stress'
      : d.ieRatio > 1.1
        ? 'Mild import dominance — watch for trade balance deterioration'
        : d.ieRatio < 0.8
          ? 'Export-driven economy — geopolitical leverage in commodity flows'
          : 'Trade flows balanced — stable macroeconomic conditions';

    var balColor  = d.balance > 0 ? '#00cc77' : '#ff4466';
    var balLabel  = d.balance > 0 ? '+' + _fmtN(d.balance) + ' surplus' : _fmtN(Math.abs(d.balance || 0)) + ' deficit';

    var tankDom = d.tankPct > 50 ? 'Energy cargo dominant — supply security exposure' : 'Container trade dominant — consumer goods flow primary';

    var insightsHtml =
      _insight('TRADE BALANCE', balLabel, 'Net flow direction across ' + (d.portCount || '--') + ' monitored ports', balColor) +
      _insight('I/E PRESSURE', ieDir + (d.ieRatio ? ' (' + d.ieRatio.toFixed(2) + ':1)' : ''), ieDetail, d.ieRatio > 1.1 ? '#ff9933' : d.ieRatio < 0.9 ? '#00cc77' : '#00ccff') +
      _insight('CARGO PRIORITY SIGNAL', d.tankPct + '% TANKER · ' + d.contPct + '% CONTAINER', tankDom, '#ff9933') +
      _insight('TRADE VOLUME', _fmtN(d.calls) + ' port calls', (d.period || '') + ' window · ' + (d.portCount || '--') + ' ports tracked', '#00ccff');

    out += _box(insightsHtml);

    if (d.topRegions && d.topRegions.length) {
      out += _box(_lbl('REGIONAL TRADE MOMENTUM') + _bars(d.topRegions, d.calls, '#00ccff'));
    }
    if (d.topPorts && d.topPorts.length) {
      out += _box(
        _lbl('PORT CONCENTRATION RISK') +
        '<div style="font-size:7px;color:#0d2a40;margin-bottom:6px;">HIGH CONCENTRATION = SINGLE-POINT-OF-FAILURE EXPOSURE · ⬡ = CHOKEPOINT ADJACENT</div>' +
        _bars(d.topPorts, d.calls, '#00ccff'),
        0
      );
    }

    return out;
  }

  // ── NOAA render ───────────────────────────────────────────────────────────────
  // Intelligence question: "What environmental conditions are changing operationally?"
  function _renderNoaa() {
    var s   = _state.noaa;
    var ts  = _fmtTs(s.ts);
    var out = _tabHeader('ENVIRONMENTAL RISK', ts, '#72eeff');

    out += _question('What environmental conditions are changing operationally?', '#2a7a8a');
    out += _tfBadge();

    if (!s.metrics) {
      return out + (s.error ? _errState(s.error) : _skeleton());
    }
    var m = s.metrics;

    out += _meter(m.intensity, 'ENVIRONMENTAL RISK SCORE', '#72eeff');

    // Intelligence signals
    var critZones = m.extreme + m.severe;
    var topType   = m.topTypes && m.topTypes.length ? m.topTypes[0] : null;

    var cycDetail = m.cyclones > 0
      ? 'Active tropical systems — maritime routing and coastal operations affected'
      : 'No tropical systems tracked — normal open-ocean conditions';

    var critDetail = critZones > 10
      ? 'HIGH — multiple high-severity zones requiring operational avoidance'
      : critZones > 3
        ? 'MODERATE — several zones requiring flight/maritime rerouting'
        : critZones > 0
          ? 'LIMITED — localized impact zones, standard precautions'
          : 'CLEAR — no extreme or severe alerts active';

    var hazDetail = topType
      ? topType.k + ' accounts for ' + Math.round(topType.v / Math.max(1, m.total) * 100) + '% of all active alerts'
      : null;

    var insightsHtml =
      _insight('TROPICAL SYSTEMS ACTIVE', String(m.cyclones), cycDetail, m.cyclones > 0 ? '#cc44ff' : '#4fc3ff') +
      _insight('CRITICAL ALERT ZONES', String(critZones), critDetail, critZones > 10 ? '#ff2200' : critZones > 3 ? '#ff8800' : '#72eeff') +
      _insight('PRIMARY HAZARD TYPE', topType ? topType.k : '--', hazDetail, '#72eeff') +
      _insight('TOTAL ACTIVE ALERTS', String(m.total), 'NWS + NHC combined feed', '#4fc3ff');

    out += _box(insightsHtml);

    // Severity distribution
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
    out += _box(_lbl('OPERATIONAL HAZARD TYPES') + _bars(m.topTypes, m.total, '#72eeff'), 0);

    return out;
  }

  // ── GEM LNG render (INTEL tab) ────────────────────────────────────────────────
  // Intelligence question: "How is global energy infrastructure shifting?"
  function _renderIntel() {
    var s   = _state.intel;
    var ts  = _fmtTs(s.ts);
    var out = _tabHeader('GEM LNG ANALYTICS', ts, '#4fc3ff');

    out += _question('How is global energy infrastructure shifting?', '#1a4a6a');
    out += _tfBadge();

    if (!s.acled && !s.gem) {
      return out + (s.error ? _errState(s.error) : _skeleton());
    }

    // ── GEM primary section ────────────────────────────────────────────────────
    if (s.gem) {
      var gm      = s.gem;
      var opPct   = gm.total ? Math.round(gm.operational  / gm.total * 100) : 0;
      var conPct  = gm.total ? Math.round(gm.construction / gm.total * 100) : 0;
      var annPct  = gm.total ? Math.round(gm.announced    / gm.total * 100) : 0;

      out += _meter(gm.growthIdx, 'LNG GROWTH INDEX', '#4fc3ff');

      // Pipeline trend signal
      var pipelineDetail = gm.growthIdx >= 60
        ? 'Rapid expansion — significant new capacity entering the market within 3–7 years'
        : gm.growthIdx >= 35
          ? 'Steady growth — moderate capacity additions underway'
          : 'Mature market — operational base dominant, limited new construction';

      var topCountry   = gm.byCountry && gm.byCountry.length ? gm.byCountry[0] : null;
      var topRegionGem = gm.byRegion  && gm.byRegion.length  ? gm.byRegion[0]  : null;

      var countryDetail = topCountry
        ? topCountry.k + ' leads with ' + topCountry.v + ' facilities (' +
          Math.round(topCountry.v / gm.total * 100) + '% of tracked infrastructure)'
        : null;

      var insightsHtml =
        _insight('PIPELINE PRESSURE', gm.construction + ' UNDER CONSTRUCTION', pipelineDetail, '#ffaa00') +
        _insight('ANNOUNCED CAPACITY', gm.announced + ' PRE-CONSTRUCTION', annPct + '% of total represents 5-10yr trajectory signal', '#cc99ff') +
        _insight('GEOGRAPHIC SPREAD', gm.countries + ' NATIONS', 'Market diversification index — higher = more distributed supply risk', '#4fc3ff') +
        (topCountry ? _insight('CAPACITY LEADER', topCountry.k.toUpperCase(), countryDetail, '#00cc77') : '') +
        (topRegionGem ? _insight('DOMINANT REGION', topRegionGem.k.toUpperCase(), topRegionGem.v + ' facilities — primary infrastructure concentration', '#4488ff') : '');

      out += _box(insightsHtml);

      out += _metricGrid([
        { label: 'FACILITIES',    value: _fmtN(gm.total),        accent: '#4fc3ff', sub: (gm.fuelFilter || 'all fuels') + ' · ' + gm.countries + ' nations' },
        { label: 'OPERATING',     value: _fmtN(gm.operational),  accent: '#00cc77', sub: opPct + '% of tracked' },
        { label: 'CONSTRUCTION',  value: _fmtN(gm.construction), accent: '#ffaa00', sub: conPct + '% pipeline' },
        { label: 'ANNOUNCED',     value: _fmtN(gm.announced),    accent: '#cc99ff', sub: annPct + '% pre-construction' },
      ]);

      if (gm.byRegion && gm.byRegion.length) {
        out += _box(_lbl('REGIONAL INFRASTRUCTURE DISTRIBUTION') + _bars(gm.byRegion, gm.total, '#4fc3ff'));
      }
      out += _box(_lbl('CAPACITY LEADERS BY NATION') + _bars(gm.byCountry, gm.total, '#4fc3ff'));
      out += _box(_lbl('TECHNOLOGY TYPES') + _bars(gm.byType, gm.total, '#2299cc'), s.acled ? 8 : 0);
    }

    // ── ACLED secondary section ────────────────────────────────────────────────
    if (s.acled) {
      var ac = s.acled;
      out += _divider('CONFLICT INTELLIGENCE · ACLED', '#3a2a5a');

      var fatAccent = ac.fatalities > 500 ? '#ff2200' : ac.fatalities > 100 ? '#ff5500' : '#ff9966';
      out += _meter(ac.escalation, 'CONFLICT ESCALATION INDEX', '#ff6644');

      var scopedTrend = _scopeTrend(ac.trend);
      if (scopedTrend && scopedTrend.length >= 2) {
        out += _box(_trendSvg(scopedTrend, 'EVENT TEMPO — ' + _TF_WINDOW[_timeframe]));
      }
      out += _box(_lbl('HIGH-ACTIVITY REGIONS') + _bars(ac.topRegions, null, '#ff8844'), 0);
    }

    return out;
  }

  // ── GDACS render ──────────────────────────────────────────────────────────────
  // Intelligence question: "Where is the world's next operational crisis emerging?"
  function _renderGdacs() {
    var s   = _state.gdacs;
    var ts  = _fmtTs(s.ts);
    var out = _tabHeader('CRISIS INTELLIGENCE', ts, '#ff6633');

    out += _question("Where is the world's next operational crisis emerging?", '#8a3300');
    out += _tfBadge();

    if (!s.metrics) {
      return out + (s.error ? _errState(s.error) : _skeleton());
    }
    var m = s.metrics;

    out += _meter(m.escalationIndex, 'GLOBAL CRISIS INDEX', '#ff6633');

    // Intelligence signals
    var topRedAlert  = m.redAlerts && m.redAlerts.length ? m.redAlerts[0] : null;
    var escPressure  = m.total > 0 ? Math.round((m.redCount * 3 + m.orangeCount) / m.total * 33) : 0;
    var pressureLabel = escPressure >= 66 ? 'CRITICAL — majority of events are high-severity'
      : escPressure >= 33 ? 'ELEVATED — significant proportion of severe events'
      : 'NOMINAL — mostly watch-level events';

    var insightsHtml =
      (topRedAlert
        ? _insight('HIGHEST IMPACT EVENT', topRedAlert.title.slice(0, 55) + (topRedAlert.title.length > 55 ? '…' : ''),
            topRedAlert.category.replace(/_/g, ' ').toUpperCase() + ' · EXTREME ALERT', '#ff3300')
        : '') +
      (m.topRegion
        ? _insight('CRISIS CONCENTRATION', m.topRegion.toUpperCase(), 'Highest geographic density of active disaster events', '#ff8800')
        : '') +
      (m.topCategory
        ? _insight('DOMINANT HAZARD TYPE', m.topCategory.replace(/_/g, ' ').toUpperCase(),
            'Primary driver of the Global Crisis Index this period', _GDACS_CAT_COLORS[m.topCategory] || '#ff6633')
        : '') +
      _insight('ESCALATION PRESSURE', escPressure + '/100', pressureLabel, escPressure >= 66 ? '#ff2200' : escPressure >= 33 ? '#ff8800' : '#33cc77') +
      _insight('ACTIVE DISASTERS', String(m.total), m.redCount + ' extreme · ' + m.orangeCount + ' severe · ' + m.greenCount + ' watch', '#ff6633');

    out += _box(insightsHtml);

    // Event type breakdown
    if (m.byCategory && m.byCategory.length) {
      var catPairs = m.byCategory.map(function (p) {
        return {
          k: p.k.replace(/_/g, ' ').toUpperCase(),
          v: p.v,
          c: _GDACS_CAT_COLORS[p.k] || '#ff6633',
        };
      });
      out += _box(_lbl('CRISIS TYPE DISTRIBUTION') + _bars(catPairs, m.total, '#ff6633'));
    }

    // Regional exposure
    if (m.topRegions && m.topRegions.length) {
      out += _box(_lbl('REGIONAL EXPOSURE RANKING') + _bars(m.topRegions, null, '#ff8844'));
    }

    // Extreme alert list
    if (m.redAlerts && m.redAlerts.length) {
      var rHtml = _lbl('EXTREME ALERT EVENTS');
      for (var j = 0; j < m.redAlerts.length; j++) {
        var ra = m.redAlerts[j];
        rHtml +=
          '<div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:5px;' +
            'padding:5px 6px;background:rgba(255,40,0,0.06);border-left:2px solid #ff3300;">' +
            '<span style="display:inline-block;width:6px;height:6px;min-width:6px;' +
              'background:#ff3300;transform:rotate(45deg);margin-top:2px;flex-shrink:0;' +
              'box-shadow:0 0 4px #ff3300;animation:ax-diamond-pulse 1.8s ease-in-out infinite;"></span>' +
            '<span style="font-size:8px;color:#cc5533;line-height:1.5;word-break:break-word;">' +
              _esc(ra.title) + '<br>' +
              '<span style="color:#7a2a10;font-size:7px;letter-spacing:.8px;">' +
                _esc(ra.category.replace(/_/g, ' ').toUpperCase()) +
              '</span>' +
            '</span>' +
          '</div>';
      }
      out += _box(rHtml, 0);
    }

    return out;
  }

  // ── Humanitarian category + severity colors ───────────────────────────────────
  var _HUM_CAT_COLORS = {
    'Conflict':                '#ff3300',
    'Famine':                  '#cc4400',
    'Humanitarian Emergency':  '#ff6600',
    'Epidemic':                '#cc44ff',
    'Food Security':           '#ffaa00',
    'Disease Outbreak':        '#9944cc',
    'Refugee Crisis':          '#ff4488',
    'Displacement':            '#ff9933',
    'Natural Disaster Impact': '#44aaff',
    'Protection Crisis':       '#ff2266',
  };

  var _HUM_SEV_RANK  = { Critical: 5, Severe: 4, High: 3, Moderate: 2, Low: 1, Unknown: 0 };
  var _HUM_SEV_COLOR = { Critical: '#ff0044', Severe: '#ff4400', High: '#ff9933', Moderate: '#ffcc00', Low: '#00ff88', Unknown: '#4a7da8' };

  // ── Humanitarian normalization ─────────────────────────────────────────────────
  function _normalizeHumanitarian(entities) {
    if (!entities || !entities.length) return null;

    var rwEntities    = [];
    var unhcrEntities = [];
    var bySeverity    = { Critical: 0, Severe: 0, High: 0, Moderate: 0, Low: 0, Unknown: 0 };
    var byCategory    = {};
    var byCountry     = {};

    for (var i = 0; i < entities.length; i++) {
      var ent = entities[i];
      if (ent.source === 'UNHCR') {
        unhcrEntities.push(ent);
      } else {
        rwEntities.push(ent);
        var cat = ent.category || 'Humanitarian Emergency';
        byCategory[cat] = (byCategory[cat] || 0) + 1;
        var ctries = ent.countries && ent.countries.length ? ent.countries : (ent.country ? [ent.country] : []);
        for (var ci = 0; ci < ctries.length; ci++) {
          if (ctries[ci]) byCountry[ctries[ci]] = (byCountry[ctries[ci]] || 0) + 1;
        }
      }
      var sev = ent.severity || 'Unknown';
      if (bySeverity.hasOwnProperty(sev)) bySeverity[sev]++; else bySeverity.Unknown++;
    }

    var totalRW = rwEntities.length;

    // Stress index: weighted severity across all ReliefWeb events, normalized 0–100
    var stressScore = 0;
    if (totalRW > 0) {
      var weightedSum = bySeverity.Critical * 5 + bySeverity.Severe * 4 +
                        bySeverity.High * 3 + bySeverity.Moderate * 2 + bySeverity.Low;
      stressScore = Math.min(100, Math.round(weightedSum / (totalRW * 5) * 100));
    }

    // Sort ReliefWeb events by severity desc
    var sortedRW = rwEntities.slice().sort(function (a, b) {
      return (_HUM_SEV_RANK[b.severity] || 0) - (_HUM_SEV_RANK[a.severity] || 0);
    });

    // UNHCR displacement sorted by total displaced desc
    var displacement = unhcrEntities.slice().sort(function (a, b) {
      var at = a.displacementImpact && a.displacementImpact.total || 0;
      var bt = b.displacementImpact && b.displacementImpact.total || 0;
      return bt - at;
    });

    // Total displaced (sum of UNHCR totals)
    var totalDisplaced = 0;
    for (var di = 0; di < displacement.length; di++) {
      var dii = displacement[di].displacementImpact;
      totalDisplaced += (dii && dii.total) || 0;
    }

    // Category + severity bars
    var catPairs = _sortDesc(byCategory, 8).map(function (p) {
      return { k: p.k, v: p.v, c: _HUM_CAT_COLORS[p.k] || '#4da6ff' };
    });
    var sevPairs = [
      { k: 'CRITICAL', v: bySeverity.Critical, c: '#ff0044' },
      { k: 'SEVERE',   v: bySeverity.Severe,   c: '#ff4400' },
      { k: 'HIGH',     v: bySeverity.High,      c: '#ff9933' },
      { k: 'MODERATE', v: bySeverity.Moderate,  c: '#ffcc00' },
      { k: 'LOW',      v: bySeverity.Low,        c: '#00ff88' },
    ].filter(function (p) { return p.v > 0; });

    var topCountries = _sortDesc(byCountry, 6).map(function (p) {
      return { k: p.k, v: p.v, c: '#4da6ff' };
    });

    return {
      total:          totalRW,
      totalUnhcr:     unhcrEntities.length,
      totalDisplaced: totalDisplaced,
      stressScore:    stressScore,
      critical:       bySeverity.Critical,
      severe:         bySeverity.Severe,
      high:           bySeverity.High,
      moderate:       bySeverity.Moderate,
      conflicts:      sortedRW.filter(function (e) { return e.category === 'Conflict'; }).slice(0, 5),
      foodCrises:     sortedRW.filter(function (e) { return e.category === 'Food Security' || e.category === 'Famine'; }).slice(0, 3),
      epidemics:      sortedRW.filter(function (e) { return e.category === 'Epidemic' || e.category === 'Disease Outbreak'; }).slice(0, 3),
      displacement:   displacement.slice(0, 5),
      sevPairs:       sevPairs,
      catPairs:       catPairs,
      topCountries:   topCountries,
      hasData:        (totalRW + unhcrEntities.length) > 0,
    };
  }

  // ── Humanitarian refresh (reads ArgusHumanitarian live store — no network call) ─
  function _refreshHumanitarian() {
    var s  = _state.humanitarian;
    var ah = window.ArgusHumanitarian;
    if (!ah || typeof ah.getAllEntities !== 'function') {
      s.data = null;
      s.ts   = Date.now();
      _repaint('humanitarian');
      return;
    }
    var entities = ah.getAllEntities();
    s.data = _normalizeHumanitarian(entities);
    s.ts   = Date.now();
    _repaint('humanitarian');
  }

  // ── Humanitarian render ────────────────────────────────────────────────────────
  // Intelligence question: "Where are active humanitarian crises placing populations at risk?"
  function _renderHumanitarian() {
    var s   = _state.humanitarian;
    var ts  = _fmtTs(s.ts);
    var UNB = '#4da6ff';
    var out = _tabHeader('UN HUMANITARIAN INTELLIGENCE', ts, UNB);

    out += _question('Where are active humanitarian crises placing populations at risk?', '#1a3a7a');
    out += _tfBadge();

    if (!s.data || !s.data.hasData) {
      return out + _noData('UN HUMANITARIAN DATA LOADING…\nPipeline initializes 90–120s after page load.');
    }
    var m = s.data;

    out += _meter(m.stressScore, 'GLOBAL HUMANITARIAN STRESS INDEX', UNB);

    // Key intelligence signals
    var critDetail = m.critical > 0
      ? m.critical + ' event' + (m.critical !== 1 ? 's' : '') + ' at CRITICAL severity — immediate humanitarian action required'
      : 'No events at CRITICAL severity';

    var conflictDetail = m.conflicts.length
      ? m.conflicts.length + ' active conflict zone' + (m.conflicts.length !== 1 ? 's' : '') + ' tracked via UN OCHA ReliefWeb'
      : 'No active conflict events in current UN reporting';

    var dispYear    = String(new Date().getFullYear() - 1);
    var dispDetail  = m.totalDisplaced > 0
      ? _fmtN(m.totalDisplaced) + ' displaced tracked by UNHCR ' + dispYear + ' data'
      : m.totalUnhcr + ' countries with UNHCR displacement data';

    var insightsHtml =
      _insight('ACTIVE HUMANITARIAN EVENTS', String(m.total), m.severe + ' severe · ' + m.high + ' high · ' + m.moderate + ' moderate', UNB) +
      _insight('CRITICAL EVENTS', String(m.critical), critDetail, m.critical > 0 ? '#ff0044' : '#00ff88') +
      _insight('CONFLICT ZONES ACTIVE', String(m.conflicts.length), conflictDetail, m.conflicts.length > 0 ? '#ff3300' : UNB) +
      _insight('POPULATION AT RISK', _fmtN(m.totalDisplaced), dispDetail, '#ff9933');

    out += _box(insightsHtml);

    // Severity distribution
    if (m.sevPairs && m.sevPairs.length) {
      out += _box(_lbl('CRISIS SEVERITY DISTRIBUTION') + _bars(m.sevPairs, m.total, UNB));
    }

    // Conflict hotspots
    if (m.conflicts.length) {
      var cHtml = _lbl('CONFLICT ZONES');
      for (var ci = 0; ci < m.conflicts.length; ci++) {
        var cf    = m.conflicts[ci];
        var cfCol = _HUM_SEV_COLOR[cf.severity] || '#ff6633';
        var cfGlide = cf.humanitarianImpact && cf.humanitarianImpact.glide;
        cHtml +=
          '<div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:5px;' +
            'padding:5px 6px;background:rgba(255,30,0,0.05);border-left:2px solid ' + cfCol + ';">' +
            '<div style="flex:1;min-width:0;">' +
              '<div style="font-size:8px;color:' + cfCol + ';line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
                _esc(cf.title.length > 52 ? cf.title.slice(0, 52) + '…' : cf.title) +
              '</div>' +
              '<div style="font-size:7px;color:#2a4a6a;margin-top:1px;">' +
                _esc(cf.severity.toUpperCase()) +
                (cf.country ? ' · ' + _esc(cf.country) : '') +
                (cfGlide ? ' · ' + _esc(cfGlide) : '') +
              '</div>' +
            '</div>' +
          '</div>';
      }
      out += _box(cHtml);
    }

    // Food security + famine
    if (m.foodCrises.length) {
      var fHtml = _lbl('FOOD SECURITY');
      for (var fi = 0; fi < m.foodCrises.length; fi++) {
        var fc    = m.foodCrises[fi];
        var fcCol = fc.category === 'Famine' ? '#cc4400' : '#ffaa00';
        fHtml +=
          '<div style="margin-bottom:5px;padding:4px 6px;border-left:2px solid ' + fcCol + ';background:rgba(255,160,0,0.04);">' +
            '<div style="font-size:8px;color:' + fcCol + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
              _esc(fc.title.length > 52 ? fc.title.slice(0, 52) + '…' : fc.title) +
            '</div>' +
            '<div style="font-size:7px;color:#2a4a6a;margin-top:1px;">' +
              _esc(fc.category.toUpperCase()) + ' · ' + _esc(fc.severity.toUpperCase()) +
              (fc.country ? ' · ' + _esc(fc.country) : '') +
            '</div>' +
          '</div>';
      }
      out += _box(fHtml);
    }

    // Epidemic / disease alerts
    if (m.epidemics.length) {
      var eHtml = _lbl('EPIDEMIC ALERTS');
      for (var ei = 0; ei < m.epidemics.length; ei++) {
        var ep = m.epidemics[ei];
        eHtml +=
          '<div style="margin-bottom:5px;padding:4px 6px;border-left:2px solid #cc44ff;background:rgba(180,50,255,0.04);">' +
            '<div style="font-size:8px;color:#cc44ff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
              _esc(ep.title.length > 52 ? ep.title.slice(0, 52) + '…' : ep.title) +
            '</div>' +
            '<div style="font-size:7px;color:#2a4a6a;margin-top:1px;">' +
              _esc(ep.category.toUpperCase()) + ' · ' + _esc(ep.severity.toUpperCase()) +
              (ep.country ? ' · ' + _esc(ep.country) : '') +
            '</div>' +
          '</div>';
      }
      out += _box(eHtml);
    }

    // Crisis type breakdown
    if (m.catPairs && m.catPairs.length) {
      out += _box(_lbl('CRISIS TYPE BREAKDOWN') + _bars(m.catPairs, m.total, UNB));
    }

    // Country concentration
    if (m.topCountries && m.topCountries.length) {
      out += _box(_lbl('CRISIS CONCENTRATION BY COUNTRY') + _bars(m.topCountries, null, UNB), 0);
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
      '#ax-tabrow{display:flex;align-items:stretch;border-bottom:1px solid rgba(8,24,50,0.95);margin-bottom:0;}' +
      '#ax-tabbar{display:flex;flex:1;}' +

      // Individual tabs
      '.ax-tab{flex:1;background:transparent;border:none;border-bottom:2px solid transparent;' +
        'color:rgba(50,110,150,0.32);font-size:7.5px;letter-spacing:1.5px;' +
        'padding:8px 2px;cursor:pointer;' +
        'transition:color 160ms ease,border-color 160ms ease,text-shadow 160ms ease;' +
        'font-family:inherit;text-align:center;font-weight:700;outline:none;}' +
      '.ax-tab:hover{color:rgba(72,150,190,0.6);}' +
      '.ax-tab-ais.ax-on{color:#4488ff;border-bottom-color:#4488ff;text-shadow:0 0 8px rgba(68,136,255,0.5);}' +
      '.ax-tab-ports.ax-on{color:#00ccff;border-bottom-color:#00ccff;text-shadow:0 0 8px rgba(0,204,255,0.5);}' +
      '.ax-tab-noaa.ax-on{color:#72eeff;border-bottom-color:#72eeff;text-shadow:0 0 8px rgba(114,238,255,0.5);}' +
      '.ax-tab-intel.ax-on{color:#4fc3ff;border-bottom-color:#4fc3ff;text-shadow:0 0 8px rgba(79,195,255,0.4);}' +
      '.ax-tab-gdacs.ax-on{color:#ff6633;border-bottom-color:#ff6633;text-shadow:0 0 8px rgba(255,102,51,0.5);}' +
      '.ax-tab-humanitarian.ax-on{color:#4da6ff;border-bottom-color:#4da6ff;text-shadow:0 0 8px rgba(77,166,255,0.5);}' +
      '@keyframes ax-diamond-pulse{0%,100%{opacity:1;box-shadow:0 0 4px #ff3300}50%{opacity:0.35;box-shadow:0 0 9px #ff3300}}' +

      // Expand button
      '#ax-expand{background:none;border:none;border-left:1px solid rgba(8,28,56,0.6);' +
        'color:rgba(50,110,150,0.3);font-size:11px;padding:0 8px;cursor:pointer;flex-shrink:0;' +
        'transition:color 150ms ease,background 150ms ease;outline:none;line-height:1;}' +
      '#ax-expand:hover{color:#4fc3ff;background:rgba(79,195,255,0.05);}' +
      '#ax-expand.ax-on{color:#4fc3ff;background:rgba(79,195,255,0.08);}' +

      // Timeframe selector row
      '#ax-tfrow{display:flex;align-items:center;gap:2px;padding:5px 0 6px;' +
        'border-bottom:1px solid rgba(8,24,50,0.7);margin-bottom:12px;}' +
      '.ax-tf-btn{flex:1;background:transparent;border:1px solid rgba(8,28,56,0.5);' +
        'border-radius:1px;color:rgba(50,110,150,0.28);font-size:7px;letter-spacing:1.4px;' +
        'padding:4px 2px;cursor:pointer;font-family:inherit;text-align:center;font-weight:700;' +
        'transition:color 140ms ease,border-color 140ms ease,background 140ms ease;outline:none;}' +
      '.ax-tf-btn:hover{color:rgba(79,195,255,0.55);border-color:rgba(8,56,90,0.7);}' +
      '.ax-tf-btn.ax-on{color:#4fc3ff;border-color:#1a4a6a;background:rgba(8,36,66,0.6);' +
        'text-shadow:0 0 6px rgba(79,195,255,0.4);}' +

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
    var tfBtns = _TF_BTNS.map(function (tf) {
      return '<button class="ax-tf-btn' + (tf === _timeframe ? ' ax-on' : '') + '" data-tf="' + tf + '">' + _TF_LABEL[tf] + '</button>';
    }).join('');

    return '<div id="ax-root" style="font-family:var(--font-mono,\'Courier New\',monospace);">' +
      '<div id="ax-tabrow">' +
        '<div id="ax-tabbar">' +
          '<button class="ax-tab ax-tab-ais ax-on"        data-ax="ais">MARITIME</button>'   +
          '<button class="ax-tab ax-tab-ports"             data-ax="ports">IMF</button>'      +
          '<button class="ax-tab ax-tab-noaa"              data-ax="noaa">ENVIRON</button>'   +
          '<button class="ax-tab ax-tab-intel"             data-ax="intel">GEM LNG</button>'  +
          '<button class="ax-tab ax-tab-gdacs"             data-ax="gdacs">CRISIS</button>'   +
          '<button class="ax-tab ax-tab-humanitarian"      data-ax="humanitarian">UN HUM</button>' +
        '</div>' +
        '<button id="ax-expand" title="Expand analytics workspace">⊲</button>' +
      '</div>' +
      '<div id="ax-tfrow">' + tfBtns + '</div>' +
      '<div id="ax-pane-ais"          class="ax-pane ax-show"></div>' +
      '<div id="ax-pane-ports"        class="ax-pane"></div>' +
      '<div id="ax-pane-noaa"         class="ax-pane"></div>' +
      '<div id="ax-pane-intel"        class="ax-pane"></div>' +
      '<div id="ax-pane-gdacs"        class="ax-pane"></div>' +
      '<div id="ax-pane-humanitarian" class="ax-pane"></div>' +
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

    // Timeframe selector clicks
    var tfrow = document.getElementById('ax-tfrow');
    if (tfrow) {
      tfrow.addEventListener('click', function (e) {
        var btn = e.target;
        if (!btn || typeof btn.getAttribute !== 'function') return;
        var tf = btn.getAttribute('data-tf');
        if (tf) _setTimeframe(tf);
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

  // ── Timeframe selector ────────────────────────────────────────────────────────
  function _setTimeframe(tf) {
    if (!_TF_DAYS.hasOwnProperty(tf)) return;
    _timeframe = tf;

    var btns = document.querySelectorAll('#ax-tfrow .ax-tf-btn');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      b.classList.toggle('ax-on', b.getAttribute('data-tf') === tf);
    }

    _repaintAll();
  }

  // Repaint all tabs that have data (so TF change is reflected on next tab switch too)
  function _repaintAll() {
    var all = ['ais', 'ports', 'noaa', 'intel', 'gdacs', 'humanitarian'];
    for (var i = 0; i < all.length; i++) {
      var tab = all[i];
      var hasData = tab === 'ais'          ? !!(_state.ais.data  && _state.ais.data.hasData) :
                    tab === 'ports'        ? !!_state.ports.data  :
                    tab === 'noaa'         ? !!_state.noaa.metrics :
                    tab === 'intel'        ? !!(_state.intel.acled || _state.intel.gem) :
                    tab === 'gdacs'        ? !!_state.gdacs.metrics :
                    tab === 'humanitarian' ? !!(_state.humanitarian.data && _state.humanitarian.data.hasData) : false;
      if (hasData || tab === _activeTab) _repaint(tab);
    }
  }

  // ── Tab switching ─────────────────────────────────────────────────────────────
  function _switchTab(tab) {
    _activeTab = tab;

    var btns = document.querySelectorAll('#ax-tabbar .ax-tab');
    for (var i = 0; i < btns.length; i++) btns[i].classList.remove('ax-on');
    var active = document.querySelector('#ax-tabbar [data-ax="' + tab + '"]');
    if (active) active.classList.add('ax-on');

    var allTabs = ['ais', 'ports', 'noaa', 'intel', 'gdacs', 'humanitarian'];
    for (var j = 0; j < allTabs.length; j++) {
      var pane = document.getElementById('ax-pane-' + allTabs[j]);
      if (!pane) continue;
      if (allTabs[j] === tab) pane.classList.add('ax-show');
      else                     pane.classList.remove('ax-show');
    }

    // On first activation of each tab, trigger data load
    if (tab === 'ais'          && !_state.ais.data)                          _refreshAIS();
    if (tab === 'ports'        && !_state.ports.data)                        _refreshPorts();
    if (tab === 'noaa'         && !_state.noaa.metrics  && !_state.noaa.loading)  _pollNoaa();
    if (tab === 'intel'        && !_state.intel.acled   && !_state.intel.loading) _pollIntel();
    if (tab === 'gdacs'        && !_state.gdacs.metrics && !_state.gdacs.loading) _pollGdacs();
    if (tab === 'humanitarian' && !_state.humanitarian.data)                 _refreshHumanitarian();
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
    var html = tab === 'ais'          ? _renderAIS()          :
               tab === 'ports'        ? _renderPorts()        :
               tab === 'noaa'         ? _renderNoaa()         :
               tab === 'gdacs'        ? _renderGdacs()        :
               tab === 'humanitarian' ? _renderHumanitarian() : _renderIntel();
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
      .catch(function () {
        // ACLED offline — suppress error repaint so GEM renders unobstructed.
        s.acled = null;
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

  // ── Data fetch — GDACS ────────────────────────────────────────────────────────
  function _pollGdacs() {
    var s = _state.gdacs;
    s.loading = true;
    if (!s.metrics) _repaint('gdacs');

    var cache = window.gdacsEventCache;
    if (cache && typeof cache.size === 'number' && cache.size > 0) {
      s.loading = false; s.ts = Date.now(); s.error = null;
      s.metrics = _normalizeGdacs(null);
      _repaint('gdacs');
      return;
    }

    _fetch(GDACS_FN)
      .then(function (json) {
        s.loading = false; s.ts = Date.now(); s.error = null;
        s.metrics = _normalizeGdacs(json);
        _repaint('gdacs');
      })
      .catch(function (err) {
        s.loading = false; s.error = (err && err.message) || 'FETCH ERROR';
        _repaint('gdacs');
      });
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

    _refreshAIS();
    setTimeout(_refreshPorts,        2000);
    setTimeout(_pollNoaa,            5000);
    setTimeout(_pollIntel,           9000);
    setTimeout(_pollGdacs,          12000);
    setTimeout(_refreshHumanitarian, 15000); // after ArgusHumanitarian pipeline completes

    window.addEventListener('argus:portwatch:ready', function () {
      _refreshPorts();
    });

    _timers.ais          = setInterval(_refreshAIS,          REFRESH_AIS_MS);
    _timers.ports        = setInterval(_refreshPorts,        REFRESH_PORTS_MS);
    _timers.noaa         = setInterval(_pollNoaa,            POLL_NOAA);
    _timers.intel        = setInterval(_pollIntel,           POLL_ACLED);
    _timers.gdacs        = setInterval(_pollGdacs,           POLL_GDACS);
    _timers.humanitarian = setInterval(_refreshHumanitarian, 5 * 60 * 1000);
  }

  function refresh() {
    _refreshAIS();
    _refreshPorts();
    _pollNoaa();
    _pollIntel();
    _pollGdacs();
    _refreshHumanitarian();
  }

  function status() {
    return {
      activeTab:   _activeTab,
      timeframe:   _timeframe,
      expanded:    _expanded,
      initialized: _initialized,
      mounted:     _mounted,
      ais:          { hasData: !!(_state.ais.data && _state.ais.data.hasData),  ts: _state.ais.ts   },
      ports:        { hasData: !!_state.ports.data,  ts: _state.ports.ts  },
      noaa:         { hasData: !!_state.noaa.metrics, ts: _state.noaa.ts  },
      intel:        { hasData: !!(_state.intel.acled || _state.intel.gem), ts: _state.intel.ts },
      gdacs:        { hasData: !!_state.gdacs.metrics, ts: _state.gdacs.ts },
      humanitarian: { hasData: !!(_state.humanitarian.data && _state.humanitarian.data.hasData), ts: _state.humanitarian.ts },
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
