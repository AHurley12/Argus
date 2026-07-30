'use strict';
// modules/argusAnalytics.js
// Analytics Lab — reactive consumer of ARGUS in-memory data stores.
//
// Design principle: NO new API calls, NO new fetch intervals.
// Reads globals already populated by the ingestion layer:
//   window.gdelt.getData()          — GDELT events + country tones
//   window.acledEventCache          — ACLED conflict events
//   window._vesselMarkers           — AIS vessel sprites (via EntityRegistry getter)
//   window._aircraftMarkers         — ADS-B aircraft sprites (via EntityRegistry getter)
//   window.gdacsEventCache          — GDACS disaster events
//   window._noaaEvents              — NOAA NWS alerts
//   window._stormEvents             — NHC storm alerts
//   window._fireEvents              — NASA FIRMS fire clusters
//   window.eonetEventCache          — EONET natural events
//   window.energyInfrastructureCache — GEM energy infrastructure
//   window._eiaData                 — EIA oil/gas prices
//   window._fredData                — FRED macro indicators (yield curve, USD)
//   window._avData                  — Yahoo Finance / market data
//   window.ArgusNeuralWeb           — getAnalyticsData(), getPortAnalytics()
//   window.ArgusHumanitarian        — getAllEntities() (ReliefWeb + UNHCR)
//
// Architecture:
//   Single 500ms setInterval polls globals for size/value changes.
//   When any source changes, recompute affected section and set dirty flag.
//   UI re-renders only when dirty. Uses dirty-flag pattern per spec.
//
// UI: 6 collapsible sections — GEOPOLITICAL, MARITIME, AVIATION,
//     ENERGY & MARKETS, ENVIRONMENT & DISASTER, SYSTEM STATUS.
//     Card-style, compact key-value pairs, Unicode trend arrows.
//
// Globals: window.ArgusAnalytics — { init, refresh, status }
// Load order: after all ingestion modules

window.ArgusAnalytics = (function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────────
  var POLL_MS      = 500;
  var TREND_MAX    = 16;   // ~8 seconds of history at 500ms poll
  var SESSION_START = Date.now();

  // ── State ─────────────────────────────────────────────────────────────────────
  var _initialized = false;
  var _dirty       = false;
  var _timer       = null;

  // Collapsed sections — system status collapsed by default, all others open
  var _collapsed = { status: true };

  // Computed data per section
  var _data = {
    geopolitical:  null,
    maritime:      null,
    aviation:      null,
    energy:        null,
    environmental: null,
    status:        null,
  };

  // Previous snapshot for change detection (data source sizes / key values)
  var _snap = {};

  // Trend history: key → circular buffer of numeric values
  var _trends = {};

  // ── Trend tracking ────────────────────────────────────────────────────────────
  function _pushTrend(key, val) {
    if (val == null || val !== val) return;  // ignore null / NaN
    if (!_trends[key]) _trends[key] = [];
    _trends[key].push(val);
    if (_trends[key].length > TREND_MAX) _trends[key].shift();
  }

  // Returns an HTML span with a directional arrow, or '' if no trend.
  function _arrow(key) {
    var buf = _trends[key];
    if (!buf || buf.length < 3) return '';
    var first = buf[0];
    var last  = buf[buf.length - 1];
    var delta = last - first;
    var range = Math.abs(first) || 1;
    if (Math.abs(delta / range) < 0.01) return '<span style="color:#4a7da8;"> →</span>';
    return delta > 0
      ? '<span style="color:#00ff9d;"> ↑</span>'
      : '<span style="color:#ff4466;"> ↓</span>';
  }

  // ── Change detection ──────────────────────────────────────────────────────────
  function _snapshot() {
    var gdeltData = window.gdelt ? window.gdelt.getData() : null;
    var eia = window._eiaData || {};
    var fr  = window._fredData || {};
    return {
      gdelt:    gdeltData ? gdeltData.events.length : 0,
      acled:    window.acledEventCache  ? window.acledEventCache.size  : 0,
      vessels:  window._vesselMarkers   ? window._vesselMarkers.length : 0,
      aircraft: window._aircraftMarkers ? window._aircraftMarkers.length : 0,
      gdacs:    window.gdacsEventCache  ? window.gdacsEventCache.size  : 0,
      noaa:     window._noaaEvents      ? window._noaaEvents.length    : 0,
      storms:   window._stormEvents     ? window._stormEvents.length   : 0,
      fire:     window._fireEvents      ? window._fireEvents.length    : 0,
      eonet:    window.eonetEventCache  ? window.eonetEventCache.size  : 0,
      gem:      window.energyInfrastructureCache ? window.energyInfrastructureCache.size : 0,
      brent:    eia.brent  || 0,
      yield10y: fr.yield10y2y != null ? fr.yield10y2y : -9999,
    };
  }

  function _snapChanged(a, b) {
    for (var k in a) {
      if (!b.hasOwnProperty(k) || a[k] !== b[k]) return true;
    }
    return false;
  }

  // ── Poll & UI refresh ─────────────────────────────────────────────────────────
  function _poll() {
    var next = _snapshot();
    if (_snapChanged(next, _snap)) {
      _snap = next;
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(_recomputeAll, { timeout: 300 });
      } else {
        _recomputeAll();
      }
      _dirty = true;
    }
    if (_dirty) {
      _dirty = false;
      _renderAll();
    }
  }

  // ── Recompute all sections ────────────────────────────────────────────────────
  function _recomputeAll() {
    _data.geopolitical  = _computeGeopolitical();
    _data.maritime      = _computeMaritime();
    _data.aviation      = _computeAviation();
    _data.energy        = _computeEnergy();
    _data.environmental = _computeEnvironmental();
    _data.status        = _computeStatus();
  }

  // ── Compute: Geopolitical ─────────────────────────────────────────────────────
  // Sources: window.gdelt, window.acledEventCache
  function _computeGeopolitical() {
    var gdeltD = window.gdelt ? window.gdelt.getData() : null;
    var events = gdeltD ? (gdeltD.events || []) : [];
    var tones  = gdeltD ? (gdeltD.tones  || {}) : {};

    // GDELT severity counts
    var sev = { CRITICAL: 0, WARNING: 0, WATCH: 0, LOW: 0 };
    var sentSum = 0, sentCount = 0;
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      var s  = ev.severity || 'LOW';
      if (sev.hasOwnProperty(s)) sev[s]++;
      if (typeof ev._sentiment === 'number') { sentSum += ev._sentiment; sentCount++; }
    }

    // Avg tone from tones map (weighted by article count)
    var toneWSum = 0, toneWCount = 0;
    var countryList = [];
    var toneKeys = Object.keys(tones);
    for (var ti = 0; ti < toneKeys.length; ti++) {
      var iso = toneKeys[ti];
      var td  = tones[iso];
      var cnt = td.count || 1;
      var ton = typeof td === 'object' ? (td.tone || 0) : td;
      toneWSum += ton * cnt;
      toneWCount += cnt;
      countryList.push({ k: iso, v: cnt, tone: ton });
    }
    var avgTone = toneWCount > 0 ? toneWSum / toneWCount : null;
    countryList.sort(function (a, b) { return b.v - a.v; });

    // ACLED
    var acledCache = window.acledEventCache;
    var acledTotal = acledCache ? acledCache.size : 0;
    var acledFatalities = 0;
    var acledByType = {};
    if (acledCache) {
      acledCache.forEach(function (ev) {
        acledFatalities += (ev.fatalities || 0);
        var t = ev.eventType || 'Unknown';
        acledByType[t] = (acledByType[t] || 0) + 1;
      });
    }

    _pushTrend('gdelt_count', events.length);
    _pushTrend('acled_count', acledTotal);
    _pushTrend('gdelt_tone',  avgTone);

    return {
      gdeltTotal:      events.length,
      sev:             sev,
      avgTone:         avgTone,
      top5Countries:   countryList.slice(0, 5),
      acledTotal:      acledTotal,
      acledFatalities: acledFatalities,
      acledByType:     acledByType,
      hasData:         events.length > 0 || acledTotal > 0,
    };
  }

  // ── Compute: Maritime ─────────────────────────────────────────────────────────
  // Sources: window._vesselMarkers, window.ArgusNeuralWeb (chokepoints + port analytics)
  function _computeMaritime() {
    var vm = window._vesselMarkers || [];

    // Raw vessel data from marker array
    var byCategory = {};
    var velSum = 0, velCount = 0;
    var stationary = 0, underway = 0;

    for (var i = 0; i < vm.length; i++) {
      var ud = vm[i] && vm[i].userData;
      if (!ud || !ud.isShip) continue;
      var cat = (ud.typeCategory || 'other').toLowerCase();
      byCategory[cat] = (byCategory[cat] || 0) + 1;
      var vel = ud.velocity;
      if (vel != null && !isNaN(vel)) {
        velSum += vel;
        velCount++;
        if (vel < 0.5) stationary++; else underway++;
      }
    }
    var avgSpeed = velCount > 0 ? velSum / velCount : null;

    // Chokepoint data from ArgusNeuralWeb (if available)
    var cpList = [];
    var nw = window.ArgusNeuralWeb;
    if (nw && typeof nw.getAnalyticsData === 'function') {
      var nd = nw.getAnalyticsData();
      if (nd && nd.cpAnalytics) {
        var cpKeys = Object.keys(nd.cpAnalytics);
        for (var ci = 0; ci < cpKeys.length; ci++) {
          var cp = nd.cpAnalytics[cpKeys[ci]];
          cpList.push({ k: cp.label || cpKeys[ci], v: cp.shipCount || 0 });
        }
        cpList.sort(function (a, b) { return b.v - a.v; });
      }
    }

    _pushTrend('vessels',   vm.length);
    _pushTrend('avg_speed', avgSpeed);

    return {
      total:      vm.length,
      byCategory: byCategory,
      avgSpeed:   avgSpeed,
      stationary: stationary,
      underway:   underway,
      chokepoints:cpList.slice(0, 5),
      hasData:    vm.length > 0,
    };
  }

  // ── Compute: Aviation ─────────────────────────────────────────────────────────
  // Sources: window._aircraftMarkers
  function _computeAviation() {
    var am = window._aircraftMarkers || [];

    var byBand = { ground: 0, low: 0, cruising: 0, high: 0 };
    var byType = {};
    var military = 0, civilian = 0;

    for (var i = 0; i < am.length; i++) {
      var ud = am[i] && am[i].userData;
      if (!ud || !ud.isAircraft) continue;
      var alt = ud.alt;
      if      (alt == null || alt < 500)  byBand.ground++;
      else if (alt < 10000)               byBand.low++;
      else if (alt < 35000)               byBand.cruising++;
      else                                byBand.high++;
      var ft = (ud.flightType || 'unknown').toLowerCase();
      byType[ft] = (byType[ft] || 0) + 1;
      if (ft === 'military') military++; else civilian++;
    }

    _pushTrend('aircraft', am.length);

    return {
      total:     am.length,
      byBand:    byBand,
      byType:    byType,
      military:  military,
      civilian:  civilian,
      hasData:   am.length > 0,
    };
  }

  // ── Compute: Energy & Markets ─────────────────────────────────────────────────
  // Sources: window._eiaData, window._fredData, window._avData,
  //          window.energyInfrastructureCache
  function _computeEnergy() {
    var eia = window._eiaData  || {};
    var fr  = window._fredData || {};
    var av  = window._avData   || {};
    var gem = window.energyInfrastructureCache;

    var gemTotal = 0, gemOperating = 0;
    if (gem) {
      gem.forEach(function (asset) {
        gemTotal++;
        var st = (asset.status || '').toLowerCase();
        if (st === 'operating' || st === 'operational') gemOperating++;
      });
    }

    var brent     = eia.brent      != null ? parseFloat(eia.brent)      : null;
    var wti       = eia.wti        != null ? parseFloat(eia.wti)        : null;
    var yield10y2y = fr.yield10y2y != null ? parseFloat(fr.yield10y2y) : null;
    var usdIdx    = fr.usd         != null ? parseFloat(fr.usd)         : null;
    var spy       = av.spy         != null ? parseFloat(av.spy)         : null;
    var spyChg    = av.spyChange   != null ? parseFloat(av.spyChange)   : null;

    _pushTrend('brent',     brent);
    _pushTrend('wti',       wti);
    _pushTrend('spy',       spy);
    _pushTrend('yield10y2y',yield10y2y);

    return {
      brent: brent, brentDate: eia.brentDate || null,
      wti:   wti,   wtiDate:   eia.wtiDate   || null,
      yield10y2y: yield10y2y,
      usdIdx:  usdIdx,
      spy:     spy,
      spyChg:  spyChg,
      gemTotal:    gemTotal,
      gemOperating:gemOperating,
      hasData: brent != null || wti != null || yield10y2y != null || spy != null || gemTotal > 0,
    };
  }

  // ── Compute: Environmental & Disaster ────────────────────────────────────────
  // Sources: window.gdacsEventCache, window._noaaEvents, window._stormEvents,
  //          window._fireEvents, window.eonetEventCache
  function _computeEnvironmental() {
    // GDACS
    var gdacs = window.gdacsEventCache;
    var gRed = 0, gOrange = 0, gGreen = 0;
    if (gdacs) {
      gdacs.forEach(function (ev) {
        var sev = ev.severity || 'green';
        if (sev === 'red') gRed++; else if (sev === 'orange') gOrange++; else gGreen++;
      });
    }
    var gdacsTotal = gRed + gOrange + gGreen;

    // NOAA
    var noaaAlerts  = window._noaaEvents  ? window._noaaEvents.length  : 0;
    var stormAlerts = window._stormEvents ? window._stormEvents.length : 0;

    // FIRMS fire clusters
    var fireArr  = window._fireEvents || [];
    var fireCrit = 0;
    for (var fi = 0; fi < fireArr.length; fi++) {
      if (fireArr[fi].severity === 'CRITICAL') fireCrit++;
    }

    // EONET
    var eonet = window.eonetEventCache;
    var eonetTotal = eonet ? eonet.size : 0;
    var eonetByCat = {};
    if (eonet) {
      eonet.forEach(function (ev) {
        var cat = ev.category || 'unknown';
        eonetByCat[cat] = (eonetByCat[cat] || 0) + 1;
      });
    }

    // ARGUS Global Risk Level — proprietary weighted score
    // Weights: GDACS red × 8, orange × 3, fire critical × 5, storm alerts × 4, NWS × 0.5
    var riskRaw   = gRed * 8 + gOrange * 3 + fireCrit * 5 + stormAlerts * 4 + noaaAlerts * 0.5;
    var riskScore = Math.min(100, Math.round(riskRaw));
    var riskLevel, riskColor;
    if      (riskScore >= 70) { riskLevel = 'CRITICAL'; riskColor = '#ff0044'; }
    else if (riskScore >= 40) { riskLevel = 'HIGH';     riskColor = '#ff8800'; }
    else if (riskScore >= 15) { riskLevel = 'ELEVATED'; riskColor = '#ffcc00'; }
    else                      { riskLevel = 'LOW';      riskColor = '#00ff9d'; }

    _pushTrend('gdacs_total', gdacsTotal);
    _pushTrend('fire_total',  fireArr.length);

    return {
      gdacsTotal: gdacsTotal, gRed: gRed, gOrange: gOrange, gGreen: gGreen,
      noaaAlerts: noaaAlerts, stormAlerts: stormAlerts,
      fireTotal:  fireArr.length, fireCrit: fireCrit,
      eonetTotal: eonetTotal, eonetByCat: eonetByCat,
      riskScore: riskScore, riskLevel: riskLevel, riskColor: riskColor,
      hasData: gdacsTotal > 0 || noaaAlerts > 0 || stormAlerts > 0 || fireArr.length > 0 || eonetTotal > 0,
    };
  }

  // ── Compute: System Status ────────────────────────────────────────────────────
  function _computeStatus() {
    var elapsed = Date.now() - SESSION_START;
    var h = Math.floor(elapsed / 3600000);
    var m = Math.floor((elapsed % 3600000) / 60000);
    var s = Math.floor((elapsed % 60000) / 1000);
    var uptime = ('0' + h).slice(-2) + 'h ' + ('0' + m).slice(-2) + 'm ' + ('0' + s).slice(-2) + 's';

    var sources = [
      { name: 'GDELT',    count: _snap.gdelt    || 0 },
      { name: 'ACLED',    count: _snap.acled    || 0 },
      { name: 'GDACS',    count: _snap.gdacs    || 0 },
      { name: 'NOAA NWS', count: _snap.noaa     || 0 },
      { name: 'NHC',      count: _snap.storms   || 0 },
      { name: 'FIRMS',    count: _snap.fire     || 0 },
      { name: 'EONET',    count: _snap.eonet    || 0 },
      { name: 'GEM LNG',  count: _snap.gem      || 0 },
      { name: 'EIA',      count: _snap.brent > 0 ? 1 : 0 },
      { name: 'FRED',     count: _snap.yield10y !== -9999 ? 1 : 0 },
      { name: 'VESSELS',  count: _snap.vessels  || 0 },
      { name: 'AIRCRAFT', count: _snap.aircraft || 0 },
    ];

    var totalPoints = 0;
    for (var k in _snap) {
      if (_snap.hasOwnProperty(k)) {
        var v = _snap[k];
        if (v > 0) totalPoints += v;
      }
    }

    return { uptime: uptime, sources: sources, totalPoints: totalPoints };
  }

  // ── Render helpers ────────────────────────────────────────────────────────────
  var _ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  function _e(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return _ESC_MAP[c]; });
  }

  function _fmt(n) {
    if (n == null || isNaN(n)) return '—';
    var abs = Math.abs(n);
    if (abs >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  }

  function _fmtDec(n, dec) {
    if (n == null || isNaN(n)) return '—';
    return parseFloat(n).toFixed(dec != null ? dec : 2);
  }

  function _fmtUSD(n) {
    if (n == null || isNaN(n)) return '—';
    return '$' + parseFloat(n).toFixed(2);
  }

  // Key-value row: label left, value right
  function _kv(label, valHtml) {
    return '<div style="display:flex;align-items:baseline;justify-content:space-between;' +
      'padding:3px 0 2px;border-bottom:1px solid rgba(8,22,48,0.65);">' +
      '<span style="font-size:8.5px;letter-spacing:1.1px;color:#3a6a8a;flex-shrink:0;margin-right:8px;">' + _e(label) + '</span>' +
      '<span style="font-size:10px;font-weight:600;color:#c5d7e8;text-align:right;min-width:0;">' + valHtml + '</span>' +
    '</div>';
  }

  // Mini bar: label + count + fill
  function _bar(label, v, maxV, color) {
    var pct = maxV > 0 ? Math.max(1, Math.round(v / maxV * 100)) : 0;
    return '<div style="margin-bottom:3px;">' +
      '<div style="display:flex;justify-content:space-between;margin-bottom:1px;">' +
        '<span style="font-size:8px;color:#3a6a8a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px;">' + _e(label) + '</span>' +
        '<span style="font-size:8px;color:#8aaabf;">' + v + '</span>' +
      '</div>' +
      '<div style="height:2px;background:rgba(8,28,56,0.55);border-radius:1px;">' +
        '<div style="height:2px;width:' + pct + '%;background:' + (color || '#4488ff') + ';border-radius:1px;opacity:0.85;"></div>' +
      '</div>' +
    '</div>';
  }

  // Sub-label (subsection header within a section)
  function _sub(txt) {
    return '<div style="font-size:7.5px;letter-spacing:1.5px;color:#2a5a7a;margin:8px 0 4px;font-weight:700;">' + _e(txt) + '</div>';
  }

  // Severity badge
  function _badge(label, color) {
    return '<span style="background:' + color + '22;border:1px solid ' + color + ';border-radius:2px;' +
      'padding:1px 5px;font-size:7.5px;color:' + color + ';margin-right:3px;">' + _e(label) + '</span>';
  }

  // Section header — clickable, toggles _collapsed[id]
  function _hdr(id, label, color, liveCount) {
    var open = !_collapsed[id];
    var dotAnim = liveCount > 0 ? 'animation:ax-blink 2s ease-in-out infinite;' : '';
    return '<div class="ax2-hdr" data-ax2="' + _e(id) + '" style="' +
      'display:flex;align-items:center;justify-content:space-between;' +
      'padding:8px 0 6px;cursor:pointer;border-bottom:1px solid rgba(8,24,50,0.85);' +
      'margin-bottom:' + (open ? '8px' : '0') + ';user-select:none;">' +
      '<span style="display:flex;align-items:center;gap:6px;">' +
        '<span style="display:inline-block;width:5px;height:5px;border-radius:50%;' +
          'background:' + color + ';box-shadow:0 0 5px ' + color + ';flex-shrink:0;' + dotAnim + '"></span>' +
        '<span style="font-size:8.5px;letter-spacing:2px;color:' + color + ';font-weight:700;">' + _e(label) + '</span>' +
        (liveCount > 0
          ? '<span style="font-size:7.5px;color:' + color + ';opacity:0.55;">(' + liveCount + ')</span>'
          : '') +
      '</span>' +
      '<span style="font-size:9px;color:#2a5a7a;">' + (open ? '▾' : '▸') + '</span>' +
    '</div>';
  }

  function _noData(msg) {
    return '<div style="font-size:8px;color:#2a5a7a;letter-spacing:1.3px;' +
      'padding:8px 0 4px;">' + _e(msg || 'AWAITING DATA') + '</div>';
  }

  // ── Section renderers ─────────────────────────────────────────────────────────

  function _renderGeo() {
    var d   = _data.geopolitical;
    var cnt = d ? d.gdeltTotal + d.acledTotal : 0;
    var out = _hdr('geopolitical', 'GEOPOLITICAL', '#ff6644', cnt);
    if (_collapsed.geopolitical) return out;

    if (!d || !d.hasData) return out + _noData('AWAITING GDELT / ACLED DATA');

    // GDELT
    if (d.gdeltTotal > 0) {
      out += _kv('GDELT EVENTS', _fmt(d.gdeltTotal) + _arrow('gdelt_count'));

      if (d.avgTone != null) {
        var tonColor = d.avgTone < -5 ? '#ff4466' : d.avgTone > 5 ? '#00ff9d' : '#ffcc00';
        out += _kv('AVG TONE',
          '<span style="color:' + tonColor + ';">' + _fmtDec(d.avgTone, 1) + '</span>' + _arrow('gdelt_tone') +
          '<span style="font-size:7.5px;color:#2a5a7a;"> ' + (d.avgTone < 0 ? 'hostile' : 'stable') + '</span>');
      }

      var badges = '';
      if (d.sev.CRITICAL > 0) badges += _badge('CRIT ' + d.sev.CRITICAL, '#ff0044');
      if (d.sev.WARNING  > 0) badges += _badge('WARN ' + d.sev.WARNING,  '#ff8800');
      if (d.sev.WATCH    > 0) badges += _badge('WATCH ' + d.sev.WATCH,   '#ffcc00');
      if (badges) out += '<div style="margin:5px 0;">' + badges + '</div>';

      if (d.top5Countries && d.top5Countries.length) {
        out += _sub('TOP COUNTRIES BY VOLUME');
        var maxC = d.top5Countries[0].v;
        for (var i = 0; i < d.top5Countries.length; i++) {
          var country = d.top5Countries[i];
          var barColor = country.tone < -5 ? '#ff6644' : country.tone > 5 ? '#00cc77' : '#4a8aaa';
          out += _bar(country.k, country.v, maxC, barColor);
        }
      }
    }

    // ACLED
    if (d.acledTotal > 0) {
      out += _sub('ACLED CONFLICT INTELLIGENCE');
      out += _kv('CONFLICT EVENTS', _fmt(d.acledTotal) + _arrow('acled_count'));
      out += _kv('FATALITIES', _fmt(d.acledFatalities));
      var aKeys = Object.keys(d.acledByType).sort(function (a, b) {
        return d.acledByType[b] - d.acledByType[a];
      }).slice(0, 4);
      if (aKeys.length) {
        var aMax = d.acledByType[aKeys[0]];
        for (var ai = 0; ai < aKeys.length; ai++) {
          out += _bar(aKeys[ai], d.acledByType[aKeys[ai]], aMax, '#ff6644');
        }
      }
    }

    return out;
  }

  function _renderMaritime() {
    var d   = _data.maritime;
    var cnt = d ? d.total : 0;
    var out = _hdr('maritime', 'MARITIME', '#4488ff', cnt);
    if (_collapsed.maritime) return out;

    if (!d || !d.hasData) return out + _noData('ENABLE VESSEL LAYER TO LOAD AIS FEED');

    out += _kv('VESSELS', _fmt(d.total) + _arrow('vessels'));
    if (d.avgSpeed != null) {
      out += _kv('AVG SPEED', _fmtDec(d.avgSpeed, 1) + ' kn' + _arrow('avg_speed'));
    }
    out += _kv('STATIONARY', _fmt(d.stationary) +
      '<span style="font-size:7.5px;color:#2a5a7a;"> &lt;0.5 kn</span>');
    out += _kv('UNDERWAY', _fmt(d.underway));

    var catKeys = Object.keys(d.byCategory).sort(function (a, b) {
      return d.byCategory[b] - d.byCategory[a];
    }).slice(0, 6);
    if (catKeys.length) {
      out += _sub('FLEET COMPOSITION');
      var CAT_C = { cargo: '#4488ff', tanker: '#ff9933', military: '#ff4444',
                    passenger: '#00cc77', fishing: '#ffcc00', other: '#4a7a9a' };
      var maxCat = d.byCategory[catKeys[0]];
      for (var i = 0; i < catKeys.length; i++) {
        out += _bar(catKeys[i].toUpperCase(), d.byCategory[catKeys[i]], maxCat,
          CAT_C[catKeys[i]] || '#4488ff');
      }
    }

    if (d.chokepoints && d.chokepoints.length) {
      out += _sub('CHOKEPOINT DENSITY');
      var maxCp = d.chokepoints[0].v;
      for (var ci = 0; ci < d.chokepoints.length; ci++) {
        var cp = d.chokepoints[ci];
        var cpC = cp.v >= 30 ? '#ff2200' : cp.v >= 15 ? '#ff8800' : '#4488ff';
        out += _bar(cp.k, cp.v, maxCp, cpC);
      }
    }

    return out;
  }

  function _renderAviation() {
    var d   = _data.aviation;
    var cnt = d ? d.total : 0;
    var out = _hdr('aviation', 'AVIATION', '#66ddff', cnt);
    if (_collapsed.aviation) return out;

    if (!d || !d.hasData) return out + _noData('ENABLE AIRCRAFT LAYER TO LOAD ADS-B FEED');

    out += _kv('AIRCRAFT', _fmt(d.total) + _arrow('aircraft'));
    out += _kv('MILITARY',
      '<span style="color:' + (d.military > 0 ? '#ff4444' : '#c5d7e8') + ';">' +
      _fmt(d.military) + '</span>' +
      '<span style="font-size:7.5px;color:#2a5a7a;"> ' +
      (d.total > 0 ? Math.round(d.military / d.total * 100) + '%' : '—') + '</span>');
    out += _kv('CIVILIAN', _fmt(d.civilian));

    out += _sub('ALTITUDE DISTRIBUTION');
    var bTotal = d.byBand.ground + d.byBand.low + d.byBand.cruising + d.byBand.high;
    var bMax   = Math.max(d.byBand.ground, d.byBand.low, d.byBand.cruising, d.byBand.high, 1);
    out += _bar('GROUND / TAXI',  d.byBand.ground,   bMax, '#4a7a9a');
    out += _bar('LOW  <10K FT',   d.byBand.low,      bMax, '#66ddff');
    out += _bar('CRUISE 10-35K',  d.byBand.cruising, bMax, '#4fc3ff');
    out += _bar('HIGH  >35K FT',  d.byBand.high,     bMax, '#cc99ff');

    var ftKeys = Object.keys(d.byType).sort(function (a, b) {
      return d.byType[b] - d.byType[a];
    }).slice(0, 4);
    if (ftKeys.length > 1) {
      out += _sub('FLIGHT TYPE');
      var FT_C = { commercial: '#66ddff', cargo: '#4488ff', military: '#ff4444',
                   private: '#cc99ff', unknown: '#4a7a9a' };
      var maxFt = d.byType[ftKeys[0]];
      for (var fi = 0; fi < ftKeys.length; fi++) {
        out += _bar(ftKeys[fi].toUpperCase(), d.byType[ftKeys[fi]], maxFt,
          FT_C[ftKeys[fi]] || '#4a7a9a');
      }
    }

    return out;
  }

  function _renderEnergy() {
    var d   = _data.energy;
    var out = _hdr('energy', 'ENERGY & MARKETS', '#ffcc00', 0);
    if (_collapsed.energy) return out;

    if (!d || !d.hasData) return out + _noData('MARKET DATA LOADING…');

    // Crude oil
    if (d.brent != null || d.wti != null) {
      out += _sub('CRUDE OIL');
      if (d.brent != null) {
        out += _kv('BRENT',
          '<span style="color:#ffcc00;">' + _fmtUSD(d.brent) + '</span>' + _arrow('brent') +
          (d.brentDate ? '<span style="font-size:7.5px;color:#2a5a7a;"> ' + _e(d.brentDate) + '</span>' : ''));
      }
      if (d.wti != null) {
        out += _kv('WTI',
          '<span style="color:#ffcc00;">' + _fmtUSD(d.wti) + '</span>' + _arrow('wti') +
          (d.wtiDate ? '<span style="font-size:7.5px;color:#2a5a7a;"> ' + _e(d.wtiDate) + '</span>' : ''));
      }
      if (d.brent != null && d.wti != null) {
        var spread = (parseFloat(d.brent) - parseFloat(d.wti));
        out += _kv('B-W SPREAD',
          '<span style="color:#c5d7e8;">$' + spread.toFixed(2) + '</span>');
      }
    }

    // FRED macro
    if (d.yield10y2y != null || d.usdIdx != null) {
      out += _sub('MACRO INDICATORS');
      if (d.yield10y2y != null) {
        var yC = d.yield10y2y < 0 ? '#ff4466' : d.yield10y2y < 0.5 ? '#ffcc00' : '#00ff9d';
        out += _kv('YIELD 10Y-2Y',
          '<span style="color:' + yC + ';">' + _fmtDec(d.yield10y2y, 2) + '%</span>' +
          _arrow('yield10y2y') +
          '<span style="font-size:7.5px;color:' + yC + ';"> ' +
          (d.yield10y2y < 0 ? 'INVERTED' : 'NORMAL') + '</span>');
      }
      if (d.usdIdx != null) {
        out += _kv('USD INDEX', _fmtDec(d.usdIdx, 2));
      }
    }

    // Equities
    if (d.spy != null) {
      out += _sub('EQUITIES');
      var spyChgStr   = d.spyChg != null
        ? (d.spyChg >= 0 ? '+' : '') + _fmtDec(d.spyChg, 2) + '%'
        : null;
      var spyChgColor = d.spyChg != null
        ? (d.spyChg >= 0 ? '#00ff9d' : '#ff4466')
        : '#c5d7e8';
      out += _kv('S&P 500 (SPY)',
        '<span style="color:#c5d7e8;">' + _fmtUSD(d.spy) + '</span>' +
        (spyChgStr
          ? ' <span style="color:' + spyChgColor + ';font-size:8.5px;">' + _e(spyChgStr) + '</span>'
          : '') +
        _arrow('spy'));
    }

    // GEM energy infrastructure
    if (d.gemTotal > 0) {
      out += _sub('ENERGY INFRASTRUCTURE (GEM)');
      out += _kv('FACILITIES', _fmt(d.gemTotal));
      out += _kv('OPERATING',
        _fmt(d.gemOperating) +
        (d.gemTotal > 0
          ? '<span style="font-size:7.5px;color:#2a5a7a;"> ' +
            Math.round(d.gemOperating / d.gemTotal * 100) + '%</span>'
          : ''));
    }

    return out;
  }

  function _renderEnvironmental() {
    var d   = _data.environmental;
    var cnt = d ? d.gdacsTotal + d.noaaAlerts + d.stormAlerts + d.fireTotal : 0;
    var out = _hdr('environmental', 'ENVIRONMENT & DISASTER', '#ff8800', cnt);
    if (_collapsed.environmental) return out;

    if (!d || !d.hasData) return out + _noData('NO ACTIVE ALERTS');

    // ARGUS Global Risk Level — proprietary metric
    out += '<div style="padding:6px 10px;background:rgba(3,9,22,0.7);' +
      'border:1px solid ' + d.riskColor + ';border-left:3px solid ' + d.riskColor + ';' +
      'margin-bottom:8px;">' +
      '<div style="font-size:7px;letter-spacing:1.5px;color:' + d.riskColor + ';margin-bottom:2px;">' +
        'ARGUS GLOBAL RISK LEVEL — PROPRIETARY</div>' +
      '<div style="font-size:18px;font-weight:700;color:' + d.riskColor + ';' +
        'letter-spacing:-0.5px;line-height:1.1;">' + _e(d.riskLevel) + '</div>' +
    '</div>';

    // GDACS
    if (d.gdacsTotal > 0) {
      out += _sub('GDACS DISASTERS');
      out += _kv('TOTAL', _fmt(d.gdacsTotal) + _arrow('gdacs_total'));
      if (d.gRed    > 0) out += _kv('EXTREME', '<span style="color:#ff3300;">' + d.gRed    + '</span>');
      if (d.gOrange > 0) out += _kv('SEVERE',  '<span style="color:#ff8800;">' + d.gOrange + '</span>');
      if (d.gGreen  > 0) out += _kv('WATCH',   '<span style="color:#33cc77;">' + d.gGreen  + '</span>');
    }

    // NOAA
    if (d.noaaAlerts > 0 || d.stormAlerts > 0) {
      out += _sub('NOAA WEATHER');
      if (d.noaaAlerts  > 0) out += _kv('NWS ALERTS',   _fmt(d.noaaAlerts));
      if (d.stormAlerts > 0) out += _kv('NHC STORMS',   _fmt(d.stormAlerts));
    }

    // FIRMS
    if (d.fireTotal > 0) {
      out += _sub('NASA FIRMS THERMAL');
      out += _kv('FIRE CLUSTERS', _fmt(d.fireTotal) + _arrow('fire_total'));
      if (d.fireCrit > 0) {
        out += _kv('CRITICAL', '<span style="color:#ff4400;">' + d.fireCrit + '</span>');
      }
    }

    // EONET
    if (d.eonetTotal > 0) {
      out += _sub('NASA EONET EVENTS');
      out += _kv('ACTIVE', _fmt(d.eonetTotal));
      var eKeys = Object.keys(d.eonetByCat)
        .sort(function (a, b) { return d.eonetByCat[b] - d.eonetByCat[a]; })
        .slice(0, 4);
      if (eKeys.length) {
        var eMax = d.eonetByCat[eKeys[0]];
        for (var ei = 0; ei < eKeys.length; ei++) {
          out += _bar(eKeys[ei].replace(/_/g, ' ').toUpperCase(), d.eonetByCat[eKeys[ei]], eMax, '#ff8800');
        }
      }
    }

    return out;
  }

  function _renderStatus() {
    var d   = _data.status;
    var out = _hdr('status', 'SYSTEM STATUS', '#4a7da8', 0);
    if (_collapsed.status) return out;

    if (!d) return out + _noData();

    out += _kv('SESSION UPTIME', '<span style="font-size:9px;color:#c5d7e8;">' + _e(d.uptime) + '</span>');
    out += _kv('DATA POINTS', _fmt(d.totalPoints));

    out += _sub('SOURCE STATUS');
    for (var i = 0; i < d.sources.length; i++) {
      var src = d.sources[i];
      var dot = src.count > 0
        ? '<span style="color:#00ff9d;">●</span> '
        : '<span style="color:#2a5a7a;">○</span> ';
      out += '<div style="display:flex;align-items:center;justify-content:space-between;' +
        'padding:2px 0;border-bottom:1px solid rgba(8,22,48,0.4);">' +
        '<span style="font-size:8px;color:#3a6a8a;">' + dot + _e(src.name) + '</span>' +
        '<span style="font-size:8px;color:' + (src.count > 0 ? '#c5d7e8' : '#2a5a7a') + ';">' +
          (src.count > 0 ? _fmt(src.count) : '—') +
        '</span>' +
      '</div>';
    }

    return out;
  }

  // ── Render all sections ────────────────────────────────────────────────────────
  function _renderAll() {
    var body = document.getElementById('ax-lab-body');
    if (!body) return;

    body.innerHTML =
      '<div id="ax2-root" style="' +
        'font-family:var(--font-mono,\'DM Mono\',\'Courier New\',monospace);' +
        'padding:2px 2px 20px;">' +
      _renderGeo() +
      _renderMaritime() +
      _renderAviation() +
      _renderEnergy() +
      _renderEnvironmental() +
      _renderStatus() +
      '</div>';

    // Bind collapse toggles
    var hdrs = body.querySelectorAll('.ax2-hdr');
    for (var i = 0; i < hdrs.length; i++) {
      hdrs[i].addEventListener('click', _onToggle);
    }
  }

  function _onToggle(e) {
    var id = e.currentTarget.getAttribute('data-ax2');
    if (!id) return;
    _collapsed[id] = !_collapsed[id];
    _dirty = true;
    // Immediate re-render for snappy toggle feel
    if (_dirty) {
      _dirty = false;
      _renderAll();
    }
  }

  // ── CSS ───────────────────────────────────────────────────────────────────────
  function _injectCSS() {
    if (document.getElementById('ax2-css')) return;
    var el = document.createElement('style');
    el.id  = 'ax2-css';
    el.textContent =
      '@keyframes ax-blink{0%,100%{opacity:1}50%{opacity:.15}}' +
      '.ax2-hdr:hover{opacity:.8;}';
    document.head.appendChild(el);
  }

  // ── Init & lifecycle ──────────────────────────────────────────────────────────
  function init() {
    if (_initialized) return;
    _initialized = true;

    _injectCSS();

    // Initial snapshot + render
    _snap = _snapshot();
    _recomputeAll();
    _renderAll();

    // Single 500ms poll — change detection + UI refresh
    _timer = setInterval(_poll, POLL_MS);

    // Refresh immediately on portwatch ready event
    window.addEventListener('argus:portwatch:ready', function () {
      _snap = {};  // force recompute next tick
    });
  }

  // Lazy init: activate on first analytics tab click
  setTimeout(function () {
    var btn  = document.querySelector('.nw-tab-btn[data-tab="analytics"]');
    var pane = document.getElementById('nw-pane-analytics');
    if (btn)  btn.addEventListener('click', function () { if (!_initialized) init(); });
    if (pane && pane.classList.contains('is-active')) init();
  }, 1500);

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusAnalytics');

  return {
    init:    init,
    refresh: function () { _snap = {}; },
    status:  function () { return { initialized: _initialized, data: _data, snap: _snap }; },
  };

}());
