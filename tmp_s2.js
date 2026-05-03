(function() {
'use strict';

// ── Colour maps ──────────────────────────────────────────────────────────────
var RC = { LOW:'#00ff88', WATCH:'#ffcc00', WARNING:'#ff9933', CRITICAL:'#ff0044' };
var RB = { LOW:'rgba(0,255,136,0.08)', WATCH:'rgba(255,204,0,0.08)', WARNING:'rgba(255,153,51,0.1)', CRITICAL:'rgba(255,0,68,0.13)' };

// ════════════════════════════════════════════════════════════════════════════
// ArgusAnim — micro-animation utilities
// ════════════════════════════════════════════════════════════════════════════
window.ArgusAnim = (function() {
  var CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789◈■▪·';
  var rand  = function() { return CHARS[Math.floor(Math.random() * CHARS.length)]; };

  // Cipher decode: scrambles text through random chars then resolves letter-by-letter
  // el        — DOM element whose textContent to animate
  // finalText — string to resolve to
  // duration  — total ms (default 520)
  function cipherDecode(el, finalText, duration) {
    if (!el || !finalText) return;
    duration = duration || 520;
    el.classList.add('cipher-decoding');
    var len      = finalText.length;
    var resolved = new Array(len).fill(false);
    var start    = null;
    var stagger  = duration / len;            // spread resolve points evenly
    var scramble = duration * 0.25;          // scramble for first 25 % of duration

    function frame(ts) {
      if (!start) start = ts;
      var elapsed = ts - start;

      // Resolve each character at its designated time
      var text = '';
      for (var i = 0; i < len; i++) {
        if (resolved[i]) {
          text += finalText[i];
        } else if (elapsed >= i * stagger) {
          resolved[i] = true;
          text += finalText[i];
        } else {
          // Preserve whitespace so word-wrap boundaries hold during scramble
          text += /\s/.test(finalText[i]) ? finalText[i] : rand();
        }
      }
      el.textContent = text;

      if (resolved.every(Boolean)) {
        el.textContent = finalText;
        el.classList.remove('cipher-decoding');
        return;
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // Stagger a list of elements with --row-i CSS custom property
  function staggerRows(container) {
    var items = container.querySelectorAll(
      '.detail__row, .detail__section-header, .detail__status-box, .detail__placeholder'
    );
    items.forEach(function(el, i) {
      el.style.setProperty('--row-i', i);
      // Re-trigger animation by removing and re-adding the element's key property
      el.style.animationName = 'none';
      requestAnimationFrame(function() { el.style.animationName = ''; });
    });
  }

  // Typewriter: streams text into el character by character
  // Handles existing HTML safely — strips tags for streaming, restores on done
  function typewriter(el, finalHtml, cps) {
    cps = cps || 76; // characters per second
    var plain = finalHtml.replace(/<[^>]+>/g, ''); // plain text for streaming
    var i     = 0;
    el.textContent = '';
    var iv = setInterval(function() {
      if (i >= plain.length) {
        clearInterval(iv);
        el.innerHTML = finalHtml; // restore full HTML with any spans/links
        return;
      }
      el.textContent += plain[i++];
    }, 1000 / cps);
    return iv;
  }

  return { cipherDecode: cipherDecode, staggerRows: staggerRows, typewriter: typewriter };
})(); // end ArgusAnim

if (typeof window.updateNodeCounts !== 'function') window.updateNodeCounts = function() {};

// Supabase anon key — safe to expose, enforced by RLS on the server
var SUPA_ANON_GDELT  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndidnpseHRyb2V3eHJtb254b2R4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM3OTQzNzMsImV4cCI6MjA4OTM3MDM3M30.0zp-wQ3wKpYc0f7LqFCOEea_d9HJuWnUSWgF4BAW82w';

// ── Live data stores ─────────────────────────────────────────────────────────
window._avData        = {};
window._eiaData       = null;
window._fredData      = null;

// ════════════════════════════════════════════════════════════════════════════
// ArgusData — all API fetches + intelligence snapshot
// ════════════════════════════════════════════════════════════════════════════
window.ArgusData = (function() {

  function setEl(id, val, decimals, prefix) {
    var el = document.getElementById(id);
    if (!el || val == null) return;
    el.textContent = (prefix || '') + parseFloat(val).toFixed(decimals);
  }

  // ── EIA — Brent, WTI spot prices + crude inventories ─────────────────────
  // Brent/WTI: EIA petroleum spot price series (daily, 1–2 day lag acceptable)
  // Inventories: weekly US crude stock (WCESTUS1)
  // TTL 24h — stale data is acceptable for these slowly-moving series
  // ── Brent-WTI spread fallback: Brent - WTI from whichever source populated the values ──
  function updateBrentWTISpread() {
    var bEl = document.getElementById('brent-val');
    var wEl = document.getElementById('wti-val');
    var sEl = document.getElementById('contango-val');
    if (!sEl || !bEl || !wEl) return;
    var brent = parseFloat(bEl.textContent.replace('$', ''));
    var wti   = parseFloat(wEl.textContent.replace('$', ''));
    if (isNaN(brent) || isNaN(wti)) return;
    var spread = brent - wti;
    sEl.textContent = (spread >= 0 ? '+' : '') + '$' + spread.toFixed(2);
    sEl.style.color = '#c5d7e8';
  }

  function renderEIATicker() {
    var d = window._eiaData;
    if (!d) return;
    function sp(id, val) {
      var el = document.getElementById(id);
      if (!el || val == null) return;
      el.textContent = '$' + parseFloat(val).toFixed(2);
    }
    sp('brent-val', d.brent);
    sp('wti-val',   d.wti);
    var invEl = document.getElementById('crude-inv-val');
    if (invEl && d.crudeInv != null) {
      var inv = parseFloat(d.crudeInv);
      invEl.textContent = inv.toFixed(1) + ' Mb';
      invEl.style.color = '#c5d7e8';
    }
    updateBrentWTISpread();
  }

  // ── FRED — USD Index, GEPU, Yield Curve ──────────────────────────────────
  function renderFREDTicker() {
    var d = window._fredData;
    if (!d) return;
    var usdEl = document.getElementById('usd-val');
    if (usdEl && d.usd != null) usdEl.textContent = parseFloat(d.usd).toFixed(2);
    var gepuEl = document.getElementById('gepu-val');
    if (gepuEl && d.gepu != null) {
      gepuEl.textContent = Math.round(d.gepu);
      gepuEl.style.color = d.gepu > 200 ? '#ff0044' : d.gepu > 130 ? '#ff9933' : d.gepu > 80 ? '#ffcc00' : '#00ff88';
    }
    var yEl = document.getElementById('yield-val');
    if (yEl && d.yield10y2y != null) {
      yEl.textContent = parseFloat(d.yield10y2y).toFixed(2) + '%';
      yEl.style.color = d.yield10y2y < 0 ? '#ff0044' : d.yield10y2y < 0.5 ? '#ffcc00' : '#00ff88';
    }
  }

  // ── Intelligence Snapshot ─────────────────────────────────────────────────
  function buildSnapshot() {
    try {
      var ts = new Date().toUTCString(), L = [];
      var eia = window._eiaData || {}, av = window._avData || {}, fr = window._fredData || {};
      var countries = window.COUNTRIES_DATA || [], chokepoints = window.CHOKEPOINTS_DATA || [];
      var routes = window.ROUTES_DATA || [], capitals = window.capitalCitiesData || [];

      L.push('=== ARGUS INTELLIGENCE SNAPSHOT ===');
      L.push('Generated: ' + ts); L.push('');

      L.push('--- ENERGY PRICES (EIA) ---');
      L.push('Brent Crude:       ' + (eia.brent    ? '$' + parseFloat(eia.brent).toFixed(2)    + ' /bbl'   : 'pending') + ' (' + (eia.brentDate    || '—') + ')');
      L.push('WTI Crude:         ' + (eia.wti      ? '$' + parseFloat(eia.wti).toFixed(2)      + ' /bbl'   : 'pending') + ' (' + (eia.wtiDate      || '—') + ')');
      L.push('Henry Hub Gas:     ' + (eia.henryHub ? '$' + parseFloat(eia.henryHub).toFixed(2) + ' /MMBtu' : 'pending') + ' (' + (eia.henryHubDate || '—') + ')');
      L.push('US Electricity:    ' + (eia.elecGen  ? (parseFloat(eia.elecGen)/1000).toFixed(0) + ' TWh/mo' : 'pending') + ' (' + (eia.elecGenDate  || '—') + ')');
      L.push('');

      L.push('--- FOREX & MARKETS ---');
      L.push('EUR/USD: ' + (av['fx-eurusd'] ? parseFloat(av['fx-eurusd']).toFixed(4) : 'pending'));
      L.push('GBP/USD: ' + (av['fx-gbpusd'] ? parseFloat(av['fx-gbpusd']).toFixed(4) : 'pending'));
      L.push('USD/JPY: ' + (av['fx-usdjpy'] ? parseFloat(av['fx-usdjpy']).toFixed(2) : 'pending'));
      L.push('S&P 500 (SPY): ' + (av.spy != null ? '$' + parseFloat(av.spy).toFixed(2) + (av.spyChange ? ' (' + av.spyChange + ')' : '') : 'pending'));
      L.push('');

      L.push('--- MACRO INDICATORS ---');
      L.push('USD Trade Index:    ' + (fr.usd        != null ? parseFloat(fr.usd).toFixed(2)              : 'pending') + ' (' + (fr.usdDate   || '—') + ')');
      L.push('Policy Uncertainty: ' + (fr.gepu       != null ? Math.round(fr.gepu) + ' GEPU'              : 'pending') + ' (' + (fr.gepuDate  || '—') + ')');
      L.push('Yield Curve 10Y-2Y: ' + (fr.yield10y2y != null ? parseFloat(fr.yield10y2y).toFixed(2) + '%' : 'pending') + ' (' + (fr.yieldDate || '—') + ')');
      L.push('');

      L.push('--- COUNTRY PROFILES ---');
      countries.forEach(function(c) {
        L.push(c.code + ' | ' + c.label);
        L.push('  GDP: ' + c.gdp + '  Exports: ' + c.exports + '  Imports: ' + c.imports);
        L.push('  Risk: ' + c.risk + ' (score ' + c.score + '/100)');
        L.push('  Top Exports: ' + c.topE.join(', '));
        L.push('  Top Imports: ' + c.topI.join(', '));
        var prod = window._eiaProduction && window._eiaProduction[c.code];
        if (prod) L.push('  Crude Production: ' + prod.value + ' TBPD (' + prod.period + ')');
        L.push('');
      });

      L.push('--- STRATEGIC CHOKEPOINTS ---');
      chokepoints.forEach(function(cp) {
        L.push(cp.id.toUpperCase() + ' | ' + cp.label);
        L.push('  Risk: ' + cp.risk + '  Traffic: ' + cp.traffic + '  Volume: ' + cp.volume);
        L.push('  Status: ' + cp.status);
        var pw = window._portData && window._portData[cp.id];
        if (pw) {
          L.push('  Port Calls: total=' + pw.portcalls + ' container=' + pw.portcalls_container + ' tanker=' + pw.portcalls_tanker + ' bulk=' + pw.portcalls_dry_bulk);
          L.push('  Flow: imports=' + pw.import + ' exports=' + pw.export);
        }
        L.push('');
      });

      // ── IMF PortWatch analytics signals ──────────────────────────────────────
      var pwSignals = window._portWatchSignals;
      var pwState   = window._portWatchState;
      if (pwSignals && pwSignals.length) {
        L.push('--- IMF PORTWATCH ANALYTICS SIGNALS (' + (pwState && pwState.period || 'pending') + ') ---');
        pwSignals.forEach(function(s) {
          L.push('[' + s.type + '|' + s.severity + '] ' + s.detail);
        });
        L.push('');
      }

      L.push('--- ACTIVE TRADE ROUTES ---');
      routes.forEach(function(r) {
        var f = countries.find(function(c) { return c.code === r.from; });
        var t = countries.find(function(c) { return c.code === r.to; });
        if (!f || !t) return;
        L.push(r.from + '→' + r.to + ' | ' + f.label + ' → ' + t.label);
        L.push('  Risk: ' + r.risk + '  Volume index: ' + r.vol);
      });
      L.push('');

      L.push('--- LIVE INTELLIGENCE EVENTS ---');
      if (window._liveEventContext) {
        L.push(window._liveEventContext);
      } else {
        document.querySelectorAll('.event-card').forEach(function(el) {
          var type   = el.querySelector('.event-card__type') && el.querySelector('.event-card__type').textContent;
          var title  = el.querySelector('.event-card__title') && el.querySelector('.event-card__title').textContent;
          var detail = el.querySelector('.event-card__detail') && el.querySelector('.event-card__detail').textContent;
          if (title) { L.push('[' + (type || 'EVENT') + '] ' + title); if (detail) L.push('  ' + detail.trim()); }
        });
      }
      L.push('');

      // ── UN ReliefWeb active crises ─────────────────────────────────────────
      if (window._rwData && Object.keys(window._rwData).length) {
        L.push('--- UN RELIEFWEB: ACTIVE HUMANITARIAN CRISES ---');
        var critCountries = [];
        var warnCountries = [];
        Object.keys(window._rwData).forEach(function(iso) {
          var entry = window._rwData[iso];
          if (!entry.disasters || !entry.disasters.length) return;
          var hasCrit = entry.disasters.some(function(x) { return x.sev === 'CRITICAL'; });
          var hasWarn = entry.disasters.some(function(x) { return x.sev === 'WARNING'; });
          if (hasCrit) critCountries.push(iso);
          else if (hasWarn) warnCountries.push(iso);
          var worst = entry.disasters[0];
          L.push(iso + ' | ' + worst.name + ' [' + worst.sev + '] Types: ' + worst.types.join(', ') + ' | Crises: ' + entry.disasters.length);
          if (entry.displaced) L.push('  IDPs: ' + Number(entry.displaced).toLocaleString());
          if (entry.refugees)  L.push('  Refugees hosted: ' + Number(entry.refugees).toLocaleString());
          if (entry.sitreps && entry.sitreps[0]) L.push('  Latest sitrep: ' + entry.sitreps[0].title.slice(0, 100));
        });
        L.push('CRITICAL countries: ' + critCountries.join(', ') || 'none');
        L.push('WARNING countries: '  + warnCountries.join(', ')  || 'none');
        L.push('Source: UN OCHA ReliefWeb · UNHCR');
        L.push('');
      }

      L.push('--- CAPITAL CITY COORDINATES ---');
      capitals.forEach(function(c) { L.push(c.capital + ': ' + c.lat + '°N (' + c.country + ')'); });
      L.push('');
      L.push('=== END SNAPSHOT ===');

      var snapshot = L.join('\n');
      window._argusSnapshot = snapshot;
      try {
        localStorage.setItem('argus_snapshot', snapshot);
        localStorage.setItem('argus_snapshot_ts', String(Date.now()));
      } catch(e) {}
      console.log('Snapshot built: ' + L.length + ' lines');
      return snapshot;
    } catch(e) {
      console.warn('buildSnapshot error:', e.message);
      return window._argusSnapshot || 'SNAPSHOT PENDING';
    }
  }

  function downloadSnapshot() {
    var snap = buildSnapshot();
    var blob = new Blob([snap], { type: 'text/plain' });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href = url; a.download = 'argus-snapshot-' + Date.now() + '.txt'; a.click();
    URL.revokeObjectURL(url);
  }

  // ── Exchange symbol registry — used by selectExchange() for chart lookups ──
  var EXCHANGE_SYMBOLS = [
    { sym: 'VIX',  tdSym: 'VIXY', avSym: 'VIXY', pgSym: null,  elId: 'idx-vix',    chgId: null,             label: 'VIX'        },
    { sym: 'FTSE', tdSym: 'EWU',  avSym: 'EWU',  pgSym: null,  elId: 'idx-ftse',   chgId: 'idx-ftse-chg',   label: 'FTSE 100'   },
    { sym: 'DAX',  tdSym: 'EWG',  avSym: 'EWG',  pgSym: null,  elId: 'idx-dax',    chgId: 'idx-dax-chg',    label: 'DAX'        },
    { sym: 'N225', tdSym: 'EWJ',  avSym: 'EWJ',  pgSym: null,  elId: 'idx-nikkei', chgId: 'idx-nikkei-chg', label: 'NIKKEI 225' },
    { sym: 'HSI',  tdSym: 'FXI',  avSym: 'FXI',  pgSym: null,  elId: 'idx-hsi',    chgId: 'idx-hsi-chg',    label: 'HANG SENG'  },
    { sym: 'KSA',  tdSym: 'KSA',  avSym: 'KSA',  pgSym: 'KSA', elId: 'idx-ksa',    chgId: 'idx-ksa-chg',    label: 'SAUDI/GULF' },
    { sym: 'NYA',  tdSym: 'SPY',  avSym: 'NYA',  pgSym: 'IYY', elId: 'idx-nyse',   chgId: 'idx-nyse-chg',   label: 'NYSE (SPY)' },
  ];

  function toggleExchanges() {
    var popup   = document.getElementById('exchanges-popup');
    var overlay = document.getElementById('exchanges-overlay');
    if (!popup) return;
    var open = popup.classList.toggle('is-open');
    if (overlay) overlay.classList.toggle('is-open', open);
  }

  // Twelve Data — time series for chart (on-demand, via Netlify proxy)
  function fetchTDHistory(tdSym) {
    return fetch('/.netlify/functions/fetch-td-history?symbol=' + encodeURIComponent(tdSym))
      .then(function(r) { if (!r.ok) throw new Error('TD history HTTP ' + r.status); return r.json(); })
      .then(function(d) {
        if (d.error) throw new Error(d.error);
        var prices = d.prices || [];
        var dates  = d.dates  || [];
        if (!prices.length) throw new Error('TD history: no prices');
        return { prices: prices, dates: dates };
      });
  }

  var chartCache = {};
  var chartDebounceTimer = null;

  // ── Inline SVG sparkline chart with Y/X axis markers ─────────────────────
  function drawChart(prices, sym) {
    var svg = document.getElementById('exchanges-chart');
    if (!svg || !prices || !prices.length) return;

    while (svg.firstChild) svg.removeChild(svg.firstChild);

    var W = 292, H = 70;
    var PL = 36, PR = 4, PT = 5, PB = 4; // left pad wider for Y-axis labels
    var CW = W - PL - PR, CH = H - PT - PB;

    var min = Math.min.apply(null, prices);
    var max = Math.max.apply(null, prices);
    if (min === max) { min -= 1; max += 1; }
    var yRange = max - min;
    var xStep = CW / (prices.length - 1);

    function px(i) { return PL + i * xStep; }
    function py(p)  { return PT + (1 - (p - min) / yRange) * CH; }

    // Compact number format for Y labels: 21300 → "21.3k", 8500 → "8.5k"
    function fmtY(n) {
      if (n >= 10000) return (n / 1000).toFixed(0) + 'k';
      if (n >= 1000)  return (n / 1000).toFixed(1) + 'k';
      return n.toFixed(0);
    }

    var isUp = prices[prices.length - 1] >= prices[0];
    var lineCol = isUp ? '#00ff88' : '#ff0044';

    // Gradient defs
    var defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = '<linearGradient id="cg-' + sym + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + lineCol + '" stop-opacity="0.18"/>' +
      '<stop offset="100%" stop-color="' + lineCol + '" stop-opacity="0"/>' +
      '</linearGradient>';
    svg.appendChild(defs);

    // Gradient fill area
    var areaPath = 'M' + PL + ',' + (PT + CH) + ' ';
    areaPath += prices.map(function(p, i) {
      return (i === 0 ? 'L' : '') + px(i).toFixed(1) + ',' + py(p).toFixed(1) + ' ';
    }).join('');
    areaPath += 'L' + px(prices.length - 1).toFixed(1) + ',' + (PT + CH) + ' Z';
    var area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    area.setAttribute('d', areaPath);
    area.setAttribute('fill', 'url(#cg-' + sym + ')');
    svg.appendChild(area);

    // Y-axis spine
    var ySpine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    ySpine.setAttribute('x1', PL); ySpine.setAttribute('y1', PT);
    ySpine.setAttribute('x2', PL); ySpine.setAttribute('y2', PT + CH);
    ySpine.setAttribute('stroke', '#1a3a5a'); ySpine.setAttribute('stroke-width', '0.5');
    svg.appendChild(ySpine);

    // X-axis (baseline)
    var base = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    base.setAttribute('x1', PL);     base.setAttribute('y1', PT + CH);
    base.setAttribute('x2', W - PR); base.setAttribute('y2', PT + CH);
    base.setAttribute('stroke', '#1a3a5a'); base.setAttribute('stroke-width', '0.5');
    svg.appendChild(base);

    // Y-axis markers: max / mid / min
    var mid = (min + max) / 2;
    [{ val: max, y: py(max) }, { val: mid, y: py(mid) }, { val: min, y: py(min) }]
      .forEach(function(lbl) {
        var tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        tick.setAttribute('x1', PL - 3); tick.setAttribute('y1', lbl.y.toFixed(1));
        tick.setAttribute('x2', PL);     tick.setAttribute('y2', lbl.y.toFixed(1));
        tick.setAttribute('stroke', '#2a4a6a'); tick.setAttribute('stroke-width', '0.5');
        svg.appendChild(tick);

        var t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        t.setAttribute('x', (PL - 5).toString());
        t.setAttribute('y', (lbl.y + 1.8).toFixed(1));
        t.setAttribute('text-anchor', 'end');
        t.setAttribute('style', 'font-size:5.5px;fill:#4a7da8;font-family:monospace');
        t.textContent = fmtY(lbl.val);
        svg.appendChild(t);
      });

    // X-axis date markers: start / mid / end — sourced from chartCache
    var dates = (chartCache[sym] && chartCache[sym].dates) || [];
    if (dates.length >= 2) {
      var midIdx = Math.floor(dates.length / 2);
      [
        { label: dates[0],           idx: 0,          anchor: 'start'  },
        { label: dates[midIdx],      idx: midIdx,      anchor: 'middle' },
        { label: dates[dates.length - 1], idx: dates.length - 1, anchor: 'end' },
      ].forEach(function(m) {
        var tx = px(m.idx).toFixed(1);
        var tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        tick.setAttribute('x1', tx); tick.setAttribute('y1', (PT + CH).toString());
        tick.setAttribute('x2', tx); tick.setAttribute('y2', (PT + CH + 3).toString());
        tick.setAttribute('stroke', '#2a4a6a'); tick.setAttribute('stroke-width', '0.5');
        svg.appendChild(tick);

        var t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        t.setAttribute('x', tx);
        t.setAttribute('y', (PT + CH + 9).toString());
        t.setAttribute('text-anchor', m.anchor);
        t.setAttribute('style', 'font-size:5px;fill:#4a7da8;font-family:monospace');
        t.textContent = m.label;
        svg.appendChild(t);
      });
    }

    // Sparkline (drawn on top of axes)
    var pts = prices.map(function(p, i) {
      return px(i).toFixed(1) + ',' + py(p).toFixed(1);
    }).join(' ');
    var poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    poly.setAttribute('points', pts);
    poly.setAttribute('fill', 'none');
    poly.setAttribute('stroke', lineCol);
    poly.setAttribute('stroke-width', '1.5');
    poly.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(poly);

    // Last price dot
    var dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', px(prices.length - 1).toFixed(1));
    dot.setAttribute('cy', py(prices[prices.length - 1]).toFixed(1));
    dot.setAttribute('r', '2.5');
    dot.setAttribute('fill', lineCol);
    svg.appendChild(dot);
  }

  function selectExchange(sym, label) {
    document.querySelectorAll('.exchanges-popup__row').forEach(function(r) { r.classList.remove('is-selected'); });
    var row = document.getElementById('ex-row-' + sym);
    if (row) row.classList.add('is-selected');
    document.getElementById('chart-label').textContent = label;

    // Instant render if already cached
    if (chartCache[sym] && chartCache[sym].prices && chartCache[sym].prices.length) {
      var d = chartCache[sym];
      if (d.dates && d.dates.length) {
        document.getElementById('chart-range').textContent = d.dates[0] + ' → ' + d.dates[d.dates.length - 1];
      }
      drawChart(d.prices, sym);
      return;
    }

    // Debounce — wait 2s before firing network request (prevents rapid-click rate limits)
    if (chartDebounceTimer) clearTimeout(chartDebounceTimer);
    document.getElementById('chart-label').textContent = label + ' — LOADING…';
    var item = EXCHANGE_SYMBOLS.find(function(i) { return i.sym === sym; });
    if (!item) return;

    chartDebounceTimer = setTimeout(function() {
      fetchTDHistory(item.tdSym)
        .then(function(d) {
          chartCache[sym] = d;
          document.getElementById('chart-label').textContent = label;
          if (d.dates && d.dates.length) {
            document.getElementById('chart-range').textContent = d.dates[0] + ' → ' + d.dates[d.dates.length - 1];
          }
          drawChart(d.prices, sym);
        })
        .catch(function(err) {
          document.getElementById('chart-label').textContent = label + ' — ERROR';
          console.warn('Chart fetch failed:', sym, err.message);
        });
    }, 2000);
  }

  function renderBondYields(bonds) {
    function setYield(id, val) {
      var el = document.getElementById(id);
      if (!el || val == null) return;
      el.textContent = val.toFixed(2) + '%';
    }
    setYield('us10y-val', bonds.us10y);
    setYield('bund-val',  bonds.bund);
    setYield('gilt-val',  bonds.gilt);
  }

  function init() {
    try {
      // Stale feed caches — cleared each session to force fresh fetch
      ['hermes_live_events','hermes_live_events_ts','argus_gdelt_v1','argus_gdelt_ts_v1'].forEach(function(k) {
        localStorage.removeItem(k);
      });
      // Dead market caches — these keys are no longer written; remove once so stale
      // data never surfaces as a false fallback in ingestCommodities / similar readers
      ['argus_td_v3','argus_eia_v8','argus_fred_v4','argus_av_v6',
       'argus_fh_comm_v1','argus_fh_comm_ts_v1','argus_pg_ex_v1','argus_pg_ex_ts_v1'].forEach(function(k) {
        if (localStorage.getItem(k) !== null) localStorage.removeItem(k);
      });
    } catch(e) {}
    // Stagger market data fetches — avoids parallel fan-out at page load.
    // Each function has its own TTL cache and returns immediately on cache hit;
    // the delay only costs anything on a cold first load or after expiry.
    var _mktFns = [
      fetchMarketData, fetchYFinance, fetchBDI
    ];
    _mktFns.forEach(function(fn, i) {
      setTimeout(fn, i * 600 + Math.floor(Math.random() * 400));
    });
  }

  // ── Baltic Dry Index — Stooq CSV, no key ────────────────────────────────
  function fetchBDI() {
    var CACHE_K = 'argus_bdi_v2';
    var CACHE_T = 'argus_bdi_ts_v2';
    var TTL     = 4 * 60 * 60 * 1000; // 4 hours — BDI updates once daily
    var el      = document.getElementById('bdi-val');

    // Show cached value immediately
    try {
      var cached = localStorage.getItem(CACHE_K);
      var ts     = parseInt(localStorage.getItem(CACHE_T) || '0');
      if (cached && el) {
        el.textContent = cached;
        el.style.color = '#c5d7e8';
      }
      if (cached && Date.now() - ts < TTL) return;
    } catch(e) {}

    var canUseBackend = (
      window.location.hostname.indexOf('netlify') !== -1 ||
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1'
    );

    function applyBDIRows(rows) {
      if (!rows.length) throw new Error('Empty');
      var last   = rows[rows.length - 1].split(',');
      var close  = parseFloat(last[4]);
      var prev   = rows.length > 1 ? parseFloat(rows[rows.length - 2].split(',')[4]) : null;
      if (isNaN(close)) throw new Error('NaN');

      var display = close.toLocaleString('en-US', { maximumFractionDigits: 0 });
      var color   = '#c5d7e8';
      if (prev && !isNaN(prev)) {
        color = close > prev ? '#00ff88' : close < prev ? '#ff0044' : '#c5d7e8';
        var pct = ((close - prev) / prev * 100).toFixed(1);
        display += ' (' + (close > prev ? '+' : '') + pct + '%)';
      }

      if (el) { el.textContent = display; el.style.color = color; }
      try {
        localStorage.setItem(CACHE_K, display);
        localStorage.setItem(CACHE_T, String(Date.now()));
      } catch(e) {}
    }

    if (canUseBackend) {
      fetch('/.netlify/functions/fetch-bdi')
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(res) {
        if (!res || !res.data || !res.data.length) throw new Error('No data from fetch-bdi');
        // res.data = [{date, close}, ...]
        var rows = res.data.map(function(d) { return d.date + ',0,0,0,' + d.close + ',0'; });
        applyBDIRows(rows);
        console.log('BDI via Netlify: close=' + res.data[res.data.length - 1].close);
      })
      .catch(function(e) { console.warn('BDI Netlify fetch failed:', e.message); if (el && el.textContent === 'N/A') el.textContent = '—'; });
    } else {
      fetch('https://corsproxy.io/?url=' + encodeURIComponent('https://stooq.com/q/d/l/?s=bdi&i=d'))
      .then(function(r) { return r.ok ? r.text() : null; })
      .then(function(csv) {
        if (!csv) throw new Error('No data');
        // CSV: Date,Open,High,Low,Close,Volume — take last non-empty row
        var rows = csv.trim().split('\n').filter(function(r) { return r && !r.startsWith('Date'); });
        applyBDIRows(rows);
      })
      .catch(function(e) {
        console.warn('BDI fetch failed:', e.message);
        if (el && el.textContent === 'N/A') el.textContent = '—';
      });
    }
  }


  // ── Netlify market data — EIA + FRED + Stooq indexes server-side ───────────
  function fetchMarketData() {
    var CACHE_K = 'argus_netlify_mkt_v1', CACHE_T = 'argus_netlify_mkt_ts_v1';
    var TTL = 10 * 60 * 1000; // 10 min — matches server-side cache
    try {
      var cached = localStorage.getItem(CACHE_K);
      var ts = parseInt(localStorage.getItem(CACHE_T) || "0");
      if (cached && Date.now() - ts < TTL) { applyMarketPayload(JSON.parse(cached)); return; }
    } catch(e) {}
    // Only call Netlify functions when hosted on Netlify (not GitHub Pages)
    if (window.location.hostname.indexOf('netlify') === -1 && window.location.hostname !== 'localhost') return;
    fetch('/.netlify/functions/fetch-market-data')
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(res) {
      if (!res || !res.data) return;
      try { localStorage.setItem(CACHE_K, JSON.stringify(res.data)); localStorage.setItem(CACHE_T, String(Date.now())); } catch(e) {}
      applyMarketPayload(res.data);
      console.log("Netlify market: source=" + res.source);
    })
    .catch(function(e) { console.warn('fetchMarketData Netlify failed:', e.message); });
  }

  function applyMarketPayload(d) {
    if (window.ArgusDataAge) ArgusDataAge.mark('data-age-market', d.ts);
    if (d.eia) { window._eiaData = Object.assign(window._eiaData || {}, d.eia); renderEIATicker(); }
    if (d.fred) {
      window._fredData = Object.assign(window._fredData || {}, d.fred);
      renderFREDTicker();
      if (d.fred.bonds) {
        renderBondYields(d.fred.bonds);
        // Persist bund/gilt to argus_bonds_v1 so ingestMarkets() + getMarket() readers
        // always have fresh data. us10y is intentionally not overwritten here —
        // applyYFData() keeps it real-time via ^TNX (more current than FRED DGS10).
        try {
          var _bc = JSON.parse(localStorage.getItem('argus_bonds_v1') || '{}');
          if (d.fred.bonds.bund != null) _bc.bund = d.fred.bonds.bund;
          if (d.fred.bonds.gilt != null) _bc.gilt = d.fred.bonds.gilt;
          localStorage.setItem('argus_bonds_v1', JSON.stringify(_bc));
        } catch(_) {}
      }
    }
    if (d.stooq) {
      var MAP = {
        '^ftse': { elId: 'idx-ftse',   chgId: 'idx-ftse-chg',   prefix: '',  dec: 0 },
        '^dax':  { elId: 'idx-dax',    chgId: 'idx-dax-chg',    prefix: '',  dec: 0 },
        '^n225': { elId: 'idx-nikkei', chgId: 'idx-nikkei-chg', prefix: '',  dec: 0 },
        '^hsi':  { elId: 'idx-hsi',    chgId: 'idx-hsi-chg',    prefix: '',  dec: 0 },
        '^vix':  { elId: 'idx-vix',    chgId: null,             prefix: '',  dec: 2 },
        'bdi':   { elId: 'bdi-val',    chgId: null,             prefix: '',  dec: 0 },
      };
      Object.keys(MAP).forEach(function(sym) {
        var s = d.stooq[sym]; if (!s) return;
        var cfg = MAP[sym];
        var el = document.getElementById(cfg.elId); if (!el) return;
        el.textContent = cfg.prefix + s.close.toLocaleString('en-US', { maximumFractionDigits: cfg.dec });
        el.style.color = s.pct > 0 ? '#00ff88' : s.pct < 0 ? '#ff0044' : '#c5d7e8';
        if (cfg.chgId) { var ce = document.getElementById(cfg.chgId); if (ce) { ce.textContent = (s.pct > 0 ? '+' : '') + s.pct.toFixed(2) + '%'; ce.style.color = el.style.color; } }
      });
      console.log("Stooq via Netlify: " + Object.keys(d.stooq).length + " symbols");
    }
  }

  // ── Yahoo Finance via Netlify — real-time quotes (SPY, QQQ, GLD, VIX, TNX…) ─
  // Only fires when hosted on Netlify or localhost. Falls back silently on error.
  function fetchYFinance() {
    var CACHE_K = 'argus_yf_v1', CACHE_T = 'argus_yf_ts_v1', TTL = 10 * 60 * 1000; // 10 min — macro trend
    // Netlify functions only exist on Netlify-hosted deployments, not GitHub Pages.
    // Skip entirely on github.io to avoid a noisy 404 in the console.
    if (window.location.hostname.indexOf('github.io') !== -1) return;

    try {
      var cached = localStorage.getItem(CACHE_K);
      var ts = parseInt(localStorage.getItem(CACHE_T) || '0');
      if (cached && Date.now() - ts < TTL) { applyYFData(JSON.parse(cached)); return; }
    } catch(e) {}

    fetch('/.netlify/functions/fetch-yfinance')
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(res) {
        if (!res || !res.data) { console.warn('fetchYFinance: no data in response', res); return; }
        try {
          localStorage.setItem(CACHE_K, JSON.stringify(res.data));
          localStorage.setItem(CACHE_T, String(Date.now()));
        } catch(e) {}
        applyYFData(res.data, res.ts);
        console.log('YFinance: loaded', Object.keys(res.data).length, 'symbols');
      })
      .catch(function(e) { console.warn('fetchYFinance failed (silent):', e.message); });
  }

  function applyYFData(data, ts) {
    if (window.ArgusDataAge) ArgusDataAge.mark('data-age-market', ts || null);
    function setEl(id, text, color) {
      var el = document.getElementById(id);
      if (!el) return;
      if (text != null) el.textContent = text;
      if (color) el.style.color = color;
    }
    function setChg(id, pct) {
      if (pct == null) return;
      var el = document.getElementById(id);
      if (!el) return;
      el.textContent = (pct > 0 ? '+' : '') + pct.toFixed(2) + '%';
      el.style.color = pct > 0 ? '#00ff88' : pct < 0 ? '#ff0044' : '#c5d7e8';
    }
    function upDown(pct) { return pct > 0 ? '#00ff88' : pct < 0 ? '#ff0044' : '#c5d7e8'; }

    // ── Big Three pinned ticker tape (^GSPC, ^IXIC, ^DJI) ───────────────────
    var BIG3 = {
      '^GSPC': { valId: 'tick-gspc-val', chgId: 'tick-gspc-chg', dec: 0 },
      '^IXIC': { valId: 'tick-ixic-val', chgId: 'tick-ixic-chg', dec: 0 },
      '^DJI':  { valId: 'tick-dji-val',  chgId: 'tick-dji-chg',  dec: 0 },
    };
    Object.keys(BIG3).forEach(function(sym) {
      var q = data[sym]; if (!q || q.price == null) return;
      var cfg = BIG3[sym];
      setEl(cfg.valId, q.price.toLocaleString('en-US', { maximumFractionDigits: cfg.dec }), upDown(q.changePercent));
      setChg(cfg.chgId, q.changePercent);
    });

    // ── US equity benchmark ───────────────────────────────────────────────────
    if (data.SPY && data.SPY.price != null) {
      var spy = data.SPY;
      setEl('spy-val', '$' + spy.price.toFixed(2), (spy.changePercent || 0) >= 0 ? '#00ff88' : '#ff0044');
      setChg('spy-change', spy.changePercent);
      setEl('idx-nyse', spy.price.toLocaleString('en-US', { maximumFractionDigits: 2 }), upDown(spy.changePercent));
      setChg('idx-nyse-chg', spy.changePercent);
      window._avData = window._avData || {};
      window._avData.spy = spy.price;
      window._avData.spyChange = spy.changePercent != null
        ? (spy.changePercent >= 0 ? '+' : '') + spy.changePercent.toFixed(2) + '%' : '';
    }

    // ── Global indexes (real index values, not ETF proxies) ───────────────────
    var IDX_MAP = {
      '^FTSE':  { valId: 'idx-ftse',   chgId: 'idx-ftse-chg',   dec: 0 },
      '^GDAXI': { valId: 'idx-dax',    chgId: 'idx-dax-chg',    dec: 0 },
      '^N225':  { valId: 'idx-nikkei', chgId: 'idx-nikkei-chg', dec: 0 },
      '^HSI':   { valId: 'idx-hsi',    chgId: 'idx-hsi-chg',    dec: 0 },
    };
    Object.keys(IDX_MAP).forEach(function(sym) {
      var q = data[sym]; if (!q || q.price == null) return;
      var cfg = IDX_MAP[sym];
      setEl(cfg.valId, q.price.toLocaleString('en-US', { maximumFractionDigits: cfg.dec }), upDown(q.changePercent));
      setChg(cfg.chgId, q.changePercent);
    });

    // ── Saudi/Gulf index (KSA ETF) ────────────────────────────────────────────
    if (data.KSA && data.KSA.price != null) {
      setEl('idx-ksa', data.KSA.price.toFixed(2), upDown(data.KSA.changePercent));
      setChg('idx-ksa-chg', data.KSA.changePercent);
    }

    // ── VIX (color-coded by level) ────────────────────────────────────────────
    if (data['^VIX'] && data['^VIX'].price != null) {
      var vix = data['^VIX'].price;
      setEl('idx-vix', vix.toFixed(2),
        vix > 30 ? '#ff0044' : vix > 20 ? '#ff9933' : vix > 15 ? '#ffcc00' : '#00ff88');
    }

    // ── FX rates ──────────────────────────────────────────────────────────────
    // Yahoo EURUSD=X → 1 EUR in USD (e.g. 1.0847), GBPUSD=X → 1 GBP in USD,
    // JPY=X → USD/JPY (JPY per 1 USD, e.g. 149.5)
    var FX_MAP = {
      'EURUSD=X': { id: 'fx-eurusd', dec: 4, avKey: 'fx-eurusd' },
      'GBPUSD=X': { id: 'fx-gbpusd', dec: 4, avKey: 'fx-gbpusd' },
      'JPY=X':    { id: 'fx-usdjpy', dec: 2, avKey: 'fx-usdjpy' },
    };
    Object.keys(FX_MAP).forEach(function(sym) {
      var q = data[sym]; if (!q || q.price == null) return;
      var cfg = FX_MAP[sym];
      setEl(cfg.id, q.price.toFixed(cfg.dec));
      // Propagate to _avData so buildSnapshot / Neural Case Builder see updated values
      window._avData = window._avData || {};
      window._avData[cfg.avKey] = q.price;
    });

    // ── Bond yields ───────────────────────────────────────────────────────────
    if (data['^TNX'] && data['^TNX'].price != null) {
      var tnx = data['^TNX'].price;
      setEl('us10y-val', tnx.toFixed(2) + '%');
      // Sync into bond cache so buildSnapshot reads intraday yield
      try {
        var bc = JSON.parse(localStorage.getItem('argus_bonds_v1') || '{}');
        bc.us10y = tnx;
        localStorage.setItem('argus_bonds_v1', JSON.stringify(bc));
      } catch(e) {}
    }

    // ── USD Dollar Index ──────────────────────────────────────────────────────
    if (data['USDX'] && data['USDX'].price != null) {
      setEl('usd-val', data['USDX'].price.toFixed(2));
    }

    // ── Commodities ───────────────────────────────────────────────────────────
    if (data.GLD && data.GLD.price != null) {
      setEl('gold-val', '$' + data.GLD.price.toFixed(2));
      setChg('gold-chg', data.GLD.changePercent);
    }
    if (data['SI=F'] && data['SI=F'].price != null) {
      setEl('silver-val', '$' + data['SI=F'].price.toFixed(2));
      setChg('silver-chg', data['SI=F'].changePercent);
    }
    if (data['HG=F'] && data['HG=F'].price != null) {
      setEl('copper-val', '$' + data['HG=F'].price.toFixed(3));
      setChg('copper-chg', data['HG=F'].changePercent);
    }
    if (data['ZW=F'] && data['ZW=F'].price != null) {
      setEl('wheat-val', '$' + data['ZW=F'].price.toFixed(2));
      setChg('wheat-chg', data['ZW=F'].changePercent);
    }
    // Crude — fill as YF fallback; EIA/TD values override if loaded after
    if (data['BZ=F'] && data['BZ=F'].price != null) {
      var brent = data['BZ=F'].price;
      setEl('brent-val', '$' + brent.toFixed(2));
      window._eiaData = window._eiaData || {};
      if (!window._eiaData.brent) { window._eiaData.brent = brent; window._eiaData.brentDate = new Date().toISOString().slice(0,10); }
    }
    if (data['CL=F'] && data['CL=F'].price != null) {
      var wti = data['CL=F'].price;
      setEl('wti-val', '$' + wti.toFixed(2));
      window._eiaData = window._eiaData || {};
      if (!window._eiaData.wti) { window._eiaData.wti = wti; window._eiaData.wtiDate = new Date().toISOString().slice(0,10); }
    }
    if (data['BZ=F'] || data['CL=F']) { if (typeof updateBrentWTISpread === 'function') updateBrentWTISpread(); }

    // ── Crypto ────────────────────────────────────────────────────────────────
    if (data['BTC-USD'] && data['BTC-USD'].price != null) {
      setEl('btc-val', '$' + Math.round(data['BTC-USD'].price).toLocaleString('en-US'));
      setChg('btc-chg', data['BTC-USD'].changePercent);
    }
    if (data['ETH-USD'] && data['ETH-USD'].price != null) {
      setEl('eth-val', '$' + Math.round(data['ETH-USD'].price).toLocaleString('en-US'));
      setChg('eth-chg', data['ETH-USD'].changePercent);
    }

    // QQQ and ^TYX are fetched + cached; no dedicated DOM element in current UI
  }

  return { init: init, buildSnapshot: buildSnapshot, downloadSnapshot: downloadSnapshot, toggleExchanges: toggleExchanges, selectExchange: selectExchange };

})(); // end ArgusData

// ════════════════════════════════════════════════════════════════════════════
// ArgusMarket — Market Intelligence Engine
// Deep-dive ticker search via /.netlify/functions/fetch-yfinance?search=SYM
// ════════════════════════════════════════════════════════════════════════════
var ArgusMarket = (function() {

  // ── Helpers ────────────────────────────────────────────────────────────────
  function fmt(n, dec, prefix) {
    if (n == null || isNaN(n)) return '—';
    var s = n.toLocaleString('en-US', { minimumFractionDigits: dec || 0, maximumFractionDigits: dec || 0 });
    return (prefix || '') + s;
  }
  function fmtPct(n) {
    if (n == null || isNaN(n)) return '—';
    return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtBig(n) {
    if (n == null || isNaN(n)) return '—';
    if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
    if (n >= 1e9)  return '$' + (n / 1e9).toFixed(2)  + 'B';
    if (n >= 1e6)  return '$' + (n / 1e6).toFixed(2)  + 'M';
    return '$' + n.toFixed(0);
  }
  function pctColor(n) { return n == null ? '#c5d7e8' : n > 0 ? '#00ff88' : n < 0 ? '#ff0044' : '#c5d7e8'; }

  var _lastResult = null;

  // ── Fetch deep-dive from backend ──────────────────────────────────────────
  function search(rawTicker) {
    var sym = (rawTicker || '').trim().toUpperCase().replace(/^\$/, '');
    if (!sym) return;

    var deep = document.getElementById('mkt-deep-dive');
    if (!deep) return;

    // Not available on GitHub Pages — Netlify functions only exist on Netlify deployments
    if (window.location.hostname.indexOf('github.io') !== -1) {
      deep.innerHTML = '<div class="mkt-card__empty">MARKET INTELLIGENCE UNAVAILABLE<br><span style="font-size:6px;color:#1a3050">Live queries require Netlify deployment</span></div>';
      return;
    }

    // Search cache — 24h TTL per ticker (cold storage: company profiles change at most daily)
    var SEARCH_TTL  = 24 * 60 * 60 * 1000;
    var sCacheKey   = 'argus_yf_srch_' + sym;
    var sCacheTsKey = 'argus_yf_srch_ts_' + sym;
    try {
      var sCached = localStorage.getItem(sCacheKey);
      var sCacheTs = parseInt(localStorage.getItem(sCacheTsKey) || '0');
      if (sCached && Date.now() - sCacheTs < SEARCH_TTL) {
        var d = JSON.parse(sCached);
        _lastResult = d;
        deep.innerHTML = renderCard(d);
        var btn = deep.querySelector('.mkt-brief-btn');
        if (btn) btn.addEventListener('click', function() { sendToBriefing(d); });
        return;
      }
    } catch(e) {}

    // Loading state
    deep.innerHTML = '<div class="mkt-card__empty mkt-loading">QUERYING ' + sym + '…</div>';

    fetch('/.netlify/functions/fetch-yfinance?search=' + encodeURIComponent(sym))
      .then(function(r) { return r.json(); })
      .then(function(res) {
        if (!res.search) {
          deep.innerHTML = '<div class="mkt-card__empty">TICKER NOT FOUND: ' + sym + '</div>';
          return;
        }
        try {
          localStorage.setItem(sCacheKey, JSON.stringify(res.search));
          localStorage.setItem(sCacheTsKey, String(Date.now()));
        } catch(e) {}
        _lastResult = res.search;
        deep.innerHTML = renderCard(res.search);
        // Wire briefing button
        var btn = deep.querySelector('.mkt-brief-btn');
        if (btn) btn.addEventListener('click', function() { sendToBriefing(res.search); });
      })
      .catch(function(e) {
        deep.innerHTML = '<div class="mkt-card__empty">ERROR: ' + e.message + '</div>';
      });
  }

  // ── Render deep-dive card ─────────────────────────────────────────────────
  function renderCard(d) {
    var chgColor = pctColor(d.changePercent);
    var typeLabel = d.quoteType || 'EQUITY';

    // Country flag emoji
    var FLAG_MAP = {
      'United States': '🇺🇸', 'United Kingdom': '🇬🇧', 'China': '🇨🇳',
      'Japan': '🇯🇵', 'Germany': '🇩🇪', 'France': '🇫🇷', 'Canada': '🇨🇦',
      'Australia': '🇦🇺', 'South Korea': '🇰🇷', 'India': '🇮🇳',
      'Brazil': '🇧🇷', 'Singapore': '🇸🇬', 'Netherlands': '🇳🇱',
      'Switzerland': '🇨🇭', 'Taiwan': '🇹🇼', 'Hong Kong': '🇭🇰',
      'Israel': '🇮🇱', 'Saudi Arabia': '🇸🇦', 'Ireland': '🇮🇪',
      'Sweden': '🇸🇪', 'Norway': '🇳🇴', 'Denmark': '🇩🇰',
    };
    var flag = d.country ? (FLAG_MAP[d.country] || '') : '';

    // Technical: 50DMA / 200DMA deviation
    var ma50txt = '—', ma200txt = '—';
    if (d.price && d.fiftyDayAverage) {
      var dev50 = ((d.price - d.fiftyDayAverage) / d.fiftyDayAverage * 100);
      ma50txt = fmt(d.fiftyDayAverage, 2) + ' <span style="color:' + pctColor(dev50) + '">(' + (dev50 >= 0 ? '+' : '') + dev50.toFixed(1) + '%)</span>';
    }
    if (d.price && d.twoHundredDayAverage) {
      var dev200 = ((d.price - d.twoHundredDayAverage) / d.twoHundredDayAverage * 100);
      ma200txt = fmt(d.twoHundredDayAverage, 2) + ' <span style="color:' + pctColor(dev200) + '">(' + (dev200 >= 0 ? '+' : '') + dev200.toFixed(1) + '%)</span>';
    }

    var cells = [
      { lbl: 'Market Cap',   val: fmtBig(d.marketCap) },
      { lbl: 'P/E (TTM)',    val: d.trailingPE  != null ? d.trailingPE.toFixed(2)  : '—' },
      { lbl: 'P/E (Fwd)',    val: d.forwardPE   != null ? d.forwardPE.toFixed(2)   : '—' },
      { lbl: 'EPS (TTM)',    val: d.trailingEps != null ? '$' + d.trailingEps.toFixed(2) : '—' },
      { lbl: 'Volume',       val: d.volume      != null ? Math.round(d.volume).toLocaleString('en-US') : '—' },
      { lbl: 'Avg Volume',   val: d.averageVolume != null ? Math.round(d.averageVolume).toLocaleString('en-US') : '—' },
    ];

    var gridHTML = cells.map(function(c) {
      return '<div class="mkt-card__cell"><div class="mkt-card__cell-lbl">' + c.lbl + '</div><div class="mkt-card__cell-val">' + c.val + '</div></div>';
    }).join('');

    var sectorLine = [d.sector, d.industry].filter(Boolean).join(' · ');
    var countryLine = [flag, d.country].filter(Boolean).join(' ');

    return [
      '<div class="mkt-card">',
      '  <div class="mkt-card__hdr">',
      '    <div>',
      '      <div class="mkt-card__ticker">' + d.symbol + ' <span class="mkt-card__badge">' + typeLabel + '</span></div>',
      '      <div class="mkt-card__cname">' + (d.name || d.symbol) + '</div>',
      '      ' + (sectorLine  ? '<div class="mkt-card__meta">' + sectorLine  + '</div>' : ''),
      '      ' + (countryLine ? '<div class="mkt-card__meta">' + countryLine + '</div>' : ''),
      '    </div>',
      '    <div class="mkt-card__price-block">',
      '      <div class="mkt-card__price" style="color:' + chgColor + '">' + fmt(d.price, 2, (d.currency === 'USD' ? '$' : '')) + '</div>',
      '      <div class="mkt-card__chg"  style="color:' + chgColor + '">' + fmtPct(d.changePercent) + '</div>',
      '    </div>',
      '  </div>',
      '  <div class="mkt-card__tech">',
      '    <div class="mkt-card__ma"><span class="mkt-card__ma-lbl">50 DMA</span> <span>' + ma50txt + '</span></div>',
      '    <div class="mkt-card__ma"><span class="mkt-card__ma-lbl">200 DMA</span><span>' + ma200txt + '</span></div>',
      '  </div>',
      '  <div class="mkt-card__grid">' + gridHTML + '</div>',
      '  <div class="mkt-card__acts">',
      '    <button class="mkt-brief-btn">SEND TO BRIEFING</button>',
      '    <span class="mkt-card__employees">' + (d.fullTimeEmployees != null ? d.fullTimeEmployees.toLocaleString('en-US') + ' employees' : '') + '</span>',
      '  </div>',
      '</div>',
    ].join('\n');
  }

  // ── Send deep-dive data to Case Builder ───────────────────────────────────
  function sendToBriefing(d) {
    var lines = [
      '## Market Intelligence Brief: ' + d.symbol,
      '',
      '**' + (d.name || d.symbol) + '**' + (d.country ? '  ·  ' + d.country : ''),
      (d.sector ? 'Sector: ' + d.sector : '') + (d.industry ? '  |  Industry: ' + d.industry : ''),
      '',
      '### Price & Performance',
      '- Price: ' + fmt(d.price, 2, '$') + '  |  Change: ' + fmtPct(d.changePercent),
      '- 50-Day MA: ' + fmt(d.fiftyDayAverage, 2, '$') + '  |  200-Day MA: ' + fmt(d.twoHundredDayAverage, 2, '$'),
      '',
      '### Fundamentals',
      '- Market Cap: ' + fmtBig(d.marketCap),
      '- P/E (TTM): ' + (d.trailingPE != null ? d.trailingPE.toFixed(2) : '—') + '  |  P/E (Fwd): ' + (d.forwardPE != null ? d.forwardPE.toFixed(2) : '—'),
      '- EPS (TTM): ' + (d.trailingEps != null ? '$' + d.trailingEps.toFixed(2) : '—'),
      '- Volume: ' + (d.volume != null ? Math.round(d.volume).toLocaleString() : '—') + '  |  Avg Volume: ' + (d.averageVolume != null ? Math.round(d.averageVolume).toLocaleString() : '—'),
    ].join('\n');

    // Switch to Case Builder tab and inject
    var tab = document.querySelector('[data-tab="case"]');
    if (tab) tab.click();
    setTimeout(function() {
      var ta = document.getElementById('case-input');
      if (!ta) return;
      ta.value = (ta.value ? ta.value + '\n\n' : '') + lines;
      ta.dispatchEvent(new Event('input'));
    }, 150);
  }

  // ── Wire search bar ───────────────────────────────────────────────────────
  function wireSearchBar() {
    var inp = document.getElementById('mkt-search-input');
    var btn = document.getElementById('mkt-search-btn');
    if (!inp || !btn) return;

    btn.addEventListener('click', function() { search(inp.value); });
    inp.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') search(inp.value);
    });
  }

  // ── Neural Web $TICKER detection ──────────────────────────────────────────
  function wireNeuralWeb() {
    // Listen for clicks on Neural Web nodes that contain $TICKER pattern
    document.addEventListener('click', function(e) {
      var el = e.target.closest('.nw-node');
      if (!el) return;
      var label = el.dataset.label || el.textContent || '';
      var m = label.match(/\$([A-Z\^][A-Z0-9\-\.\^]{0,9})/);
      if (!m) return;
      // Switch to market tab and trigger search
      var mktTab = document.querySelector('[data-tab="market"]');
      if (mktTab) mktTab.click();
      setTimeout(function() {
        var inp = document.getElementById('mkt-search-input');
        if (inp) inp.value = m[1];
        search(m[1]);
      }, 200);
    });
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    wireSearchBar();
    wireNeuralWeb();
  }

  return { init: init, search: search };

})(); // end ArgusMarket

// ════════════════════════════════════════════════════════════════════════════
// Event Feed — NewsData.io headlines → Claude structuring → live event cards
// ════════════════════════════════════════════════════════════════════════════
var FEED_CACHE_KEY = 'argus_live_events_v2';
var FEED_CACHE_TS  = 'argus_live_events_ts_v2';
var FEED_TTL       = 30 * 60 * 1000;

// ── Claude AI classification layer ───────────────────────────────────────────
// Calls are proxied through /.netlify/functions/ai-classify — the Anthropic API
// key NEVER touches the browser. Rate limiting and daily caps are enforced
// server-side in the Netlify function and backed by Supabase.
//
// _AI_DAILY_CAP here is a client-side pre-flight check that avoids a round-trip
// when the user has clearly exhausted their local allowance. The server enforces
// the real global cap (300 batches/day) independently.
var _AI_CLASSIFY_FN    = '/.netlify/functions/ai-classify';
var _AI_CLASS_CACHE_KEY = 'argus_ai_class_v1';
var _AI_CLASS_CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours
var _AI_DAILY_KEY = 'argus_ai_daily_v1';
var _AI_DAILY_CAP = 10;  // client-side pre-flight: 10 batches/session (server cap is authoritative)
// Max entries kept in the AI classification cache bucket.
// Oldest entries are pruned when this is exceeded to prevent unbounded growth.
var _AI_BUCKET_MAX = 500;

var FALLBACK_EVENTS = [
  { id:1, type:'CONFLICT',  severity:'CRITICAL', title:'Red Sea — Houthi Maritime Attacks',     impact:'Suez diversions up 400%. ~$1B/day trade disruption. 60% of container traffic rerouted.' },
  { id:2, type:'POLICY',    severity:'WARNING',  title:'US-China Tariff Escalation Phase 2',    impact:'Electronics, EVs, semiconductors facing 25–60% new duties. $380B in affected trade.' },
  { id:3, type:'DISASTER',  severity:'WATCH',    title:'Panama Canal — Drought Level 3',        impact:'Daily transits down 30%. Average wait times +18 days. $14B weekly trade impact.' },
  { id:4, type:'CONFLICT',  severity:'WARNING',  title:'Russia-Ukraine — Black Sea Corridor',   impact:'Ukrainian grain exports down 60%. 12 nations facing food insecurity risk elevation.' },
  { id:5, type:'DISASTER',  severity:'WATCH',    title:'Taiwan Strait — PLA Exercise Activity', impact:'Semiconductor contingency plans at Tier 2. Insurance premiums up 340%.' },
  { id:6, type:'POLICY',    severity:'WATCH',    title:'EU Carbon Border Adjustment (CBAM)',    impact:'Steel, aluminum, cement imports to EU face carbon tariffs from Jan 2026.' },
];

// ── Humanitarian tone classifier — runs on existing text, zero extra API calls ──
var HC_CATEGORIES = {
  CONFLICT:       { w: 40, kw: ['airstrike','bombing','missile','armed clash','insurgency','terrorist','civilian casualties','killed','troops','offensive','shelling','massacre','genocide','ethnic cleansing','war crimes','atrocity','atrocities','mass graves','chemical attack','war','combat','gunfire','explosion','artillery','drone strike','ambush','siege','naval blockade','occupation'] },
  HUMANITARIAN:   { w: 35, kw: ['famine','starvation','displacement','refugees','aid blocked','mass casualties','cholera','malnutrition','food insecurity','civilians trapped','mass exodus','displaced','aid workers killed','humanitarian','epidemic','outbreak','flooding','earthquake','tsunami','wildfire'] },
  HUMAN_RIGHTS:   { w: 30, kw: ['ethnic cleansing','war crimes','mass detention','crackdown','political prisoners','torture','disappearances','execution','persecution','arbitrary arrest','censorship','suppression','extrajudicial','protesters killed','journalists detained','atrocities'] },
  SUPPLY_CHAIN:   { w: 28, kw: ['port closure','shipping disruption','trade route','chokepoint','canal blocked','strait','supply chain','logistics breakdown','cargo','container','freight','export ban','import restriction','supply shortage','critical minerals','semiconductor','chip shortage'] },
  ECONOMIC:       { w: 25, kw: ['sanctions','tariff','embargo','currency collapse','debt default','inflation surge','recession','bank failure','financial crisis','oil price','energy crisis','food prices','commodity','market crash','capital flight','trade war','gdp contraction'] },
  INSTABILITY:    { w: 20, kw: ['coup','military takeover','government collapse','emergency rule','violent protests','martial law','state of emergency','uprising','civil unrest','riot','mutiny','political crisis','parliament dissolved','power vacuum','election fraud','mass protests'] },
  TENSION:        { w: 10, kw: ['tensions rising','border dispute','diplomatic row','military exercises','mobilization','ultimatum','protests','demonstration','standoff','expulsion','recalled ambassador','navy patrol','military buildup'] },
};
var HC_TRIGGERS = ['mass displacement','famine declared','ethnic cleansing','hundreds killed','thousands killed','aid blocked','refugee crisis','genocide','chemical attack','mass graves','hospital bombed','children killed','starvation','port closed','supply chain collapse','debt default','bank run'];

function hcClassify(title, description) {
  var text   = ((title || '') + ' ' + (description || '')).toLowerCase();
  var score  = 0;
  var hits   = [];
  var type   = 'POLICY';
  var topW   = 0;

  Object.keys(HC_CATEGORIES).forEach(function(cat) {
    var def     = HC_CATEGORIES[cat];
    var matched = def.kw.filter(function(k) { return text.indexOf(k) !== -1; });
    if (matched.length) {
      score += def.w + Math.min((matched.length - 1) * 5, 20);
      hits   = hits.concat(matched.slice(0, 2));
      if (def.w > topW) { topW = def.w; type = cat; }
    }
  });

  score = Math.min(score, 100);
  var triggers = HC_TRIGGERS.filter(function(t) { return text.indexOf(t) !== -1; });
  if (triggers.length) score = Math.max(score, 50);
  // Genocide/ethnic cleansing are always CONFLICT regardless of default
  if (/genocide|ethnic.cleansing|war.crime|atrocit|mass.grave/.test(text) && type === 'POLICY') { type = 'CONFLICT'; }

  var risk = score >= 80 ? 'CRITICAL' : score >= 50 ? 'WARNING' : score >= 25 ? 'WATCH' : 'LOW';
  var col  = { CRITICAL:'#ff0044', WARNING:'#ff9933', WATCH:'#ffcc00', LOW:'#00ff88' }[risk];
  return { risk: risk, score: score, col: col, type: type, hits: hits.slice(0,3) };
}

function hcBadge(title, description) {
  var r = hcClassify(title, description);
  if (r.score < 10) return ''; // skip entirely for generic low-signal articles
  var tip = r.type.replace('_',' ') + ' · ' + r.score + '/100' + (r.hits.length ? ' · ' + r.hits.join(', ') : '');
  return '<span title="' + tip + '" style="display:inline-flex;align-items:center;gap:4px;margin-top:5px;' +
    'font-size:7px;letter-spacing:1.5px;font-weight:700;color:' + r.col + ';' +
    'border:1px solid ' + r.col + '44;border-radius:2px;padding:2px 6px;cursor:default">' +
    '◈ ' + r.risk + ' · ' + r.score + '</span>';
}

// ── Dwell time utility — pure function, no mutations, no timers ───────────────
function dwellTime(ev) {
  // Try raw timestamp first, then parse pubDate string
  var ms = null;
  if (ev.time && !isNaN(Number(ev.time)))          ms = Number(ev.time);
  else if (ev.pubDate && ev.pubDate.length > 5) {
    // pubDate formats: "14 MAR 2025 · 08:32 UTC" or "3/14/2025" or ISO
    var cleaned = ev.pubDate.replace(' · ', ' ').replace(' UTC', '');
    var parsed  = Date.parse(cleaned);
    if (!isNaN(parsed)) ms = parsed;
  }
  if (!ms) return '<span class="dwell-time">—</span>';
  var diff  = Date.now() - ms;
  if (diff < 0) return '<span class="dwell-time">—</span>';
  var hours = Math.floor(diff / 3600000);
  var days  = Math.floor(diff / 86400000);
  var label = days >= 1 ? days + 'd active' : hours + 'h active';
  var col   = days >= 7 ? '#ff9933' : days >= 3 ? '#ffcc00' : '#3a6a8a';
  return '<span class="dwell-time" style="color:' + col + '">' + label + '</span>';
}

// ── Severity trend arrow — compares current severity against cached previous ──
// Pure function, no mutations, no timers. Cache key based on event title slug.
function severityTrend(ev) {
  if (!ev.title) return '';
  var slug    = 'argus_sev_' + ev.title.toLowerCase().replace(/\W+/g,'_').slice(0,40);
  var SEV_NUM = { LOW: 1, WATCH: 2, WARNING: 3, CRITICAL: 4 };
  var cur     = SEV_NUM[ev.severity] || 0;
  var prev    = 0;
  try { prev = parseInt(localStorage.getItem(slug) || '0'); } catch(e) {}
  // Store current for next render
  try { localStorage.setItem(slug, String(cur)); } catch(e) {}
  if (!prev || prev === cur) return '';
  if (cur > prev) return '<span title="Escalating" style="font-size:9px;color:#ff4422;margin-left:4px;">↑</span>';
  return '<span title="De-escalating" style="font-size:9px;color:#00cc66;margin-left:4px;">↓</span>';
}
window.severityTrend = severityTrend;
window.commodityTags = commodityTags;

// ── Commodity exposure tags — derived from title/impact keywords, no new API ──
var COMMODITY_MAP = [
  { tag: 'OIL',           re: /oil|crude|brent|wti|opec|petroleum|barrel|refin/i },
  { tag: 'GAS',           re: /\bgas\b|lng|natural gas|pipeline|gazprom/i },
  { tag: 'WHEAT',         re: /wheat|grain|cereal|bread|flour|harvest|crop/i },
  { tag: 'SEMICONDUCTORS',re: /semiconductor|chip|microchip|tsmc|nvidia|wafer|fab/i },
  { tag: 'RARE EARTH',    re: /rare earth|lithium|cobalt|nickel|copper|mineral/i },
  { tag: 'SHIPPING',      re: /shipping|freight|vessel|container|port|tanker|cargo/i },
  { tag: 'FOOD',          re: /food|famine|hunger|starvation|fertilizer|agriculture/i },
  { tag: 'SANCTIONS',     re: /sanction|embargo|export ban|restriction|blacklist/i },
];

function commodityTags(ev) {
  var text = ((ev.title || '') + ' ' + (ev.impact || '')).toLowerCase();
  var hits = COMMODITY_MAP.filter(function(c) { return c.re.test(text); });
  if (!hits.length) return '';
  return '<div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:5px;">' +
    hits.map(function(c) {
      return '<span style="font-size:7px;letter-spacing:1px;padding:1px 5px;' +
        'background:rgba(0,170,255,0.08);border:1px solid #0f2d48;color:#3a6a8a;">' +
        c.tag + '</span>';
    }).join('') +
  '</div>';
}

function renderEvents(events, isLive) {
  if (window.ArgusDataAge) ArgusDataAge.mark('data-age-events');
  var evList = document.getElementById('ev-list');
  if (!evList) return;
  evList.innerHTML = '';
  if (isLive) {
    var badge = document.createElement('div');
    badge.style.cssText = 'font-size:8px;letter-spacing:2px;color:#00ff88;margin-bottom:8px;display:flex;align-items:center;gap:6px';
    badge.innerHTML = '<span style="width:6px;height:6px;border-radius:50%;background:#00ff88;display:inline-block;box-shadow:0 0 6px #00ff88"></span>LIVE FEED — ' + new Date().toUTCString().slice(0, 16).toUpperCase();
    evList.appendChild(badge);
  }
  events.forEach(function(ev, idx) {
    var col = RC[ev.severity] || '#0099ff';
    var bg  = RB[ev.severity] || 'transparent';
    var div = document.createElement('div');
    div.className = 'event-card';
    div.style.cssText = 'border-left-color:' + col + ';border-color:' + col + '44;background:' + bg +
      ';--card-i:' + idx;
    div.innerHTML =
      '<div class="event-card__row">' +
        '<span class="event-card__type" style="color:' + col + '">' + ev.type + '</span>' +
        '<span class="event-card__type" style="color:' + col + '">' + ev.severity + severityTrend(ev) + '</span>' +
      '</div>' +
      '<div class="event-card__title">' + ev.title + '</div>' +
      '<div class="event-card__meta" style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-top:4px;margin-bottom:2px">' +
        (ev.region ? '<span id="ev-loc-' + ev.id + '" style="font-size:8px;letter-spacing:1px;color:#00ccff">◈ ' + ev.region +
          (function() {
            // Try in-memory lat/lon first, then localStorage cache
            var lat = ev.lat, lon = ev.lon;
            if ((!lat || !lon) && ev.regionRaw) {
              var gk = 'argus_geo_' + ev.regionRaw.toLowerCase().replace(/\s+/g,'_').slice(0,30);
              try { var gc = JSON.parse(localStorage.getItem(gk) || 'null'); if (gc) { lat = gc.lat; lon = gc.lon; } } catch(e) {}
            }
            return lat ? ' <span style="color:#2a5a7a">' + lat.toFixed(2) + '\u00b0, ' + lon.toFixed(2) + '\u00b0</span>' : '';
          })() +
        '</span>' : '') +
        (ev.pubDate ? '<span style="font-size:8px;letter-spacing:1px;color:#4a7da8;margin-left:auto">' + ev.pubDate + '</span>' : '') +
        dwellTime(ev) +
      '</div>' +
      '<div class="event-card__detail">' + ev.impact +
        hcBadge(ev.title, ev.impact) +
        commodityTags(ev) +
        (ev.source ? '<span style="display:block;margin-top:4px;font-size:8px;letter-spacing:1px;color:#4a6080;text-transform:uppercase">' + ev.source +
          (function() { var t = getSourceTierLabel(ev.source); return t ? ' <span style="font-size:7px;letter-spacing:1px;padding:1px 4px;border:1px solid ' + t.color + '44;color:' + t.color + ';margin-left:4px;">' + t.label + '</span>' : ''; })() +
        '</span>' : '') +
        (ev.link   ? '<a href="' + ev.link + '" target="_blank" rel="noopener" onclick="event.stopPropagation()" ' +
          'style="display:block;margin-top:5px;color:#0099ff;font-size:8px;letter-spacing:1px;text-decoration:underline;word-break:break-all">↗ SOURCE</a>' : '') +
      '</div>';
    div.addEventListener('click', function() { div.classList.toggle('is-open'); });
    evList.appendChild(div);
  });
  window.updateNodeCounts();
  document.getElementById('ev-feed-count').textContent = window.eventMarkers.filter(function(m) { return !m.userData.isAircraft && !m.userData.isShip; }).length;
}
// Wrap renderEvents to cache the current event list for cross-module access
window.renderEvents = function(events, isLive) {
  window._currentEvents = events;
  renderEvents(events, isLive);
};
window.hcBadge = hcBadge;

function showLoadingState() {
  var evList = document.getElementById('ev-list');
  if (!evList) return;
  evList.innerHTML = '';
  for (var i = 0; i < 5; i++) {
    var div = document.createElement('div');
    div.style.cssText = 'margin-bottom:8px;padding:10px 11px;background:rgba(5,15,30,0.4);border-left:2px solid #0f2744;border-radius:1px';
    div.innerHTML =
      '<div style="width:60%;height:8px;background:#0f2744;border-radius:2px;margin-bottom:7px;animation:pulse 1.5s ease-in-out infinite"></div>' +
      '<div style="width:90%;height:10px;background:#0a2030;border-radius:2px;animation:pulse 1.5s ease-in-out infinite .2s"></div>';
    evList.appendChild(div);
  }
}

// ── Relevance filter — humanitarian risk first, then economics ───────────────
// Humanitarian (higher weight): conflict, casualties, displacement, disaster
// Economic (lower weight): trade, energy, market disruption
var RELEVANT_TAGS = /conflict|war|military|attack|casualties|killed|wounded|displacement|refugee|famine|humanitarian|massacre|airstrike|bombing|terror|coup|geopolit|sanction|tariff|trade|oil|gas|energy|inflation|recession|economy|market|supply.chain|shipping|logistics|disaster|cyber|embargo/i;

// ── Type classifier — count-based, most-hits-wins, first-keyword tie-break ───
// Each keyword belongs to exactly ONE category. No cross-category overlaps.
var TYPE_KEYWORDS = {
  CONFLICT: [
    'attack','militia','houthi','strike','bomb','missile','shoot','troops',
    'war','military','weapon','armed','kill','coup','terror','casualties',
    'airstrike','shelling','massacre','genocide','ethnic cleansing','atrocity',
    'war crime','offensive','siege','conflict','civilian'
  ],
  CYBER: [
    'hack','cyber','ransomware','breach','malware','phishing','ddos'
  ],
  DISASTER: [
    'flood','earthquake','quake','hurricane','typhoon','drought','wildfire',
    'tsunami','disaster','eruption','famine','epidemic','outbreak'
  ],
  ECONOMIC: [
    'inflation','recession','gdp','interest rate','debt','default','unemployment','crash'
  ],
  POLICY: [
    'sanction','tariff','embargo','ban','regulation','treaty','accord','summit',
    'diplomacy','policy','trade','economic','economy','market','fuel','shortage',
    'deficit','boom','technology','science','foundation','non-profit',
    'demand','supply','surplus'
  ]
};

var _TYPE_CATS = ['CONFLICT','CYBER','DISASTER','ECONOMIC','POLICY'];

function classifyType(text) {
  var low = (text || '').toLowerCase();
  // Hard kinetic override — always wins before counting
  if (KINETIC_OVERRIDE_RE.test(low)) return 'CONFLICT';
  var counts = { CONFLICT: 0, CYBER: 0, DISASTER: 0, ECONOMIC: 0, POLICY: 0 };
  var firstCat = null, firstPos = Infinity;
  for (var c = 0; c < _TYPE_CATS.length; c++) {
    var cat = _TYPE_CATS[c];
    var kws = TYPE_KEYWORDS[cat];
    for (var k = 0; k < kws.length; k++) {
      var pos = low.indexOf(kws[k]);
      if (pos !== -1) {
        counts[cat]++;
        if (pos < firstPos) { firstPos = pos; firstCat = cat; }
      }
    }
  }
  // Most-hits wins; on tie use first keyword found
  var best = null, bestCount = 0, tied = false;
  for (var i = 0; i < _TYPE_CATS.length; i++) {
    if (counts[_TYPE_CATS[i]] > bestCount) {
      bestCount = counts[_TYPE_CATS[i]]; best = _TYPE_CATS[i]; tied = false;
    } else if (counts[_TYPE_CATS[i]] === bestCount && bestCount > 0) {
      tied = true;
    }
  }
  if (!tied && best) return best;
  return firstCat || 'POLICY';
}
window.argusClassifyType = classifyType;

// ═══════════════════════════════════════════════════════════════════════════════
// MULTI-FACTOR RISK SCORING ENGINE v2
// risk_score = severity(0-3) + certainty(0-2) + immediacy(0-2) + scope(0-3) + contextBoost(0-2)
// Thresholds: >=9 CRITICAL | >=6 WARNING | >=2 WATCH | else LOW
// Hard rules:  confirmed kinetic/closure events → floor at WARNING (score 6)
//              only speculative language + low severity → cap at WATCH (score <6)
// ═══════════════════════════════════════════════════════════════════════════════

// ── Severity dimension keywords (highest severity wins) ───────────────────────
var _SEV3_KW = [
  // Kinetic / catastrophic
  'massacre','genocide','declared war','nuclear strike','nuclear weapon','chemical weapon',
  'biological weapon','nerve agent','mass casualties','mass casualty',
  'hundreds killed','thousands killed','civilian deaths','airstrike kills',
  'bombed hospital','hospital bombed','children killed','school bombed',
  'famine declared','famine spreading','epidemic declared','pandemic declared',
  'full blockade','total blockade','naval blockade','blockade imposed',
  'coup successful','coup completed','government overthrown','capital seized',
  'catastrophic','annihilate','annihilated',
];
var _SEV2_KW = [
  // Active attacks / confirmed military
  'airstrike','air raid','missile strike','drone strike','bombing raid',
  'shelling','mortar fire','artillery barrage','gunfire','armed assault',
  'offensive launched','military operation launched','attack launched',
  'under attack','troops advancing','invasion','incursion','ground offensive',
  'combat operations','armed conflict','armed clashes',
  // Confirmed casualties
  'casualties reported','killed','killed in','dead','fatalities','wounded',
  'bomb exploded','blast kills','explosion kills',
  // Closures / sanctions enacted
  'port closed','port closure','airspace closed','airspace closure',
  'border closed','border closure','sanctions imposed','sanctions enacted',
  'embargo imposed','embargo enacted','trade halted','operations suspended',
  // State actions
  'state of emergency','emergency declared','martial law','martial law declared',
  'evacuation ordered','mass evacuation','mass displacement',
  // Natural disaster active
  'earthquake','flooding','flood kills','flood sweeps','hurricane impact',
  'typhoon landfall','wildfire spreading','volcano erupting','eruption',
  'tsunami warning','levee breach',
  // Infrastructure crisis
  'pipeline shutdown','refinery fire','power outage','blackout',
  'supply disruption','shipping halted','route closed',
  'outbreak confirmed','disease outbreak',
  // Political crisis
  'seized','captured','occupied','coup attempt','clashes erupt',
  'hostages taken','assassination','assassinated',
];
var _SEV1_KW = [
  // Diplomatic / political signals
  'tensions rising','rising tensions','strained relations','diplomatic row',
  'talks ongoing','negotiations underway','under consideration','under discussion',
  'policy review','concerns raised','dispute','friction','standoff','stand-off',
  'recalled ambassador','ambassador expelled','diplomat expelled',
  'diplomatic tensions','bilateral row','trade tensions',
  // Military pre-action
  'troop movement','military buildup','buildup of troops','mobilization','mobilising',
  'deployment','troops deployed','military exercises','drills','heightened alert',
  'surveillance flights','troops massing','naval patrol','warships dispatched',
  // Economic / infrastructure warning
  'delays','slowdown','reduced capacity','price pressure','market uncertainty',
  'bottleneck','backlog','shortages expected','shortage warning',
  'sanctions threatened','tariff threat','trade dispute','trade friction',
  'fuel shortage','food shortage','water shortage',
  // Disaster early stage
  'weather warning','storm forming','storm approaching','drought conditions',
  'wildfire risk','flood risk','seismic activity','volcanic activity',
  'hurricane forming','typhoon forming','storm surge warning',
  // Conflict early stage / unrest
  'unrest','protests','violent protests','clashes reported','skirmish',
  'escalation','escalating tensions','provocation','border incident',
  'incursion attempt','incursion reported','gunshots reported',
];

// ── Certainty dimension ────────────────────────────────────────────────────────
var _CERT_CONFIRMED_RE  = /\b(confirmed|verified|declared|announced|has struck|has launched|has attacked|in effect|implemented|enacted|imposed|has seized|has captured|has crossed|is attacking|are attacking|struck|launched|invaded|attacked|hit by|destroyed|detonated)\b/i;
var _CERT_SPECULATIVE_RE = /\b(may|might|could|possible|possibly|potential|potentially|risk of|risk that|fears that|warns of|warning of|anticipated|concerns that|could become|might become|possible that|threat of|at risk of|in danger of)\b/i;
var _CERT_REPORTED_RE   = /\b(reported|sources say|according to|officials say|officials confirm|media reports|witnesses say|officials said|local reports|government says|confirmed by|believed to)\b/i;
// "forecast|expected to|likely|projected" are speculative only if NOT combined with confirmed terms
var _CERT_FORECAST_RE   = /\b(forecast|expected to|likely to|projected|is expected|are expected)\b/i;

// ── Immediacy dimension ────────────────────────────────────────────────────────
var _IMM_ACTIVE_RE     = /\b(now|today|overnight|currently|breaking|just reported|at this moment|hours ago|this morning|this evening|this afternoon|is happening|has happened|just struck|just launched|just attacked)\b/i;
var _IMM_DEVELOPING_RE = /\b(continues|unfolding|developing|underway|still|escalating|intensifying|spreading|worsening|accelerating|ongoing|in progress)\b/i;
var _IMM_FUTURE_RE     = /\b(will|planning to|plans to|scheduled|next week|next month|upcoming|intends to|threatens to|could happen|may happen|is set to)\b/i;

// ── Scope dimension ────────────────────────────────────────────────────────────
var _SCOPE_GLOBAL_RE   = /\b(global|worldwide|international|world markets|nato|united nations|un security council|wto|imf|world bank|systemic risk|supply chain crisis|oil price|food price|global trade|global shipping|shipping lanes|international waters|world war|regional war|multilateral)\b/i;
var _SCOPE_NATIONAL_RE = /\b(national|nationwide|entire country|whole country|capital city|capital falls|government collapse|federal government|ministry of|president|prime minister|parliament|congress|military forces|national army|state forces)\b/i;
var _SCOPE_REGIONAL_RE = /\b(regional|province|multiple cities|cross-border|neighboring country|surrounding area|region-wide|cross-border|border region|several provinces)\b/i;

// ── Context boost — strategic infrastructure amplifies any risk signal ─────────
var _CTX_CHOKEPOINT_RE   = /suez canal|strait of hormuz|strait of malacca|taiwan strait|bosphorus strait|dardanelles|oresund|øresund|great belt|storebælt|lombok strait|sunda strait|panama canal|bab.el.mandeb|strait of gibraltar|kerch strait|danish straits|red sea corridor/i;
var _CTX_ENERGY_RE       = /\b(pipeline|lng terminal|oil field|gas field|refinery|power grid|nuclear plant|oil platform|gas pipeline|energy infrastructure|oil supply|gas supply)\b/i;
var _CTX_MAJOR_ECON_RE   = /\b(united states|china|european union|russia|india|japan|south korea|germany|france|brazil|g7|g20|opec|saudi arabia|taiwan)\b/i;
var _CTX_SUPPLY_CHAIN_RE = /\b(semiconductor|rare earth|lithium|cobalt|copper|wheat corridor|grain corridor|container port|logistics hub|critical mineral|chip supply|chip shortage)\b/i;

// ── Hard rule: confirmed kinetic/closure events → floor at WARNING ─────────────
var _HARD_WARN_TITLE_RE = /\b(attack|attacked|airstrike|airstrikes|missile|bomb|bombing|shelling|invasion|invaded|clashes|casualties|killed|killed in|dead|wounded|coup|blockade|sanctions imposed|port closed|airspace closed|border closed|military action|troops enter|seized|captured|occupied|explosion|blast|detonated|hostages|evacuated|displaced)\b/i;

// ── Main multi-factor scoring function ────────────────────────────────────────
function scoreArticleRisk(text, title) {
  var tl   = (title || '').toLowerCase();
  var full = (tl + ' ' + (text || '')).toLowerCase();

  // — Severity component (0–3): highest bucket that fires wins —
  var sevScore = 0;
  if (_SEV3_KW.some(function(k){ return full.indexOf(k) !== -1; })) {
    sevScore = 3;
  } else if (_SEV2_KW.some(function(k){ return full.indexOf(k) !== -1; })) {
    sevScore = 2;
  } else if (_SEV1_KW.some(function(k){ return full.indexOf(k) !== -1; })) {
    sevScore = 1;
  }
  // Title hit on SEV2+ keywords is a strong signal: bump +1 if not already max
  if (sevScore === 2 && (_SEV2_KW.some(function(k){ return tl.indexOf(k) !== -1; }) || _SEV3_KW.some(function(k){ return tl.indexOf(k) !== -1; }))) {
    sevScore = 3;
  }

  // — Certainty component (0–2) —
  var certainty = 1; // default: reported/inferred
  if (_CERT_CONFIRMED_RE.test(full)) {
    certainty = 2;
  } else if (_CERT_SPECULATIVE_RE.test(full) && !_CERT_REPORTED_RE.test(full)) {
    // forecast-only language without confirmatory terms = 0
    certainty = _CERT_FORECAST_RE.test(full) && !_CERT_CONFIRMED_RE.test(full) ? 0 : 0;
  } else if (_CERT_REPORTED_RE.test(full)) {
    certainty = 1;
  }

  // — Immediacy component (0–2) —
  var immediacy = 1; // default: developing/ongoing
  if (_IMM_ACTIVE_RE.test(full))  {
    immediacy = 2;
  } else if (_IMM_FUTURE_RE.test(full) && !_IMM_DEVELOPING_RE.test(full)) {
    immediacy = 0;
  }

  // — Scope component (0–3) —
  var scope = 0;
  if      (_SCOPE_GLOBAL_RE.test(full))   scope = 3;
  else if (_SCOPE_NATIONAL_RE.test(full)) scope = 2;
  else if (_SCOPE_REGIONAL_RE.test(full)) scope = 1;

  // — Context boost (+0–2): strategic nodes amplify any signal —
  var ctxBoost = 0;
  if (_CTX_CHOKEPOINT_RE.test(full))   ctxBoost = Math.min(ctxBoost + 2, 2);
  else if (_CTX_ENERGY_RE.test(full))  ctxBoost = Math.min(ctxBoost + 1, 2);
  if (_CTX_MAJOR_ECON_RE.test(full))   ctxBoost = Math.min(ctxBoost + 1, 2);
  if (_CTX_SUPPLY_CHAIN_RE.test(full)) ctxBoost = Math.min(ctxBoost + 1, 2);

  var total = sevScore + certainty + immediacy + scope + ctxBoost;

  // — Hard rule: confirmed kinetic/closure event → floor at WARNING (6) —
  // Title hit = high confidence; body hit + reported/confirmed = also qualifies
  var hardWarn = _HARD_WARN_TITLE_RE.test(tl) ||
    (_HARD_WARN_TITLE_RE.test(full) && certainty >= 1);
  if (hardWarn && total < 6) total = Math.max(total, 6);

  // — Speculative cap: if ONLY speculative language and severity < 2, cap at WATCH (<6) —
  var onlySpeculative = certainty === 0 && sevScore < 2;
  if (onlySpeculative && total >= 6) total = 5;

  // — Threshold to risk level —
  var sev = total >= 9 ? 'CRITICAL'
          : total >= 6 ? 'WARNING'
          : total >= 2 ? 'WATCH'
          : 'LOW';

  return { sev: sev, score: total, sevScore: sevScore, certainty: certainty, immediacy: immediacy, scope: scope, ctxBoost: ctxBoost, onlySpeculative: onlySpeculative };
}

// ── Legacy fallback — used by hcClassify path and external callers ────────────
// (SEVERITY_RULES is kept as a safety net; classifyArticle now calls scoreArticleRisk)
var SEVERITY_RULES = [
  { re: /critical|catastrophic|collapse|crisis|emergency|imminent|blockade|seized|nuclear|massacre|genocide|famine|mass.casualt|civilian.death|airstrike.kill|chemical.weapon|epidemic|outbreak/i, sev: 'CRITICAL' },
  { re: /escalat|surge|severe|major|significant|threat|attack|conflict|explosion|offensive|casualties|wounded|killed|displacement|bombing|humanitarian.crisis|refugee.crisis/i,                  sev: 'WARNING'  },
  { re: /tension|concern|risk|disruption|pressure|sanction|tariff|unrest|warning|protest|strike|disputed|clashes/i,                                                                               sev: 'WATCH'    },
];

var IMPACT_MAP = {
  CONFLICT: 'Active conflict affecting regional trade flows and shipping insurance premiums.',
  CYBER:    'Cyber incident posing risk to logistics, port systems, or financial infrastructure.',
  DISASTER: 'Natural disaster disrupting supply chain operations and commodity flows.',
  ECONOMIC: 'Macroeconomic development affecting global trade volumes and market stability.',
  POLICY:   'Policy change with downstream impact on trade routes, tariffs, or market access.',
};

// ── Plot priority scoring — humanitarian risk (70%) + economic risk (30%) ─────
// Humanitarian component derived from hcClassify (which already weights
// CONFLICT > HUMANITARIAN > HUMAN_RIGHTS > INSTABILITY > TENSION).
// Economic component from ECONOMIC_RE keyword match.
// ── Source credibility whitelist ──────────────────────────────────────────────
var TIER_1_SOURCES = ['associated press','ap news','reuters','agence france-presse','afp','bbc news','bbc','pbs newshour','deutsche welle','dw','cbc news','nhk world','nhk'];
var TIER_2_SOURCES = ['financial times','the globe and mail','nos news','abc news australia','channel newsasia','the hindu','south china morning post','al jazeera english','al jazeera'];
var TIER_3_SOURCES = ['daily maverick','the east african','premium times','el país','el pais','folha de s.paulo','la nación','la nacion','insight crime'];

function getSourceBoost(source) {
  if (!source) return 0;
  var s = source.toLowerCase().trim();
  // Partial match — handles "Reuters UK", "AFP English", "BBC News World" etc.
  if (TIER_1_SOURCES.some(function(t) { return s.indexOf(t) !== -1 || t.indexOf(s) !== -1; })) return 15;
  if (TIER_2_SOURCES.some(function(t) { return s.indexOf(t) !== -1 || t.indexOf(s) !== -1; })) return 8;
  if (TIER_3_SOURCES.some(function(t) { return s.indexOf(t) !== -1 || t.indexOf(s) !== -1; })) return 3;
  return 0;
}

function getSourceTierLabel(source) {
  if (!source) return null;
  var s = source.toLowerCase().trim();
  if (TIER_1_SOURCES.some(function(t) { return s.indexOf(t) !== -1 || t.indexOf(s) !== -1; }))
    return { label: 'TRUSTED', color: '#00cc66' };
  if (TIER_2_SOURCES.some(function(t) { return s.indexOf(t) !== -1 || t.indexOf(s) !== -1; }))
    return { label: 'RELIABLE', color: '#0099ff' };
  if (TIER_3_SOURCES.some(function(t) { return s.indexOf(t) !== -1 || t.indexOf(s) !== -1; }))
    return { label: 'REGIONAL', color: '#ffcc00' };
  return null;
}
window.getSourceBoost     = getSourceBoost;
window.getSourceTierLabel = getSourceTierLabel;

// Returns 0–120 score; higher = should plot on globe first.
var ECONOMIC_RE = /sanction|tariff|trade|oil|gas|energy|inflation|recession|market|supply.chain|shipping|logistics|embargo|default|debt|gdp|currency|devaluation|export|import|port|corridor|pipeline|commodity|wheat|food.price|drought|harvest|grain|fertilizer|semiconductor|chip|rare.earth|lithium/i;
var SEV_WEIGHT  = { CRITICAL: 100, WARNING: 65, WATCH: 35, LOW: 10 };

function scorePlotPriority(ev) {
  var full     = (ev.title || '') + ' ' + (ev.impact || '');
  var hc       = hcClassify(ev.title, ev.impact);   // 0–100 humanitarian score
  var ecoHit   = ECONOMIC_RE.test(full) ? 1 : 0;
  var sevScore = SEV_WEIGHT[ev.severity] || 10;
  // Weights: humanitarian 50%, economic 50% — balanced scoring
  var humScore = hc.score * 0.50;
  var ecoScore = ecoHit * sevScore * 0.50;
  // CONFLICT / DISASTER types carry an inherent humanitarian uplift (+20)
  var typeBonus   = (ev.type === 'CONFLICT' || ev.type === 'DISASTER') ? 20 : 0;
  var sourceBoost = getSourceBoost(ev.source);
  var raw = Math.round(humScore + ecoScore + typeBonus + sourceBoost);
  // Sentiment adjustment: hostile signal boosts globe visibility; positive news suppresses it
  if (typeof ev._sentiment === 'number') {
    if (ev._sentiment < -50) raw += 10;
    if (ev._sentiment >  40) raw -= 8;
  }
  return Math.max(0, Math.min(120, raw));
}

// Kinetic keywords that MUST classify as CONFLICT regardless of other signals.
// Applied inside classifyType before counting — policy/diplomatic language never overrides these.
var KINETIC_OVERRIDE_RE = /\bwar\b|genocide|massacre|violence|airstrike|bombing|missile.strike|troops|shelling|offensive|coup|terror.attack|chemical.weapon|ethnic.cleansing|war.crime|atrocity|armed.conflict|civilian.death|military.operation|killed.in|casualties.reported/i;

// ── Sentiment scoring — keyword-weighted, title-boosted ───────────────────────
// Returns -100 (maximally hostile) to +100 (maximally de-escalatory).
// Negative scores map to higher severity; positive scores suppress false escalation.
// These keywords are a SEPARATE concern from TYPE_KEYWORDS / SEVERITY_RULES.
var _SENT_THREAT = [
  // Original high-weight signals
  { w: -25, t: 'declared war'          },
  { w: -25, t: 'massacre'              },
  { w: -20, t: 'airstrike'             },
  { w: -20, t: 'bombed'                },
  { w: -20, t: 'invaded'               },
  { w: -20, t: 'coup'                  },
  { w: -20, t: 'famine'                },
  { w: -20, t: 'hostages'              },
  { w: -15, t: 'killed'                },
  { w: -15, t: 'casualties'            },
  { w: -15, t: 'blockade'              },
  { w: -15, t: 'collapsed'             },
  { w: -15, t: 'seized'                },
  { w: -15, t: 'fired upon'            },
  { w: -15, t: 'emergency declared'    },
  { w: -15, t: 'explosion'             },
  { w: -10, t: 'sanctions imposed'     },
  { w: -10, t: 'shutdown'              },
  // Extended threat signals (previously undetected)
  { w: -25, t: 'genocide'              },
  { w: -25, t: 'chemical weapon'       },
  { w: -20, t: 'missile strike'        },
  { w: -20, t: 'drone strike'          },
  { w: -20, t: 'air raid'              },
  { w: -20, t: 'assassination'         },
  { w: -20, t: 'assassinated'          },
  { w: -18, t: 'port closed'           },
  { w: -18, t: 'airspace closed'       },
  { w: -18, t: 'border closed'         },
  { w: -15, t: 'offensive launched'    },
  { w: -15, t: 'troops advancing'      },
  { w: -15, t: 'military operation'    },
  { w: -15, t: 'clashes erupt'         },
  { w: -15, t: 'civilians trapped'     },
  { w: -15, t: 'mass displacement'     },
  { w: -15, t: 'humanitarian crisis'   },
  { w: -15, t: 'state of emergency'    },
  { w: -15, t: 'martial law'           },
  { w: -15, t: 'evacuation ordered'    },
  { w: -12, t: 'sanctions enacted'     },
  { w: -12, t: 'embargo imposed'       },
  { w: -12, t: 'supply disruption'     },
  { w: -12, t: 'pipeline shutdown'     },
  { w: -12, t: 'power outage'          },
  { w: -12, t: 'blackout'              },
  { w: -10, t: 'currency collapse'     },
  { w: -10, t: 'bank failure'          },
  { w: -10, t: 'debt default'          },
  { w: -10, t: 'financial crisis'      },
  { w: -10, t: 'market crash'          },
  { w: -10, t: 'trade halted'          },
  { w: -8,  t: 'military buildup'      },
  { w: -8,  t: 'troop movement'        },
  { w: -8,  t: 'escalating tensions'   },
  { w: -8,  t: 'sanctions threatened'  },
  { w: -8,  t: 'protest crackdown'     },
  { w: -8,  t: 'internet shutdown'     },
];
var _SENT_DEESC = [
  { w: +20, t: 'ceasefire'          },
  { w: +15, t: 'peace talks'        },
  { w: +15, t: 'agreement signed'   },
  { w: +10, t: 'diplomatic'         },
  { w: +15, t: 'treaty'             },
  { w: +15, t: 'aid delivered'      },
  { w: +10, t: 'withdrawal'         },
  { w: +10, t: 'negotiations'       },
  { w: +10, t: 'released'           },
  { w: +15, t: 'resolved'           },
];

function calcSentimentScore(title, description) {
  var tLow  = (title       || '').toLowerCase();
  var dLow  = (description || '').toLowerCase();
  var full  = tLow + ' ' + dLow;
  var score = 0;
  var all   = _SENT_THREAT.concat(_SENT_DEESC);
  for (var k = 0; k < all.length; k++) {
    if (full.indexOf(all[k].t) !== -1) {
      // Title hit: 1.5× weight; description-only hit: 1× weight
      score += tLow.indexOf(all[k].t) !== -1
        ? Math.round(all[k].w * 1.5)
        : all[k].w;
    }
  }
  return Math.max(-100, Math.min(100, score));
}

// ── Severity override — adjusts regex-derived severity using sentiment score ──
// SEV order (ascending): LOW=0, WATCH=1, WARNING=2, CRITICAL=3
var _SEV_ORDER = ['LOW', 'WATCH', 'WARNING', 'CRITICAL'];

function deriveSeverity(baseRegexSev, sentimentScore, sourceBoost) {
  var idx = _SEV_ORDER.indexOf(baseRegexSev);
  if (idx === -1) idx = 0;

  // Absolute: very strong hostile signal + credible source → always CRITICAL
  if (sentimentScore < -60 && sourceBoost >= 8) return 'CRITICAL';

  // Noise suppression: ONLY apply if the base score is already LOW (idx === 0)
  // and the source is completely unknown and sentiment is positive/neutral.
  // BUG FIX: the old rule suppressed to LOW even when base was WATCH/WARNING — that
  // caused legitimate events from regional/unknown sources to be silently zeroed out.
  if (sourceBoost === 0 && sentimentScore > 15 && idx === 0) return 'LOW';

  // Upgrade floors based on hostile sentiment
  if      (sentimentScore < -40 && idx < 2) idx = 2; // floor at WARNING
  else if (sentimentScore < -20 && idx < 1) idx = 1; // floor at WATCH

  // Downgrade ceilings based on positive sentiment (never downgrade below current base)
  if      (sentimentScore > 60 && idx > 1) idx = 1;  // very positive → cap at WATCH
  else if (sentimentScore > 30 && idx > 0) idx--;    // mildly positive → one level down

  return _SEV_ORDER[idx];
}

window.calcSentimentScore = calcSentimentScore;
window.deriveSeverity     = deriveSeverity;
window.scoreArticleRisk   = scoreArticleRisk;

// ── Claude AI batch classifier ────────────────────────────────────────────────
// Sends up to 20 article titles per call → receives JSON array of {id, risk_level, category}.
// Results are cached in localStorage for 2 hours keyed by title fingerprint.
// Degrades silently — keyword classifications are always the baseline.

var _CLAUDE_SYS = [
  'You are a geopolitical risk classification engine. Classify each numbered news article title.',
  '',
  'Return ONLY a valid JSON array — no extra text, no markdown fences:',
  '[{"id":0,"risk_level":"low|watch|warning|critical","category":"conflict|cyber|disaster|economic|policy"},...]',
  '',
  'CATEGORIES:',
  '- conflict: War, military action, terrorism, civil unrest, geopolitical confrontation',
  '- cyber: Hacking, ransomware, data breaches, cyberattacks, digital security incidents',
  '- disaster: Natural or man-made catastrophes (earthquakes, floods, industrial accidents, pandemics)',
  '- economic: Market movements, recession, inflation, financial crises, trade data, employment',
  '- policy: Government decisions, legislation, regulations, diplomacy, international agreements',
  '',
  'RISK LEVELS:',
  '- low: No immediate risk. Routine or background developments.',
  '- watch: Potential emerging risk. Requires monitoring but no immediate impact.',
  '- warning: Clear escalation or credible threat. Likely to impact stability or markets.',
  '- critical: Immediate, severe, or large-scale impact. Active crises, major violence, or systemic shocks.',
  '',
  'RULES:',
  '- Active military strikes or large-scale violence → at minimum "warning", usually "critical".',
  '- Threats without confirmed action → "watch" or "warning" depending on credibility.',
  '- Protests without violence → "watch" + "conflict".',
  '- Major disasters with casualties → "critical".',
  '- Sanctions or significant legislation → "policy" with risk based on scale.',
  '- When uncertain on severity, default to the lower level.',
].join('\n');

var _AI_CLASS_BUCKET = (function() {
  try { return JSON.parse(localStorage.getItem(_AI_CLASS_CACHE_KEY) || '{}'); } catch(e) { return {}; }
}());

function _saveAIBucket() {
  // Prune bucket before saving — evict entries oldest-first if over cap.
  // Prevents the classification cache from growing indefinitely across sessions.
  var keys = Object.keys(_AI_CLASS_BUCKET);
  if (keys.length > _AI_BUCKET_MAX) {
    keys.sort(function(a, b) { return _AI_CLASS_BUCKET[a].ts - _AI_CLASS_BUCKET[b].ts; });
    keys.slice(0, keys.length - _AI_BUCKET_MAX).forEach(function(k) { delete _AI_CLASS_BUCKET[k]; });
  }
  // Defer serialization — bucket can be several hundred KB after a full session
  window._lsWrite(_AI_CLASS_CACHE_KEY, _AI_CLASS_BUCKET);
}

// ── Daily call budget helpers ─────────────────────────────────────────────────
function _getDailyBudget() {
  var today = new Date().toISOString().slice(0, 10);
  try {
    var stored = JSON.parse(localStorage.getItem(_AI_DAILY_KEY) || '{}');
    if (stored.date === today) return stored;
  } catch(e) {}
  return { date: today, count: 0 };
}

function _useDailyBudget() {
  var b = _getDailyBudget();
  b.count++;
  try { localStorage.setItem(_AI_DAILY_KEY, JSON.stringify(b)); } catch(e) {}
  return b.count;
}

// Map Claude's lowercase taxonomy → Argus uppercase taxonomy
var _AI_CAT_MAP  = { conflict:'CONFLICT', cyber:'CYBER', disaster:'DISASTER', economic:'ECONOMIC', policy:'POLICY' };
var _AI_SEV_MAP  = { low:'LOW', watch:'WATCH', warning:'WARNING', critical:'CRITICAL' };

async function applyAIClassifications(classified) {
  // AI classify is always available via the server-side proxy (ai-classify.js).
  // No client-side key required — the guard is now the server's daily cap.

  // Determine which articles need AI classification (not in cache or cache expired)
  var now = Date.now();
  var toClassify = [];
  classified.forEach(function(ev, i) {
    var key = (ev.title || '').slice(0, 80);
    var cached = _AI_CLASS_BUCKET[key];
    if (!cached || (now - cached.ts) > _AI_CLASS_CACHE_TTL) {
      toClassify.push({ idx: i, id: toClassify.length, key: key, title: ev.title || '' });
    }
  });

  if (!toClassify.length) {
    // All hits from cache — apply them
    classified.forEach(function(ev) {
      var key = (ev.title || '').slice(0, 80);
      var c = _AI_CLASS_BUCKET[key];
      if (c) { ev.type = c.cat; ev.severity = c.sev; ev._aiClassified = true; }
    });
    return classified;
  }

  // Batch into groups of 20
  // Batch size: 10 articles (down from 20) — halves tokens per call, same quality
  var batches = [];
  for (var b = 0; b < toClassify.length; b += 10) batches.push(toClassify.slice(b, b + 10));

  for (var bi = 0; bi < batches.length; bi++) {
    // Client-side pre-flight: skip remaining batches if local session allowance hit.
    // The server (ai-classify.js) enforces the authoritative global daily cap.
    var _budgetUsed = _getDailyBudget().count;
    if (_budgetUsed >= _AI_DAILY_CAP) {
      console.warn('Argus AI classify: session budget reached (' + _AI_DAILY_CAP + '). Falling back to keyword classification.');
      break;
    }
    _useDailyBudget();

    // Inter-batch delay — spread load, stay inside Anthropic burst limits
    if (bi > 0) await new Promise(function(r) { setTimeout(r, 500); });

    var batch = batches[bi];
    // 70-char title truncation: sufficient for category/severity classification,
    // ~42% fewer input tokens vs 120-char limit
    var userMsg = batch.map(function(a) { return a.id + ': ' + a.title.slice(0, 70); }).join('\n');
    try {
      var resp = await fetch(_AI_CLASSIFY_FN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payload: {
            model:      'claude-haiku-4-5-20251001',
            max_tokens: 300,
            system:     _CLAUDE_SYS,
            messages:   [{ role: 'user', content: userMsg }]
          }
        })
      });
      if (resp.status === 429) {
        var errData = await resp.json().catch(function() { return {}; });
        console.warn('Argus AI classify: server cap —', errData.code, errData.error);
        break; // server says stop — honour it immediately
      }
      if (!resp.ok) { console.warn('Argus AI classify: HTTP ' + resp.status); continue; }
      var rdata = await resp.json();
      var raw = (rdata.content && rdata.content[0] && rdata.content[0].text) || '[]';
      // Strip markdown fences if model wraps anyway
      raw = raw.replace(/^```[a-z]*\n?/,'').replace(/\n?```$/,'').trim();
      var results = JSON.parse(raw);
      results.forEach(function(r) {
        var item = batch[r.id];
        if (!item) return;
        var cat = _AI_CAT_MAP[r.category] || null;
        var sev = _AI_SEV_MAP[r.risk_level] || null;
        if (cat || sev) {
          _AI_CLASS_BUCKET[item.key] = { cat: cat, sev: sev, ts: now };
          var ev = classified[item.idx];
          if (cat) ev.type     = cat;
          if (sev) ev.severity = sev;
          ev._aiClassified = true;
        }
      });
      _saveAIBucket();
    } catch(err) {
      console.warn('Argus AI classify batch failed:', err.message);
    }
  }

  // Apply cached hits for articles that didn't need a fresh call
  classified.forEach(function(ev) {
    if (ev._aiClassified) return;
    var key = (ev.title || '').slice(0, 80);
    var c = _AI_CLASS_BUCKET[key];
    if (c) { if (c.cat) ev.type = c.cat; if (c.sev) ev.severity = c.sev; ev._aiClassified = true; }
  });

  var aiCount = classified.filter(function(e) { return e._aiClassified; }).length;
  console.log('ARGUS AI classify: ' + aiCount + '/' + classified.length + ' articles AI-classified');
  return classified;
}

function classifyArticle(article, idx) {
  var title  = (article.title || '').slice(0, 80);
  var desc   = (article.description || article.content || '').slice(0, 200);
  // Include ai_tag so tagged-but-sparse articles are classified correctly
  var tags   = Array.isArray(article.ai_tag) ? article.ai_tag.join(' ') : (article.ai_tag || '');
  var full   = title + ' ' + desc + ' ' + tags;

  // Count-based classification: most matching keywords wins; ties broken by first match.
  // KINETIC_OVERRIDE_RE hard-override is applied inside classifyType before counting.
  var type = classifyType(full);

  // ── Multi-factor risk scoring (replaces single-regex SEVERITY_RULES loop) ────
  var _riskResult = scoreArticleRisk(full, title);
  var sev         = _riskResult.sev;

  // ── Sentiment second-pass: fine-tune using tone + source credibility ─────────
  var _artSrc    = article.source_name || article.source_id || '';
  var _sentScore = calcSentimentScore(title, desc);
  sev            = deriveSeverity(sev, _sentScore, getSourceBoost(_artSrc));

  var impact = desc.length > 40 ? desc.slice(0, 160) + (desc.length > 160 ? '…' : '') : IMPACT_MAP[type];

  // pubDate: "2025-03-14 08:32:00" → "14 MAR 2025 · 08:32 UTC"
  var pubDate = '';
  if (article.pubDate) {
    try {
      var d = new Date(article.pubDate.replace(' ', 'T') + 'Z');
      var mo = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
      pubDate = d.getUTCDate() + ' ' + mo[d.getUTCMonth()] + ' ' + d.getUTCFullYear() +
                ' · ' + String(d.getUTCHours()).padStart(2,'0') + ':' + String(d.getUTCMinutes()).padStart(2,'0') + ' UTC';
    } catch(e) { pubDate = article.pubDate; }
  }

  // ai_region / country: take first entry, title-case, then async geocode
  var region = '';
  var regionRaw = '';
  if (article.ai_region) {
    var raw = Array.isArray(article.ai_region) ? article.ai_region[0] : String(article.ai_region).split(',')[0];
    regionRaw = raw.trim();
    region = regionRaw.replace(/\b\w/g, function(c) { return c.toUpperCase(); });
  } else if (article.country) {
    var cArr = Array.isArray(article.country) ? article.country : [article.country];
    regionRaw = cArr[0] || '';
    region = regionRaw.toUpperCase();
  }

  var ev = {
    id: idx + 1, type: type, severity: sev, title: title, impact: impact,
    pubDate: pubDate, region: region, regionRaw: regionRaw,
    link: article.link || '',
    source: article.source_name || article.source_id || '',
    lat: null, lon: null,
    _sentiment: _sentScore,
  };
  ev.plotPriority = scorePlotPriority(ev);

  // Async geocode — staggered to respect Nominatim 1 req/sec; cached in localStorage
  if (regionRaw) {
    var geoKey = 'argus_geo_' + regionRaw.toLowerCase().replace(/\s+/g,'_').slice(0,30);
    var geoCache = localStorage.getItem(geoKey);
    if (geoCache) {
      try { var g = JSON.parse(geoCache); ev.lat = g.lat; ev.lon = g.lon; } catch(e) {}
    } else {
      (function(evRef, rawLoc, key, i) {
        setTimeout(function() {
          fetch('https://nominatim.openstreetmap.org/search?q=' +
            encodeURIComponent(rawLoc) + '&format=json&limit=1',
            { headers: { 'Accept-Language': 'en', 'User-Agent': 'ArgusIntel/1.0' } }
          )
          .then(function(r) { return r.json(); })
          .then(function(res) {
            if (res && res[0]) {
              var geo = { lat: parseFloat(res[0].lat), lon: parseFloat(res[0].lon) };
              localStorage.setItem(key, JSON.stringify(geo));
              evRef.lat = geo.lat; evRef.lon = geo.lon;
              var locEl = document.getElementById('ev-loc-' + evRef.id);
              if (locEl) locEl.innerHTML = '&#128205; ' + evRef.region +
                ' <span style="color:#2a5a7a">' + geo.lat.toFixed(2) + '&deg;, ' + geo.lon.toFixed(2) + '&deg;</span>';
            }
          })
          .catch(function() {});
        }, i * 1300);
      })(ev, regionRaw, geoKey, idx);
    }
  }

  return ev;
}

// ── Shared title deduplication utility ───────────────────────────────────────
// Removes duplicate items from an array using two passes:
//   1. Exact match: lowercase + strip punctuation
//   2. Jaccard word-overlap fuzzy match at given threshold
// First-occurrence wins on exact; earliest pubDate wins on fuzzy cluster.
// Works on any array whose items have a .title property.
// Optional .pubDate property (raw API string) used for tie-breaking.
function deduplicateByTitle(items, threshold) {
  if (!items || !items.length) return items;
  if (threshold == null) threshold = 0.72;

  // ── Pass 1: exact dedup ───────────────────────────────────────────────────
  var seen = {};
  var pass1 = items.filter(function(item) {
    var key = (item.title || '').toLowerCase()
                .replace(/[^a-z0-9\s]/g, '')
                .replace(/\s+/g, ' ').trim();
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });

  // ── Pass 2: Jaccard fuzzy dedup ───────────────────────────────────────────
  function tokenize(str) {
    return (str || '').toLowerCase()
      .replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
  }
  function jaccard(tokA, tokB) {
    var sa = {}, inter = 0;
    tokA.forEach(function(w) { sa[w] = true; });
    tokB.forEach(function(w) { if (sa[w]) inter++; });
    var unionSize = Object.keys(sa).length + tokB.length - inter;
    return unionSize === 0 ? 0 : inter / unionSize;
  }
  function pubDateMs(item) {
    if (!item.pubDate) return 0;
    try {
      var d = new Date(item.pubDate.replace(' ', 'T') + 'Z');
      return isNaN(d.getTime()) ? 0 : d.getTime();
    } catch(e) { return 0; }
  }

  var result = [];
  var dropped = {};  // index → true

  for (var i = 0; i < pass1.length; i++) {
    if (dropped[i]) continue;
    var tokI = tokenize(pass1[i].title);
    // Scan forward for near-duplicates, collect cluster
    var cluster = [{ item: pass1[i], origIdx: i }];
    for (var j = i + 1; j < pass1.length; j++) {
      if (dropped[j]) continue;
      if (jaccard(tokI, tokenize(pass1[j].title)) >= threshold) {
        cluster.push({ item: pass1[j], origIdx: j });
        dropped[j] = true;
      }
    }
    // Keep earliest pubDate in cluster; fall back to first in array
    if (cluster.length > 1) {
      cluster.sort(function(a, b) {
        var da = pubDateMs(a.item), db = pubDateMs(b.item);
        if (da && db) return da - db;
        return a.origIdx - b.origIdx;
      });
      console.log('ArgusDedup: merged ' + cluster.length + ' near-dupes → "' +
        (cluster[0].item.title || '').slice(0, 60) + '"');
    }
    result.push(cluster[0].item);
    dropped[i] = true;
  }

  return result;
}

async function fetchAndClassify() {
  var newsUrl = 'https://newsdata.io/api/1/latest' +
    '?apikey=__KEY__' +
    '&q=' + encodeURIComponent('war OR conflict OR casualties OR sanctions OR trade OR oil OR disaster') +
    '&language=en' +
    '&size=10';

  var res = await fetch('https://wbvzlxtroewxrmonxodx.supabase.co/functions/v1/data-proxy', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndidnpseHRyb2V3eHJtb254b2R4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM3OTQzNzMsImV4cCI6MjA4OTM3MDM3M30.0zp-wQ3wKpYc0f7LqFCOEea_d9HJuWnUSWgF4BAW82w'
    },
    body: JSON.stringify({ source: 'newsdata', url: newsUrl })
  });
  if (!res.ok) {
    var body = await res.text().catch(function() { return ''; });
    throw new Error('NewsData ' + res.status + ': ' + body.slice(0, 120));
  }
  var data = await res.json();
  if (data.status !== 'success') throw new Error(data.message || 'NewsData error');

  var articles = data.results || [];
  if (!articles.length) throw new Error('NewsData: no results');

  // Filter: remove API-flagged dupes and irrelevant articles
  var filtered = articles.filter(function(a) {
    if (a.duplicate) return false;
    var tags = Array.isArray(a.ai_tag) ? a.ai_tag.join(' ') : (a.ai_tag || '');
    var full  = (a.title || '') + ' ' + (a.description || '') + ' ' + tags;
    return RELEVANT_TAGS.test(full);
  });

  // Fall back to unfiltered if everything got stripped
  if (!filtered.length) filtered = articles.filter(function(a) { return !a.duplicate; });
  if (!filtered.length) filtered = articles;

  // Exact + fuzzy title dedup — keeps earliest pubDate per near-duplicate cluster
  filtered = deduplicateByTitle(filtered, 0.72);

  console.log('ARGUS NewsData: ' + articles.length + ' fetched, ' + filtered.length + ' after filter+dedup');
  var classified = filtered.map(classifyArticle);
  // AI second-pass: refine type + severity using Claude Haiku (no-op if key not set)
  classified = await applyAIClassifications(classified);
  // Sort: highest humanitarian-weighted priority first
  classified.sort(function(a, b) { return b.plotPriority - a.plotPriority; });
  // ── Sentiment distribution log ────────────────────────────────────────────
  var _sd = { CRITICAL: 0, WARNING: 0, WATCH: 0, LOW: 0 }, _ss = 0;
  classified.forEach(function(e) { if (_sd[e.severity] !== undefined) _sd[e.severity]++; if (typeof e._sentiment === 'number') _ss += e._sentiment; });
  console.log('GDELT sentiment: CRITICAL=' + _sd.CRITICAL + ' WARNING=' + _sd.WARNING + ' WATCH=' + _sd.WATCH + ' LOW=' + _sd.LOW + ' avg=' + (classified.length ? Math.round(_ss / classified.length) : 0));
  return classified;
}

// ── Auto-suggest top events to admin queue (max 5 CRITICAL/WARNING per day) ──
// Runs once per day after fetchAndClassify(). Submits to argus_event_queue
// with status 'pending' and source 'AUTO_SUGGEST' so admins can review,
// set coordinates, and approve for globe plotting.
var AUTO_SUGGEST_CAP   = 5;
var AUTO_SUGGEST_SEVS  = { CRITICAL: 0, WARNING: 1 };  // only these tiers qualify
var AUTO_SUGGEST_TODAY = (function() {
  var d = new Date();
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2,'0') + '-' + String(d.getUTCDate()).padStart(2,'0');
}());
var AUTO_SUGGEST_LS_KEY = 'argus_autoq_' + AUTO_SUGGEST_TODAY;  // resets daily

function autoSuggestTopEvents(classified) {
  // Only fire once per calendar day (UTC)
  var alreadyDone = parseInt(localStorage.getItem(AUTO_SUGGEST_LS_KEY) || '0');
  if (alreadyDone >= AUTO_SUGGEST_CAP) {
    console.log('AutoSuggest: daily cap (' + AUTO_SUGGEST_CAP + ') reached — skipping');
    return;
  }

  // Load deduplicated title set for today
  var dedupKey = 'argus_autoq_titles_' + AUTO_SUGGEST_TODAY;
  var submitted = {};
  try { submitted = JSON.parse(localStorage.getItem(dedupKey) || '{}'); } catch(e) {}

  // Pick top CRITICAL/WARNING events not already submitted today
  var candidates = classified.filter(function(ev) {
    return AUTO_SUGGEST_SEVS[ev.severity] !== undefined;
  });
  // Already sorted by plotPriority descending from fetchAndClassify
  var toSubmit = [];
  for (var ci = 0; ci < candidates.length && toSubmit.length < (AUTO_SUGGEST_CAP - alreadyDone); ci++) {
    var titleKey = (candidates[ci].title || '').slice(0, 80).toLowerCase();
    if (!submitted[titleKey]) toSubmit.push(candidates[ci]);
  }

  if (!toSubmit.length) {
    console.log('AutoSuggest: no new CRITICAL/WARNING events to suggest');
    return;
  }

  // Resolve session token (anon key fallback)
  var sess = null;
  try { sess = JSON.parse(localStorage.getItem('argus_session')); } catch(e) {}
  var token = (sess && sess.access_token) || SUPA_ANON_GDELT;

  var submitCount = 0;
  toSubmit.forEach(function(ev, i) {
    // Stagger submissions 600 ms apart to avoid burst writes
    setTimeout(async function() {
      // ── Dupe gate: check DB before inserting ─────────────────────────────
      try {
        var dupRes = await fetch('https://wbvzlxtroewxrmonxodx.supabase.co/rest/v1/rpc/is_duplicate_event', {
          method: 'POST',
          headers: {
            'apikey':       SUPA_ANON_GDELT,
            'Authorization':'Bearer ' + token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ p_title: ev.title || '', p_category: ev.type || 'CONFLICT' })
        });
        var isDupe = await dupRes.json();
        if (isDupe === true) {
          console.log('AutoSuggest: dupe skip (DB) —', (ev.title || '').slice(0, 60));
          return;
        }
      } catch(dupErr) {
        console.warn('AutoSuggest: dupe check failed (proceeding):', dupErr.message);
      }

      // Build location object — include lat/lon only if geocoding already resolved
      var locObj = null;
      if (ev.regionRaw || ev.region) {
        locObj = { country: ev.regionRaw || ev.region };
        if (ev.lat != null && ev.lon != null) {
          locObj.lat = ev.lat;
          locObj.lon = ev.lon;
        }
        // else: lat/lon left null → admin fills in before approving
      }

      var payload = {
        source:    'AUTO_SUGGEST',
        category:  ev.type || 'CONFLICT',
        status:    'pending',
        timestamp: new Date().toISOString(),
        location:  locObj,
        data: {
          title:    ev.title,
          severity: ev.severity,
          type:     ev.type,
          impact:   ev.impact || '',
          link:     ev.link  || '',
          source:   ev.source || 'NewsData',
          pubDate:  ev.pubDate || '',
          autoSuggest: true,
        }
      };

      fetch('https://wbvzlxtroewxrmonxodx.supabase.co/rest/v1/argus_event_queue', {
        method:  'POST',
        headers: {
          'apikey':       SUPA_ANON_GDELT,
          'Authorization':'Bearer ' + token,
          'Content-Type': 'application/json',
          'Prefer':       'return=minimal'
        },
        body: JSON.stringify(payload)
      })
      .then(function(r) {
        if (r.ok) {
          // Mark title as submitted today
          var tKey = (ev.title || '').slice(0, 80).toLowerCase();
          submitted[tKey] = 1;
          localStorage.setItem(dedupKey, JSON.stringify(submitted));
          submitCount++;
          localStorage.setItem(AUTO_SUGGEST_LS_KEY, String(alreadyDone + submitCount));
          console.log('AutoSuggest: queued [' + ev.severity + '] ' + ev.title.slice(0, 60));
        } else {
          r.text().then(function(t) { console.warn('AutoSuggest: submit failed (' + r.status + '):', t.slice(0,80)); });
        }
      })
      .catch(function(err) {
        console.warn('AutoSuggest: network error:', err.message);
      });
    }, i * 600);
  });
}

async function loadLiveEvents() {
  try {
    var cached = localStorage.getItem(FEED_CACHE_KEY);
    var ts     = parseInt(localStorage.getItem(FEED_CACHE_TS) || '0');
    if (cached && Date.now() - ts < FEED_TTL) {
      renderEvents(JSON.parse(cached), true);
      // Suggest from cache too (dedup prevents re-submission)
      try { autoSuggestTopEvents(JSON.parse(cached)); } catch(e) {}
      return;
    }
  } catch(e) {}

  showLoadingState();

  try {
    var liveEvents = await fetchAndClassify();
    window._lsWrite(FEED_CACHE_KEY, liveEvents);
    window._lsWrite(FEED_CACHE_TS, String(Date.now()));
    renderEvents(liveEvents, true);
    window._liveEventContext = liveEvents.map(function(e) { return '• ' + e.title + ' [' + e.severity + ']'; }).join('\n');
    console.log('ARGUS: ' + liveEvents.length + ' live events loaded');
    autoSuggestTopEvents(liveEvents);
  } catch(err) {
    console.warn('Live feed error:', err.message, '— using fallback');
    renderEvents(FALLBACK_EVENTS, false);
  }
}

loadLiveEvents();
setInterval(function () { if (!document.hidden) loadLiveEvents(); }, FEED_TTL);

// ════════════════════════════════════════════════════════════════════════════
// USGS Earthquake Feed — free, no key, real-time GeoJSON
// Fetches M4.5+ earthquakes from past 7 days
// ════════════════════════════════════════════════════════════════════════════
(function loadUSGS() {
  var USGS_URL   = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson';
  var CACHE_KEY  = 'argus_usgs_v1';
  var CACHE_TS   = 'argus_usgs_ts_v1';
  var TTL        = 30 * 60 * 1000; // 30 min

  try {
    var cached = localStorage.getItem(CACHE_KEY);
    var ts     = parseInt(localStorage.getItem(CACHE_TS) || '0');
    if (cached && Date.now() - ts < TTL) {
      injectUSGS(JSON.parse(cached)); return;
    }
  } catch(e) {}

  fetch(USGS_URL)
  .then(function(r) { return r.json(); })
  .then(function(data) {
    var features = (data.features || []).slice(0, 20);
    localStorage.setItem(CACHE_KEY, JSON.stringify(features));
    localStorage.setItem(CACHE_TS, String(Date.now()));
    injectUSGS(features);
  })
  .catch(function(e) { console.warn('USGS: failed', e.message); });

  function injectUSGS(features) {
    var events = features.map(function(f, i) {
      var p   = f.properties;
      var mag = parseFloat(p.mag || 0);
      var sev = mag >= 7.0 ? 'CRITICAL' : mag >= 6.0 ? 'WARNING' : mag >= 5.0 ? 'WATCH' : 'LOW';
      var coords = f.geometry && f.geometry.coordinates;
      return {
        id: 9000 + i,
        type: 'DISASTER',
        severity: sev,
        title: 'M' + mag.toFixed(1) + ' Earthquake — ' + (p.place || 'Unknown region'),
        impact: 'Magnitude ' + mag.toFixed(1) + ' seismic event detected. Depth: ' + (coords ? coords[2] : '?') + ' km.',
        region: p.place || '',
        pubDate: p.time ? new Date(p.time).toUTCString().slice(0,22) : '',
        source: 'USGS',
        link: p.url || '',
        lat: coords ? coords[1] : null,
        lon: coords ? coords[0] : null,
        plotPriority: mag >= 7 ? 90 : mag >= 6 ? 60 : 30,
      };
    }).filter(function(e) { return e.plotPriority >= 30; });

    window._usgsEvents = events;
    console.log('USGS: ' + events.length + ' earthquakes loaded');
    mergeAuxEvents();
  }
})();

// ════════════════════════════════════════════════════════════════════════════
// ReliefWeb Active Crises — free, no key, UN OCHA
// ════════════════════════════════════════════════════════════════════════════
(function loadReliefWeb() {
  var RW_URL    = 'https://api.reliefweb.int/v1/disasters?appname=argus-intel&filter[field]=status&filter[value]=current&limit=20&fields[include][]=name&fields[include][]=country&fields[include][]=type&fields[include][]=date&fields[include][]=status';
  var CACHE_KEY = 'argus_rw_v1';
  var CACHE_TS  = 'argus_rw_ts_v1';
  var TTL       = 60 * 60 * 1000; // 1 hr

  try {
    var cached = localStorage.getItem(CACHE_KEY);
    var ts     = parseInt(localStorage.getItem(CACHE_TS) || '0');
    if (cached && Date.now() - ts < TTL) {
      injectRW(JSON.parse(cached)); return;
    }
  } catch(e) {}

  // Try direct first (ReliefWeb has CORS headers); fall back to allorigins proxy
  fetch(RW_URL)
  .then(function(r) { return r.ok ? r.json() : Promise.reject('HTTP ' + r.status); })
  .catch(function() {
    return fetch('https://api.allorigins.win/raw?url=' + encodeURIComponent(RW_URL))
      .then(function(r) { return r.ok ? r.json() : null; });
  })
  .then(function(data) {
    if (!data) { console.warn('ReliefWeb: no data'); return; }
    var items = (data.data || []);
    localStorage.setItem(CACHE_KEY, JSON.stringify(items));
    localStorage.setItem(CACHE_TS, String(Date.now()));
    injectRW(items);
  })
  .catch(function(e) { console.warn('ReliefWeb: failed', e.message); });

  function injectRW(items) {
    var events = items.map(function(d, i) {
      var f       = d.fields || {};
      var country = f.country && f.country[0] ? f.country[0].name : '';
      var type    = f.type    && f.type[0]    ? f.type[0].name    : 'Disaster';
      return {
        id: 9500 + i,
        type: 'DISASTER',
        severity: 'WARNING',
        title: type + ' — ' + (f.name || country || 'Active Crisis'),
        impact: 'Active UN-designated crisis. Country: ' + (country || 'Unknown') + '. Status: ' + (f.status || 'current') + '.',
        region: country,
        pubDate: f.date && f.date.created ? new Date(f.date.created).toLocaleDateString() : '',
        source: 'UN RELIEFWEB',
        link: 'https://reliefweb.int',
        plotPriority: 55,
      };
    });
    window._rwCrisisEvents = events;
    console.log('ReliefWeb: ' + events.length + ' active crises loaded');
    mergeAuxEvents();
  }
})();

// ── Merge auxiliary sources into main feed ────────────────────────────────────
function mergeAuxEvents() {
  var base    = window._currentEvents || [];
  var usgs    = window._usgsEvents    || [];
  var rw      = window._rwCrisisEvents || [];
  var aux     = usgs.concat(rw);
  if (!aux.length) return;
  // Remove previous aux injections then prepend new ones
  var filtered = base.filter(function(e) { return e.id < 9000; });
  var merged   = aux.concat(filtered);
  merged.sort(function(a,b) { return b.plotPriority - a.plotPriority; });
  window._currentEvents = merged;
}

// ════════════════════════════════════════════════════════════════════════════
// ArgusUI — panel display and detail views
// ════════════════════════════════════════════════════════════════════════════
window.ArgusUI = (function() {

  var aiOpen = false;

  function toggleAI() {
    var tier = window.ArgusSession ? window.ArgusSession.tier : 'viewer';
    var hasAccess = (tier === 'owner' || tier === 'admin' || tier === 'pro');
    if (!hasAccess) {
      showUpgradePrompt();
      return;
    }
    aiOpen = !aiOpen;
    document.getElementById('panel-ai').classList.toggle('is-open', aiOpen);
    document.getElementById('panel-ai').setAttribute('aria-hidden', String(!aiOpen));
    document.getElementById('btn-ai-query').classList.toggle('is-active', aiOpen);
  }

  function showUpgradePrompt() {
    var existing = document.getElementById('upgrade-modal');
    if (existing) { existing.classList.add('is-open'); return; }
    var modal = document.createElement('div');
    modal.id = 'upgrade-modal';
    modal.style.cssText = [
      'position:fixed','inset:0','z-index:999',
      'display:flex','align-items:center','justify-content:center',
      'background:rgba(4,13,24,0.85)','backdrop-filter:blur(8px)',
    ].join(';');
    modal.innerHTML = [
      '<div style="width:340px;background:#071525;border:1px solid #0f2d48;padding:32px;position:relative;font-family:\'Barlow Condensed\',sans-serif;">',
        '<div style="position:absolute;top:0;left:0;width:32px;height:32px;border-top:2px solid #0af;border-left:2px solid #0af;"></div>',
        '<div style="font-size:9px;letter-spacing:4px;color:#0af;margin-bottom:8px;">ARGUS PRO</div>',
        '<div style="font-size:20px;font-weight:700;color:#f0f8ff;letter-spacing:1px;margin-bottom:12px;">AI QUERY ENGINE</div>',
        '<div style="font-size:13px;color:#3a6a8a;line-height:1.6;margin-bottom:20px;">',
          'The AI intelligence query engine is available to Pro analysts. ',
          'Upgrade to ask questions across live geopolitical, energy, and supply chain data.',
        '</div>',
        '<div style="display:flex;flex-direction:column;gap:10px;">',
          '<button id="upgrade-cta-btn" onclick="ArgusUpgrade.startCheckout()" ',
            'style="background:transparent;border:1px solid #0af;color:#0af;padding:12px;font-family:var(--font-mono);font-size:12px;letter-spacing:3px;cursor:pointer;">',
            'UPGRADE TO PRO →',
          '</button>',
          '<button onclick="document.getElementById(\'upgrade-modal\').style.display=\'none\'" ',
            'style="background:transparent;border:1px solid #0f2d48;color:#3a6a8a;padding:10px;font-family:\'Barlow Condensed\',sans-serif;font-size:11px;letter-spacing:2px;cursor:pointer;">',
            'CONTINUE AS VIEWER',
          '</button>',
        '</div>',
      '</div>',
    ].join('');
    modal.classList.add('is-open');
    document.body.appendChild(modal);
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.style.display = 'none'; });
  }

  function setSuggestion(el) {
    document.getElementById('ai-input').value = el.textContent;
  }

  // ── Show success banner if redirected back from Stripe ────────────────────
  (function() {
    if (window.location.search.indexOf('upgraded=1') !== -1) {
      history.replaceState(null, '', window.location.pathname);
      var banner = document.createElement('div');
      banner.style.cssText = 'position:fixed;top:70px;left:50%;transform:translateX(-50%);z-index:9999;' +
        'background:#071525;border:1px solid #00cc66;color:#00cc66;font-family:var(--font-mono);' +
        'font-size:9px;letter-spacing:2px;padding:10px 20px;border-radius:2px;';
      banner.textContent = '✓ ARGUS PRO ACTIVATED — WELCOME TO THE NETWORK';
      document.body.appendChild(banner);
      setTimeout(function(){ banner.remove(); }, 5000);
    }
  })();

  function closeDetail() {
    var panel = document.getElementById('panel-detail');
    panel.classList.remove('is-visible');
    panel.setAttribute('aria-hidden', 'true');
    document.getElementById('hint').style.display = 'block';
    // Restore HUD legend
    var hudLegend = document.getElementById('hud-legend');
    if (hudLegend) hudLegend.style.visibility = '';
  }

  function openDetail(col) {
    var panel = document.getElementById('panel-detail');
    panel.style.borderTopColor = col;
    panel.classList.add('is-visible');
    panel.setAttribute('aria-hidden', 'false');
    document.getElementById('hint').style.display = 'none';
    // Suppress HUD legend so detail panel is never obscured
    var hudLegend = document.getElementById('hud-legend');
    if (hudLegend) hudLegend.style.visibility = 'hidden';
  }

  function showEventDetail(d) {
    var tagEl  = document.getElementById('detail-tag');
    var nameEl = document.getElementById('detail-name');
    var badge  = document.getElementById('detail-risk-badge');
    var bodyEl = document.getElementById('detail-body');

    tagEl.textContent  = '';
    nameEl.textContent = '';

    // ── Aircraft detail ─────────────────────────────────────────────────────────
    if (d.isAircraft) {
      var FT_LABEL = {
        commercial: 'COMMERCIAL AVIATION',
        cargo:      'CARGO FREIGHT',
        military:   'MILITARY / GOVERNMENT',
        unknown:    'CLASSIFICATION PENDING'
      };
      var FT_COL = {
        commercial: '#c5d7e8',
        cargo:      '#4488ff',
        military:   '#ff4444',
        unknown:    '#5577aa'
      };
      var ft     = (d.flightType || 'unknown').toLowerCase();
      var ftLabel = FT_LABEL[ft] || ft.toUpperCase();
      var ftCol   = FT_COL[ft]   || '#5577aa';

      badge.textContent       = ft.toUpperCase();
      badge.style.color       = ftCol;
      badge.style.borderColor = ftCol + '44';
      badge.style.background  = ftCol + '14';

      // Callsign — everything before ' · ' in title
      var cs = d.title ? d.title.split(' · ')[0] : '—';

      // Altitude — feet + flight level
      var altStr = 'N/A — DATA UNAVAILABLE';
      if (d.alt != null) {
        var fl = Math.round(d.alt / 100);
        altStr = d.alt.toLocaleString() + ' ft  ·  FL' + fl;
      }

      // Heading — degrees + 16-point cardinal
      var hdgStr = 'N/A — DATA UNAVAILABLE';
      if (d.heading != null) {
        var cardinals = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
        var card      = cardinals[Math.round(d.heading / 22.5) % 16];
        hdgStr        = d.heading + '°  (' + card + ')';
      }

      // Position
      var latStr = d.lat != null ? (Math.abs(d.lat).toFixed(2) + '° ' + (d.lat >= 0 ? 'N' : 'S')) : '—';
      var lonStr = d.lon != null ? (Math.abs(d.lon).toFixed(2) + '° ' + (d.lon >= 0 ? 'E' : 'W')) : '—';

      // ADS-B coverage region — human label
      var REGION_LABEL = {
        NA_EAST:  'NORTH AMERICA EAST',
        NA_WEST:  'NORTH AMERICA WEST',
        EUROPE:   'EUROPE',
        EAST_ASIA:'EAST ASIA',
        SE_ASIA:  'SOUTHEAST ASIA',
        MIDEAST:  'MIDDLE EAST',
        LATAM:    'LATIN AMERICA',
        OCEANIA:  'OCEANIA / PACIFIC'
      };
      var regionStr = d.region ? (REGION_LABEL[d.region] || d.region) : 'N/A — DATA UNAVAILABLE';

      bodyEl.innerHTML =
        '<div class="detail__section-header">IDENTIFICATION</div>' +
        '<div class="detail__row"><span class="detail__label">CALLSIGN</span><span class="detail__value">' + cs + '</span></div>' +
        '<div class="detail__row"><span class="detail__label">FLIGHT TYPE</span><span class="detail__value" style="color:' + ftCol + '">' + ftLabel + '</span></div>' +
        '<div class="detail__section-header">FLIGHT STATE</div>' +
        '<div class="detail__row"><span class="detail__label">ALTITUDE</span><span class="detail__value">' + altStr + '</span></div>' +
        '<div class="detail__row"><span class="detail__label">HEADING</span><span class="detail__value">' + hdgStr + '</span></div>' +
        '<div class="detail__section-header">ORIGIN</div>' +
        '<div class="detail__row"><span class="detail__label">ADS-B REGION</span><span class="detail__value">' + regionStr + '</span></div>' +
        '<div class="detail__row"><span class="detail__label">POSITION</span><span class="detail__value">' + latStr + '  ' + lonStr + '</span></div>';

      openDetail(ftCol);
      ArgusAnim.cipherDecode(tagEl,  'AIRSPACE TRACK', 320);
      ArgusAnim.cipherDecode(nameEl, cs,               560);
      ArgusAnim.cipherDecode(badge,  ft.toUpperCase(), 260);
      ArgusAnim.staggerRows(bodyEl);
      return;
    }

    // ── Vessel detail ───────────────────────────────────────────────────────────
    if (d.isShip) {
      var VT_LABEL = {
        cargo:        'CARGO VESSEL',
        tanker:       'TANKER',
        military:     'NAVAL / MILITARY',
        passenger:    'PASSENGER / FERRY',
        fishing:      'FISHING VESSEL',
        tug:          'TUG / SALVAGE',
        port_service: 'PORT SERVICE',
        recreational: 'RECREATIONAL',
        other:        'COMMERCIAL VESSEL',
        unknown:      'CLASSIFICATION PENDING'
      };
      var VT_COL = {
        cargo:        '#4488ff',
        tanker:       '#ff9933',
        military:     '#ff4444',
        passenger:    '#c5d7e8',
        fishing:      '#44cc88',
        tug:          '#ffcc44',
        port_service: '#aaaaaa',
        recreational: '#cc88ff',
        other:        '#14b8a6',
        unknown:      '#5577aa'
      };
      var NAV_STATUS_LABEL = {
        '0':  'UNDERWAY — ENGINE',
        '1':  'AT ANCHOR',
        '2':  'NOT UNDER COMMAND',
        '3':  'RESTRICTED MANOEUVRABILITY',
        '4':  'CONSTRAINED BY DRAUGHT',
        '5':  'MOORED',
        '6':  'AGROUND',
        '7':  'ENGAGED IN FISHING',
        '8':  'UNDERWAY — SAILING',
        '15': 'STATUS UNKNOWN'
      };

      var vt      = (d.typeCategory || 'unknown').toLowerCase();
      var vtLabel = VT_LABEL[vt] || vt.toUpperCase();
      var vtCol   = VT_COL[vt]   || '#5577aa';

      badge.textContent       = vt.toUpperCase();
      badge.style.color       = vtCol;
      badge.style.borderColor = vtCol + '44';
      badge.style.background  = vtCol + '14';

      var vName   = d.title || 'UNIDENTIFIED VESSEL';
      var mmsiStr = d.mmsi  || 'N/A';

      // Speed — knots
      var sogStr = 'N/A — DATA UNAVAILABLE';
      if (d.velocity != null) sogStr = d.velocity.toFixed(1) + ' kts';

      // Course over ground — degrees + 16-point cardinal
      var cogStr = 'N/A — DATA UNAVAILABLE';
      if (d.heading != null) {
        var vcardinals = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
        var vcard      = vcardinals[Math.round(d.heading / 22.5) % 16];
        cogStr         = Math.round(d.heading) + '°  (' + vcard + ')';
      }

      // Nav status
      var nsStr = 'N/A';
      if (d.navStatus != null) {
        var nsKey = String(d.navStatus);
        nsStr = NAV_STATUS_LABEL[nsKey] || ('STATUS ' + nsKey);
      }

      // Position
      var vLatStr = d.lat != null ? (Math.abs(d.lat).toFixed(2) + '° ' + (d.lat >= 0 ? 'N' : 'S')) : '—';
      var vLonStr = d.lon != null ? (Math.abs(d.lon).toFixed(2) + '° ' + (d.lon >= 0 ? 'E' : 'W')) : '—';

      // AIS region
      var VESSEL_REGION_LABEL = {
        ASIA_PACIFIC:  'ASIA PACIFIC',
        MIDDLE_EAST:   'MIDDLE EAST',
        EUROPE_MED:    'EUROPE / MEDITERRANEAN',
        AMERICAS:      'AMERICAS',
        SOUTH_AFRICA:  'SOUTH AFRICA / CAPE'
      };
      var vRegionStr = d.region ? (VESSEL_REGION_LABEL[d.region] || d.region) : 'N/A';

      // Destination
      var destStr = (d.destination && d.destination.trim()) ? d.destination.trim().toUpperCase() : 'N/A — NOT REPORTED';

      bodyEl.innerHTML =
        '<div class="detail__section-header">IDENTIFICATION</div>' +
        '<div class="detail__row"><span class="detail__label">VESSEL NAME</span><span class="detail__value">' + vName + '</span></div>' +
        '<div class="detail__row"><span class="detail__label">VESSEL TYPE</span><span class="detail__value" style="color:' + vtCol + '">' + vtLabel + '</span></div>' +
        '<div class="detail__row"><span class="detail__label">MMSI</span><span class="detail__value">' + mmsiStr + '</span></div>' +
        '<div class="detail__section-header">NAVIGATION STATE</div>' +
        '<div class="detail__row"><span class="detail__label">SPEED</span><span class="detail__value">' + sogStr + '</span></div>' +
        '<div class="detail__row"><span class="detail__label">COURSE</span><span class="detail__value">' + cogStr + '</span></div>' +
        '<div class="detail__row"><span class="detail__label">NAV STATUS</span><span class="detail__value">' + nsStr + '</span></div>' +
        '<div class="detail__section-header">ORIGIN / DESTINATION</div>' +
        '<div class="detail__row"><span class="detail__label">AIS REGION</span><span class="detail__value">' + vRegionStr + '</span></div>' +
        '<div class="detail__row"><span class="detail__label">POSITION</span><span class="detail__value">' + vLatStr + '  ' + vLonStr + '</span></div>' +
        '<div class="detail__row"><span class="detail__label">DESTINATION</span><span class="detail__value">' + destStr + '</span></div>';

      openDetail(vtCol);
      ArgusAnim.cipherDecode(tagEl,  'MARITIME TRACK',  320);
      ArgusAnim.cipherDecode(nameEl,  vName,             560);
      ArgusAnim.cipherDecode(badge,   vt.toUpperCase(),  260);
      ArgusAnim.staggerRows(bodyEl);
      return;
    }

    // ── Standard event detail ───────────────────────────────────────────────────
    var col = RC[d.severity] || '#0099ff';
    badge.textContent       = d.severity;
    badge.style.color       = col;
    badge.style.borderColor = col + '44';
    badge.style.background  = RB[d.severity] || 'transparent';

    bodyEl.innerHTML =
      '<div class="detail__row"><span class="detail__label">TYPE</span><span class="detail__value">' + d.type + '</span></div>' +
      '<div class="detail__row"><span class="detail__label">SEVERITY</span><span class="detail__value" style="color:' + col + '">' + d.severity + '</span></div>' +
      '<div class="detail__status-box" style="background:' + (RB[d.severity] || '') + ';border-color:' + col + '44">' +
        '<div class="detail__label" style="color:' + col + ';margin-bottom:5px">IMPACT ASSESSMENT</div>' +
        '<div style="font-size:11px;line-height:1.7">' + (d.impact || 'No additional data') + '</div>' +
      '</div>';

    openDetail(col);
    ArgusAnim.cipherDecode(tagEl,  'EVENT ALERT', 320);
    ArgusAnim.cipherDecode(nameEl,  d.title,       560);
    ArgusAnim.cipherDecode(badge,   d.severity,    260);
    ArgusAnim.staggerRows(bodyEl);
  }

  function showStaticDetail(d) {
    var col = RC[d.risk] || '#0099ff';
    var tagLabel  = d.isCountry ? 'COUNTRY PROFILE' : 'CHOKEPOINT SENTINEL';
    var tagEl     = document.getElementById('detail-tag');
    var nameEl    = document.getElementById('detail-name');
    var badge     = document.getElementById('detail-risk-badge');

    tagEl.textContent  = '';
    nameEl.textContent = '';
    badge.textContent  = d.risk;
    badge.style.color       = col;
    badge.style.borderColor = col + '44';
    badge.style.background  = RB[d.risk] || 'transparent';

    var html = '';
    if (d.isCountry) {
      html += '<div class="detail__section-header">TRADE PROFILE</div>';
      [['GDP', d.gdp], ['EXPORTS', d.exports], ['IMPORTS', d.imports]].forEach(function(kv) {
        html += '<div class="detail__row"><span class="detail__label">' + kv[0] + '</span><span class="detail__value">' + kv[1] + '</span></div>';
      });
      html += '<div style="margin-top:10px"><div class="detail__label" style="margin-bottom:7px">TOP EXPORTS</div>' +
        '<div class="tag-list">' + d.topE.map(function(e) { return '<span class="tag" style="color:#00ff88;border-color:#00ff8844;background:rgba(0,255,136,0.08)">' + e + '</span>'; }).join('') + '</div></div>';
      html += '<div style="margin-top:10px"><div class="detail__label" style="margin-bottom:7px">TOP IMPORTS</div>' +
        '<div class="tag-list">' + d.topI.map(function(e) { return '<span class="tag" style="color:#0099ff;border-color:#0099ff44;background:rgba(0,153,255,0.08)">' + e + '</span>'; }).join('') + '</div></div>';
      html += '<div class="detail__section-header">RISK ASSESSMENT</div>';
      html += '<div class="detail__row"><span class="detail__label">BASELINE SCORE<br><span style="font-size:7px;color:#4a7da8;letter-spacing:0;font-weight:300">Human rights 70% · Supply chain 30%<br>FH · RSF · ILGA · Gini · Trade</span></span><span class="detail__value" style="color:' + col + '">' + d.score + ' / 100</span></div>';
      if (d._dynamicScore != null) {
        var dsCol = d._dynamicScore >= 75 ? '#ff0044' : d._dynamicScore >= 54 ? '#ff9933' : d._dynamicScore >= 33 ? '#ffcc00' : '#00ff88';
        html += '<div class="detail__row"><span class="detail__label">DYNAMIC SCORE<br><span style="font-size:7px;color:#4a7da8;letter-spacing:0;font-weight:300">Baseline 55% · GDELT events 30% · Volatility 15%</span></span><span class="detail__value" style="color:' + dsCol + '">' + d._dynamicScore + ' / 100</span></div>';
        if (d._articleCount > 0) {
          html += '<div class="detail__row"><span class="detail__label">LIVE SIGNAL</span><span class="detail__value" style="color:#7ab8d4">' + d._articleCount + ' articles · event +' + (d._eventScore || 0) + ' · vol +' + (d._volatility || 0) + '</span></div>';
        }
      }
      // ── helpers ────────────────────────────────────────────────────────────
      function parseMoney(str) {
        if (!str) return null;
        var s = str.replace(/[$,\s]/g, '');
        var m = s.match(/^([\d.]+)([TBM]?)$/i);
        if (!m) return null;
        var v = parseFloat(m[1]);
        var u = m[2].toUpperCase();
        if (u === 'T') v *= 1e12; else if (u === 'B') v *= 1e9; else if (u === 'M') v *= 1e6;
        return v;
      }
      function fmtMoney(n) {
        if (n == null) return 'N/A';
        var abs = Math.abs(n);
        var s = abs >= 1e12 ? (abs/1e12).toFixed(2)+'T' : abs >= 1e9 ? (abs/1e9).toFixed(1)+'B' : (abs/1e6).toFixed(0)+'M';
        return (n < 0 ? '-' : '+') + '$' + s;
      }
      var SANCTIONS_DB = {
        RUS:{ label:'COMPREHENSIVE', detail:'OFAC · EU · UK (2022+)', col:'#ff0044' },
        IRN:{ label:'COMPREHENSIVE', detail:'OFAC primary sanctions (1979+)', col:'#ff0044' },
        SYR:{ label:'COMPREHENSIVE', detail:'OFAC · EU · UK (2004+)', col:'#ff0044' },
        PRK:{ label:'COMPREHENSIVE', detail:'UN · OFAC · EU', col:'#ff0044' },
        CUB:{ label:'EMBARGO',       detail:'OFAC CACR (1962+)', col:'#ff0044' },
        VEN:{ label:'SECTORAL',      detail:'OFAC · EU (2017+)', col:'#ff9933' },
        BLR:{ label:'SECTORAL',      detail:'EU · UK · US (2020+)', col:'#ff9933' },
        MMR:{ label:'SECTORAL',      detail:'OFAC · EU (2021+)', col:'#ff9933' },
        SDN:{ label:'TARGETED',      detail:'OFAC · UN arms embargo', col:'#ffcc00' },
        SSD:{ label:'ARMS EMBARGO',  detail:'UN (2018+)', col:'#ffcc00' },
        YEM:{ label:'TARGETED',      detail:'OFAC · UN', col:'#ffcc00' },
        IRQ:{ label:'TARGETED',      detail:'Historical OFAC — limited active', col:'#ffcc00' },
        AFG:{ label:'TARGETED',      detail:'Taliban entity designations', col:'#ffcc00' },
        LBY:{ label:'ARMS EMBARGO',  detail:'UN (2011+)', col:'#ffcc00' },
        SOM:{ label:'ARMS EMBARGO',  detail:'UN (2023+)', col:'#ffcc00' },
        ZWE:{ label:'TARGETED',      detail:'EU · US regime figures', col:'#ffcc00' },
        CHN:{ label:'TARGETED',      detail:'Entity list · chip export controls (2022+)', col:'#ffcc00' },
        NGA:{ label:'AML WATCH',     detail:'FATF monitoring — no active program', col:'#aaaaff' },
      };
      var TARIFF_DB = {
        CHN:{ label:'CRITICAL',  detail:'US tariffs 145% (2025) · EU antidumping', col:'#ff0044' },
        RUS:{ label:'CRITICAL',  detail:'G7 MFN revoked · de facto trade embargo', col:'#ff0044' },
        IRN:{ label:'CRITICAL',  detail:'Near-total trade prohibition under sanctions', col:'#ff0044' },
        USA:{ label:'HIGH',      detail:'Retaliatory tariffs from EU · China · Canada', col:'#ff9933' },
        IND:{ label:'ELEVATED',  detail:'High own tariff schedule · US reciprocal 2025', col:'#ffcc00' },
        TUR:{ label:'ELEVATED',  detail:'EU customs union partial · US steel tariffs', col:'#ffcc00' },
        CAN:{ label:'MODERATE',  detail:'USMCA · US steel/aluminum tariffs 2025', col:'#aaaaff' },
        MEX:{ label:'MODERATE',  detail:'USMCA · US tariff scrutiny 2025', col:'#aaaaff' },
        BRA:{ label:'MODERATE',  detail:'Mercosur common external tariff', col:'#aaaaff' },
        ARG:{ label:'MODERATE',  detail:'Mercosur + capital controls on trade', col:'#aaaaff' },
        VEN:{ label:'HIGH',      detail:'Sanctions limit access to trade finance', col:'#ff9933' },
        NLD:{ label:'LOW',       detail:'EU single market · major re-export hub', col:'#00ff88' },
        DEU:{ label:'LOW',       detail:'EU single market · WTO member in good standing', col:'#00ff88' },
        GBR:{ label:'LOW',       detail:'Post-Brexit bilateral deals · WTO schedules', col:'#00ff88' },
        SAU:{ label:'LOW',       detail:'GCC free trade · oil export exemptions', col:'#00ff88' },
        KOR:{ label:'LOW',       detail:'US-Korea FTA · strong bilateral ties', col:'#00ff88' },
        JPN:{ label:'LOW',       detail:'US-Japan trade framework · WTO schedules', col:'#00ff88' },
        AUS:{ label:'LOW',       detail:'AUSFTA · CPTPP member', col:'#00ff88' },
      };
      var GOV_RISK_DB = {
        RUS:{ label:'AUTHORITARIAN — NO FREE ELECTIONS', col:'#ff0044' },
        CHN:{ label:'ONE-PARTY — NO COMPETITIVE ELECTIONS', col:'#ff0044' },
        IRN:{ label:'THEOCRATIC — CONTROLLED ELECTIONS', col:'#ff0044' },
        PRK:{ label:'TOTALITARIAN — NO ELECTIONS', col:'#ff0044' },
        SYR:{ label:'CIVIL WAR — TRANSITIONAL GOVT', col:'#ff0044' },
        AFG:{ label:'AUTHORITARIAN — TALIBAN RULE', col:'#ff0044' },
        SOM:{ label:'FRAGILE — FEDERAL AUTHORITY LIMITED', col:'#ff0044' },
        VEN:{ label:'ELECTORAL FRAUD — CONTESTED GOVT (2024)', col:'#ff9933' },
        BLR:{ label:'AUTHORITARIAN — DISPUTED ELECTIONS', col:'#ff9933' },
        MMR:{ label:'MILITARY JUNTA — COUP 2021', col:'#ff9933' },
        SDN:{ label:'MILITARY CONFLICT — NO CENTRAL GOVT 2023+', col:'#ff0044' },
        BFA:{ label:'MILITARY JUNTA — COUP 2022', col:'#ff0044' },
        MLI:{ label:'MILITARY JUNTA — COUP 2021', col:'#ff0044' },
        NER:{ label:'MILITARY JUNTA — COUP 2023', col:'#ff0044' },
        CAF:{ label:'FRAGILE STATE — WAGNER INFLUENCE', col:'#ff0044' },
        SSD:{ label:'FRAGILE PEACE — CIVIL WAR RISK', col:'#ff9933' },
        YEM:{ label:'CIVIL WAR — NO CENTRAL GOVT', col:'#ff9933' },
        IRQ:{ label:'FRAGILE DEMOCRACY — MILITIA INFLUENCE', col:'#ff9933' },
        ETH:{ label:'POST-CONFLICT — TIGRAY INSTABILITY', col:'#ff9933' },
        NGA:{ label:'CONTESTED — GOV LEGITIMACY UNDER PRESSURE', col:'#ff9933' },
        TUR:{ label:'COMPETITIVE AUTHORITARIAN', col:'#ffcc00' },
        KAZ:{ label:'LIMITED DEMOCRATIC — POWER TRANSITION', col:'#ffcc00' },
        UKR:{ label:'WARTIME DEMOCRACY — MARTIAL LAW ACTIVE', col:'#ffcc00' },
        ROM:{ label:'WATCH — ELECTION DISPUTES 2024', col:'#ffcc00' },
        USA:{ label:'STABLE — INSTITUTIONAL PRESSURE 2025', col:'#aaffaa' },
        FRA:{ label:'STABLE — COALITION FRAGILITY', col:'#aaffaa' },
        GBR:{ label:'STABLE — PARLIAMENTARY ELECTION 2024', col:'#00ff88' },
        DEU:{ label:'STABLE — COALITION GOVT 2025', col:'#00ff88' },
        POL:{ label:'STABLE — DEMOCRATIC TRANSITION', col:'#aaffaa' },
      };

      // ── COUNTRY RISK RATING ─────────────────────────────────────────────────
      html += '<div class="detail__row"><span class="detail__label">COUNTRY RISK RATING</span><span class="detail__value" style="color:' + col + '">' + d.risk + ' &nbsp;<span style="font-size:10px;color:#4a7da8">' + d.score + ' / 100</span></span></div>';

      // ── POLITICAL STABILITY ──────────────────────────────────────────────────
      var stabLabel, stabCol;
      if      (d.score <= 20) { stabLabel = 'STABLE';               stabCol = '#00ff88'; }
      else if (d.score <= 35) { stabLabel = 'MODERATE';             stabCol = '#aaffaa'; }
      else if (d.score <= 50) { stabLabel = 'ELEVATED RISK';        stabCol = '#ffcc00'; }
      else if (d.score <= 65) { stabLabel = 'UNSTABLE';             stabCol = '#ff9933'; }
      else if (d.score <= 80) { stabLabel = 'HIGH INSTABILITY';     stabCol = '#ff4400'; }
      else                    { stabLabel = 'CRITICAL INSTABILITY';  stabCol = '#ff0044'; }
      html += '<div class="detail__row"><span class="detail__label">POLITICAL STABILITY</span><span class="detail__value" style="color:' + stabCol + '">' + stabLabel + '</span></div>';

      // ── SANCTIONS EXPOSURE ───────────────────────────────────────────────────
      var sanc = SANCTIONS_DB[d.code];
      if (sanc) {
        html += '<div class="detail__row"><span class="detail__label">SANCTIONS EXPOSURE<br><span style="font-size:7px;color:#4a7da8;font-weight:300">' + sanc.detail + '</span></span><span class="detail__value" style="color:' + sanc.col + '">' + sanc.label + '</span></div>';
      } else {
        html += '<div class="detail__row"><span class="detail__label">SANCTIONS EXPOSURE</span><span class="detail__value" style="color:#00ff88">NONE ACTIVE</span></div>';
      }

      // ── COUNTRY TRADE INDEX ──────────────────────────────────────────────────
      html += '<div class="detail__section-header">COUNTRY TRADE INDEX</div>';
      var expN = parseMoney(d.exports), impN = parseMoney(d.imports), gdpN = parseMoney(d.gdp);
      var bal    = (expN != null && impN != null) ? expN - impN : null;
      var balStr = bal != null ? fmtMoney(bal) + (bal >= 0 ? ' SURPLUS' : ' DEFICIT') : 'N/A';
      var balCol = bal == null ? '#4a7da8' : bal >= 0 ? '#00ff88' : '#ff9933';
      html += '<div class="detail__row"><span class="detail__label">BILATERAL TRADE BALANCE</span><span class="detail__value" style="color:' + balCol + '">' + balStr + '</span></div>';

      var openness = (expN != null && impN != null && gdpN && gdpN > 0) ? Math.round((expN + impN) / gdpN * 100) : null;
      var opLabel  = openness == null ? 'N/A' : openness + '% &nbsp;<span style="font-size:9px">' + (openness > 100 ? 'HIGHLY OPEN' : openness > 60 ? 'OPEN' : openness > 35 ? 'MODERATE' : 'CLOSED') + '</span>';
      var opCol    = openness == null ? '#4a7da8' : openness > 60 ? '#00ff88' : openness > 35 ? '#aaffaa' : '#ffcc00';
      html += '<div class="detail__row"><span class="detail__label">TRADE OPENNESS INDEX</span><span class="detail__value" style="color:' + opCol + '">' + opLabel + '</span></div>';

      var tariff    = TARIFF_DB[d.code];
      var tariffCol = tariff ? tariff.col : (d.risk === 'CRITICAL' ? '#ff9933' : d.risk === 'WARNING' ? '#ffcc00' : '#aaffaa');
      var tariffLbl = tariff ? tariff.label : (d.risk === 'CRITICAL' ? 'ELEVATED' : d.risk === 'WARNING' ? 'MODERATE' : 'LOW');
      var tariffSub = tariff ? '<br><span style="font-size:7px;color:#4a7da8;font-weight:300">' + tariff.detail + '</span>' : '';
      html += '<div class="detail__row"><span class="detail__label">TARIFF EXPOSURE' + tariffSub + '</span><span class="detail__value" style="color:' + tariffCol + '">' + tariffLbl + '</span></div>';

      // ── POLICY UNCERTAINTY ───────────────────────────────────────────────────
      html += '<div class="detail__section-header">POLICY UNCERTAINTY</div>';
      var fr       = window._fredData || {};
      var gepuStr  = fr.gepu != null
        ? Math.round(fr.gepu) + ' &nbsp;<span style="font-size:7px;color:#4a7da8">GLOBAL INDEX · ' + (fr.gepuDate || '—') + '</span>'
        : '<span style="color:#4a7da8">— LOADING —</span>';
      html += '<div class="detail__row"><span class="detail__label">GLOBAL EPU INDEX</span><span class="detail__value">' + gepuStr + '</span></div>';

      var regLbl = d.score > 70 ? 'HIGH' : d.score > 45 ? 'MODERATE' : 'LOW';
      var regCol = d.score > 70 ? '#ff9933' : d.score > 45 ? '#ffcc00' : '#00ff88';
      html += '<div class="detail__row"><span class="detail__label">REGULATORY RISK</span><span class="detail__value" style="color:' + regCol + '">' + regLbl + '</span></div>';

      var govRisk   = GOV_RISK_DB[d.code];
      var govLabel  = govRisk ? govRisk.label : (d.risk === 'CRITICAL' ? 'HIGH RISK' : d.risk === 'WARNING' ? 'ELEVATED' : 'LOW — STABLE GOVERNANCE');
      var govColor  = govRisk ? govRisk.col   : (d.risk === 'CRITICAL' ? '#ff9933'   : d.risk === 'WARNING' ? '#ffcc00'  : '#00ff88');
      html += '<div class="detail__row"><span class="detail__label">ELECTION / GOV RISK</span><span class="detail__value" style="color:' + govColor + ';font-size:9px">' + govLabel + '</span></div>';
      var oilProducers = ['SAU','RUS','IRN','NGA','USA','CAN','AUS','GBR'];
      if (oilProducers.indexOf(d.code) !== -1) {
        var prod = window._eiaProduction && window._eiaProduction[d.code];
        html += '<div class="detail__section-header" style="color:#ffcc00">ENERGY (EIA)</div>';
        if (prod) {
          html += '<div class="detail__row"><span class="detail__label">CRUDE PRODUCTION</span><span class="detail__value" style="color:#ffcc00">' + prod.value.toLocaleString() + ' TBPD</span></div>';
          html += '<div class="detail__row"><span class="detail__label">DATA PERIOD</span><span class="detail__value">' + prod.period + '</span></div>';
        } else {
          html += '<div class="detail__placeholder">Production data loading…</div>';
        }
      }

      // ── UN Humanitarian Status (ReliefWeb + UNHCR) ────────────────────────
      var rw = window.ArgusRW && window.ArgusRW.getCountryData(d.code);
      if (rw) {
        var rwCol = '#4da6ff'; // UN blue
        html += '<div class="detail__section-header" style="color:' + rwCol + '">UN HUMANITARIAN STATUS <span style="color:#2a4a6a;font-size:7px;font-weight:300;float:right">RELIEFWEB · UNHCR · OCHA</span></div>';

        // Active disasters
        if (rw.disasters && rw.disasters.length) {
          var crit = rw.disasters.filter(function(x) { return x.sev === 'CRITICAL'; }).length;
          var warn = rw.disasters.filter(function(x) { return x.sev === 'WARNING'; }).length;
          var sevStr = (crit ? '<span style="color:#ff0044">' + crit + ' CRITICAL</span> ' : '') +
                       (warn ? '<span style="color:#ff9933">' + warn + ' WARNING</span>' : '');
          html += '<div class="detail__row"><span class="detail__label">ACTIVE UN CRISES</span>' +
            '<span class="detail__value" style="font-size:11px">' + rw.disasters.length + ' &nbsp;' + sevStr + '</span></div>';

          // List each active crisis
          rw.disasters.slice(0, 4).forEach(function(dis) {
            var dCol = dis.sev === 'CRITICAL' ? '#ff0044' : dis.sev === 'WARNING' ? '#ff9933' : '#ffcc00';
            html += '<div style="padding:4px 0 3px;border-bottom:1px solid rgba(15,39,68,0.25)">' +
              '<div style="font-size:9px;color:' + dCol + ';font-weight:700;letter-spacing:1px">' +
              '◈ ' + dis.name.slice(0, 55) + '</div>' +
              '<div style="font-size:8px;color:#4a7da8;margin-top:1px">' +
              dis.types.slice(0,2).join(' · ') + (dis.date ? ' &nbsp;·&nbsp; ' + dis.date : '') +
              (dis.glide ? ' &nbsp;<span style="color:#2a4a68">' + dis.glide + '</span>' : '') +
              '</div></div>';
          });
          if (rw.disasters.length > 4) {
            html += '<div style="font-size:8px;color:#2a4a68;padding:3px 0">+ ' + (rw.disasters.length - 4) + ' more active crises</div>';
          }
        } else {
          html += '<div class="detail__row"><span class="detail__label">ACTIVE UN CRISES</span><span class="detail__value" style="color:#00ff88">NONE REGISTERED</span></div>';
        }

        // Displacement + refugee figures
        if (rw.refugees != null || rw.displaced != null) {
          html += '<div class="detail__section-header" style="color:' + rwCol + ';margin-top:10px">DISPLACEMENT (UNHCR 2023)</div>';
          if (rw.refugees != null) {
            html += '<div class="detail__row"><span class="detail__label">REFUGEES HOSTED</span><span class="detail__value" style="color:#ff9933">' +
              Number(rw.refugees).toLocaleString() + '</span></div>';
          }
          if (rw.displaced != null) {
            html += '<div class="detail__row"><span class="detail__label">INTERNAL DISPL. (IDPs)</span><span class="detail__value" style="color:#ff9933">' +
              Number(rw.displaced).toLocaleString() + '</span></div>';
          }
        }

        // Latest situation reports
        if (rw.sitreps && rw.sitreps.length) {
          html += '<div class="detail__section-header" style="color:' + rwCol + ';margin-top:10px">SITUATION REPORTS</div>';
          rw.sitreps.slice(0, 3).forEach(function(s) {
            var titleShort = s.title.length > 70 ? s.title.slice(0, 70) + '…' : s.title;
            html += '<div style="padding:4px 0 3px;border-bottom:1px solid rgba(15,39,68,0.25)">' +
              '<div style="font-size:9px;color:#c5d7e8;line-height:1.5">' + titleShort + '</div>' +
              '<div style="display:flex;justify-content:space-between;margin-top:2px">' +
                '<span style="font-size:7px;letter-spacing:1px;color:#4a7da8">' + (s.src || 'UN') + '</span>' +
                '<span style="font-size:7px;color:#2a4a68">' + (s.date || '') + '</span>' +
              '</div>' +
              (s.url ? '<a href="' + s.url + '" target="_blank" rel="noopener" onclick="event.stopPropagation()" ' +
                'style="font-size:7px;color:#4da6ff;text-decoration:underline;display:block;margin-top:2px">↗ READ FULL REPORT</a>' : '') +
            '</div>';
          });
        }

        // Attribution
        html += '<div style="font-size:7px;color:#1a3a58;margin-top:6px;letter-spacing:1px">DATA · UN OCHA RELIEFWEB · UNHCR POPULATION STATISTICS</div>';

      } else {
        // UN data not yet loaded — async check
        html += '<div class="detail__section-header" style="color:#4da6ff">UN HUMANITARIAN STATUS</div>';
        html += '<div class="detail__placeholder">AWAITING UN DATA FEED…</div>';
      }
    } else {
      [['VESSEL TRAFFIC', d.traffic], ['TRADE VOLUME', d.volume]].forEach(function(kv) {
        html += '<div class="detail__row"><span class="detail__label">' + kv[0] + '</span><span class="detail__value">' + kv[1] + '</span></div>';
      });
      html += '<div class="detail__status-box" style="background:' + (RB[d.risk] || '') + ';border-color:' + col + '44">' +
        '<div class="detail__label" style="color:' + col + ';margin-bottom:5px">CURRENT STATUS</div>' +
        '<div style="font-size:11px;line-height:1.7">' + d.status + '</div></div>';
      var pw = window._portData && window._portData[d.id];
      if (pw) {
        var dateStr = pw.year + '-' + String(pw.month).padStart(2,'0') + '-' + String(pw.day).padStart(2,'0');
        var fmt = function(v) { return (v == null || v === '') ? '—' : Number(v).toLocaleString(); };
        html += '<div class="detail__section-header" style="color:#0099ff">LIVE PORT DATA <span style="color:#4a7da8;font-size:8px;font-weight:300;float:right">' + (pw.portname || '') + ' · ' + dateStr + '</span></div>';
        [['TOTAL PORT CALLS',fmt(pw.portcalls),'#00ff88'],['CONTAINER VESSELS',fmt(pw.portcalls_container),''],
         ['TANKERS',fmt(pw.portcalls_tanker),''],['DRY BULK',fmt(pw.portcalls_dry_bulk),''],
         ['IMPORTS (vessels)',fmt(pw.import),''],['EXPORTS (vessels)',fmt(pw.export),'']].forEach(function(row) {
          html += '<div class="detail__row"><span class="detail__label">' + row[0] + '</span><span class="detail__value"' + (row[2] ? ' style="color:' + row[2] + '"' : '') + '>' + row[1] + '</span></div>';
        });
      } else {
        html += '<div class="detail__placeholder" style="margin-top:10px">PORT WATCH DATA LOADING…</div>';
      }
      var energyCPs = ['hormuz','bab_cp','suez','bosphorus'];
      if (energyCPs.indexOf(d.id) !== -1 && window._eiaData) {
        var fmt2 = function(v) { return v != null ? '$' + parseFloat(v).toFixed(2) + '/bbl' : '—'; };
        html += '<div class="detail__section-header" style="color:#ffcc00">ENERGY PRICES (EIA)</div>';
        html += '<div class="detail__row"><span class="detail__label">BRENT CRUDE</span><span class="detail__value" style="color:#ffcc00">' + fmt2(window._eiaData.brent) + '</span></div>';
        html += '<div class="detail__row"><span class="detail__label">WTI CRUDE</span><span class="detail__value" style="color:#ffcc00">' + fmt2(window._eiaData.wti) + '</span></div>';
        html += '<div style="font-size:8px;color:#4a7da8;margin-top:4px">As of ' + (window._eiaData.brentDate || '—') + ' · EIA</div>';
      }
    }
    var bodyEl = document.getElementById('detail-body');
    bodyEl.innerHTML = html;
    openDetail(col);

    // Cipher decode header, stagger body rows
    ArgusAnim.cipherDecode(tagEl,  tagLabel, 320);
    ArgusAnim.cipherDecode(nameEl, d.label,  560);
    ArgusAnim.cipherDecode(badge,  d.risk,   260);
    ArgusAnim.staggerRows(bodyEl);
  }

  // ── Panel minimize ────────────────────────────────────────────────────────
  var PANEL_IDS = ['events', 'market'];

  function togglePanel(id) {
    var panel = document.getElementById('panel-' + id);
    var btn   = document.getElementById('min-btn-' + id);
    if (!panel) return;
    var minimized = panel.classList.toggle('is-minimized');
    if (btn) btn.textContent = minimized ? '+' : '—';
    localStorage.setItem('argus_panel_' + id, minimized ? '1' : '0');
  }

  // Restore panel state on load
  PANEL_IDS.forEach(function(id) {
    if (localStorage.getItem('argus_panel_' + id) === '1') {
      var panel = document.getElementById('panel-' + id);
      var btn   = document.getElementById('min-btn-' + id);
      if (panel) panel.classList.add('is-minimized');
      if (btn)   btn.textContent = '+';
    }
  });

  return { toggleAI: toggleAI, togglePanel: togglePanel, setSuggestion: setSuggestion, closeDetail: closeDetail, showEventDetail: showEventDetail, showStaticDetail: showStaticDetail, showUpgradePrompt: showUpgradePrompt };

})(); // end ArgusUI

// ════════════════════════════════════════════════════════════════════════════
// ArgusUpgrade — Stripe Checkout flow
// ════════════════════════════════════════════════════════════════════════════
window.ArgusUpgrade = (function() {
  'use strict';

  function startCheckout() {
    var sess   = window.ArgusSession;
    var userId = sess && sess.userId;
    var email  = sess && sess.email;

    // Guard: must be logged in
    if (!userId || !email) {
      alert('Please sign in before upgrading.');
      return;
    }

    // Already pro/admin/owner — nothing to do
    var tier = sess.tier || 'viewer';
    if (tier === 'pro' || tier === 'admin' || tier === 'owner') {
      alert('Your account already has Pro access.');
      return;
    }

    var btn = document.getElementById('upgrade-cta-btn');
    if (btn) { btn.textContent = 'REDIRECTING…'; btn.style.opacity = '0.6'; btn.disabled = true; }

    fetch('/.netlify/functions/create-checkout-session', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ userId: userId, email: email }),
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.url) {
        window.location.href = data.url;
      } else {
        throw new Error(data.error || 'No checkout URL returned');
      }
    })
    .catch(function(err) {
      console.error('ArgusUpgrade: checkout failed:', err.message);
      if (btn) { btn.textContent = 'UPGRADE TO PRO →'; btn.style.opacity = ''; btn.disabled = false; }
      alert('Checkout failed — please try again.\n' + err.message);
    });
  }

  return { startCheckout: startCheckout };
})(); // end ArgusUpgrade

// ════════════════════════════════════════════════════════════════════════════
// ArgusAI — chat with live data context
// ════════════════════════════════════════════════════════════════════════════
window.ArgusAI = (function() {

  var messagesEl = document.getElementById('ai-messages');

  function addMessage(role, text, noAnim) {
    var col = role === 'user' ? '#0099ff' : '#00ff88';
    var lbl = role === 'user' ? 'ANALYST' : 'ARGUS';
    var div = document.createElement('div');
    div.className = 'ai__message ai__message--' + (role === 'user' ? 'user' : 'bot');
    var whoDiv = document.createElement('div');
    whoDiv.className = 'ai__message-who';
    whoDiv.style.color = col;
    whoDiv.textContent = lbl;
    div.appendChild(whoDiv);
    var bodyDiv = document.createElement('div');
    div.appendChild(bodyDiv);
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    if (noAnim || role === 'user') {
      bodyDiv.innerHTML = text;
    } else {
      // Typewriter for bot messages
      ArgusAnim.typewriter(bodyDiv, text, 252);
    }
    return div;
  }

  function addThinking() {
    var div = document.createElement('div');
    div.className = 'ai__message ai__message--bot';
    div.innerHTML =
      '<div class="ai__message-who" style="color:#00ff88">ARGUS</div>' +
      '<div class="argus-thinking" aria-label="Processing">' +
        '<span></span><span></span><span></span>' +
      '</div>';
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  addMessage('bot', 'ARGUS online. Live trade flow data, risk assessments, and geopolitical event feeds loaded. What would you like to analyze?', true);

  async function sendMessage() {
    var inp = document.getElementById('ai-input');
    var q   = inp.value.trim();
    if (!q) return;
    inp.value = '';
    addMessage('user', q);
    var thinking = addThinking();
    var snapshot = ArgusData.buildSnapshot();

    // ── Part A: inject all live ARGUS context beyond the market snapshot ──
    var liveContext = '';

    // GDELT events currently loaded
    var gdeltData = window.gdelt && window.gdelt.getData ? window.gdelt.getData() : null;
    if (gdeltData && gdeltData.events && gdeltData.events.length) {
      liveContext += '\n--- GDELT LIVE EVENTS (past 48h) ---\n';
      gdeltData.events.slice(0, 15).forEach(function(e) {
        liveContext += '• [' + (e.category || 'EVENT').toUpperCase() + '] ' + e.title;
        if (e.tone != null) liveContext += ' (tone: ' + parseFloat(e.tone).toFixed(1) + ')';
        if (e.domain) liveContext += ' [' + e.domain + ']';
        liveContext += '\n';
      });
      if (gdeltData.tones) {
        var topTones = Object.keys(gdeltData.tones).sort(function(a,b) {
          return gdeltData.tones[a] - gdeltData.tones[b];
        }).slice(0, 5);
        liveContext += 'Most negative tone countries: ' + topTones.join(', ') + '\n';
      }
    }

    // USGS seismic events
    var usgsEvents = window._usgsEvents || [];
    if (usgsEvents.length) {
      liveContext += '\n--- USGS SEISMIC ACTIVITY ---\n';
      usgsEvents.slice(0, 8).forEach(function(e) {
        liveContext += '• [' + e.severity + '] ' + e.title + ' (' + e.pubDate + ')\n';
      });
    }

    // Live news events from NewsData
    var newsEvents = (window._currentEvents || []).filter(function(e) { return e.id < 9000; });
    if (newsEvents.length) {
      liveContext += '\n--- LIVE NEWS INTELLIGENCE ---\n';
      newsEvents.slice(0, 10).forEach(function(e) {
        liveContext += '• [' + e.severity + '] ' + e.title;
        if (e.region) liveContext += ' | ' + e.region;
        liveContext += '\n';
      });
    }

    // NASA FIRMS active wildfire clusters
    var fireEvents = window._fireEvents || [];
    if (fireEvents.length) {
      liveContext += '\n--- NASA FIRMS ACTIVE WILDFIRES ---\n';
      fireEvents.slice(0, 8).forEach(function(e) {
        liveContext += '• [' + (e.severity || 'WATCH') + '] ' + e.title + '\n';
      });
    }

    // Live vessel traffic by region
    var vesselList = window._vesselMap ? Array.from(window._vesselMap.values()) : [];
    if (vesselList.length) {
      var vRegions = {};
      vesselList.forEach(function(v){ vRegions[v.region||'GLOBAL'] = (vRegions[v.region||'GLOBAL']||0)+1; });
      liveContext += '\n--- LIVE VESSEL TRAFFIC (' + vesselList.length + ' vessels) ---\n';
      Object.keys(vRegions).sort(function(a,b){ return vRegions[b]-vRegions[a]; }).forEach(function(r) {
        liveContext += '• ' + r + ': ' + vRegions[r] + ' vessels\n';
      });
    }

    // Live aircraft traffic by corridor
    try {
      var acRaw = localStorage.getItem('argus_traffic_v4');
      if (acRaw) {
        var acList = JSON.parse(acRaw);
        if (Array.isArray(acList) && acList.length) {
          var acCors = {};
          acList.forEach(function(ac){ acCors[ac.corridor||'UNKNOWN'] = (acCors[ac.corridor||'UNKNOWN']||0)+1; });
          liveContext += '\n--- LIVE AIR TRAFFIC (' + acList.length + ' aircraft) ---\n';
          Object.keys(acCors).sort(function(a,b){ return acCors[b]-acCors[a]; }).slice(0, 6).forEach(function(c) {
            liveContext += '• ' + c + ': ' + acCors[c] + ' aircraft\n';
          });
        }
      }
    } catch(_){}

    // Chokepoint scores from GDELT analysis
    if (gdeltData && gdeltData.chokeScores && Object.keys(gdeltData.chokeScores).length) {
      liveContext += '\n--- CHOKEPOINT RISK SCORES (GDELT-derived) ---\n';
      Object.keys(gdeltData.chokeScores).forEach(function(k) {
        liveContext += k.toUpperCase() + ': score ' + gdeltData.chokeScores[k] + '\n';
      });
    }

    var sys = 'You are ARGUS, an advanced supply chain intelligence AI serving government policy analysts and strategic planners.\n' +
      'You have access to live intelligence data from multiple sources loaded in the ARGUS platform.\n' +
      'You also have web search capability — use it when the snapshot lacks sufficient context, when asked about recent events, or when the user asks something beyond the current data.\n\n' +
      'LIVE INTELLIGENCE SNAPSHOT:\n' + snapshot +
      (liveContext ? '\nLIVE FEED DATA:\n' + liveContext : '') +
      '\n\nINSTRUCTIONS:\n' +
      '- Cite specific figures from the snapshot when relevant\n' +
      '- Use web search for current events, recent developments, or anything not in the snapshot\n' +
      '- Be concise, authoritative, and intelligence-focused\n' +
      '- Connect data points across sources to form assessments\n' +
      '- Max 300 words unless a detailed briefing is requested';
    var history = [];
    messagesEl.querySelectorAll('.ai__message').forEach(function(m) {
      var role    = m.classList.contains('ai__message--user') ? 'user' : 'assistant';
      var last    = m.childNodes[m.childNodes.length - 1];
      var content = last ? last.textContent : '';
      if (content && !m.querySelector('.argus-thinking')) history.push({ role: role, content: content });
    });
    try {
      var res = await fetch('/.netlify/functions/ai-query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id:    window.ArgusUID || 'anon-' + Date.now(),
          auth_token: window.ArgusSession && window.ArgusSession.token || null,
          payload: {
            model:      'claude-sonnet-4-6',
            max_tokens: 1024,
            system:     sys,
            messages:   history.concat([{ role: 'user', content: q }])
          }
        })
      });
      // Surface rate limit / cap errors as readable messages rather than crashes
      if (res.status === 429) {
        var limitErr = await res.json().catch(function() { return {}; });
        var limitMsg = limitErr.error || 'Query limit reached';
        thinking.remove();
        addMessage('bot', '\u26A0 ' + limitMsg);
        return;
      }
      if (!res.ok) throw new Error('API ' + res.status);
      var data  = await res.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      // Extract all text blocks — Claude may return tool_use + text blocks when searching
      var reply = '';
      if (data.content && Array.isArray(data.content)) {
        data.content.forEach(function(block) {
          if (block.type === 'text' && block.text) reply += block.text;
        });
      }
      if (!reply) reply = 'No response received.';
      thinking.remove();
      addMessage('bot', reply);
    } catch(err) {
      thinking.remove();
      addMessage('bot', '⚠ Network error. Static fallback: Bab-el-Mandeb and Suez remain CRITICAL with active Houthi operations. Panama transit times +30% due to drought conditions.');
    }
  }

  return { sendMessage: sendMessage };

})(); // end ArgusAI

// ════════════════════════════════════════════════════════════════════════════
// Clock — local timezone, updates every second
// ════════════════════════════════════════════════════════════════════════════
(function initClock() {
  var tz   = Intl.DateTimeFormat().resolvedOptions().timeZone;
  var abbr = new Date().toLocaleTimeString('en-US', { timeZone: tz, timeZoneName: 'short' }).split(' ').pop();
  document.getElementById('tz-label').textContent = abbr;
  function tick() {
    document.getElementById('utc-display').textContent = new Date().toLocaleTimeString('en-US', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
  }
  tick();
  setInterval(tick, 1000);
})();

// ════════════════════════════════════════════════════════════════════════════
// ArgusEvents — event command strip: geocode, plot, feed mode
// ════════════════════════════════════════════════════════════════════════════
window.ArgusEvents = (function() {

  var SEV_COLORS = { CRITICAL: 0xff0044, WARNING: 0xff9933, WATCH: 0xffcc00, LOW: 0x00ff88 };
  var SEV_HEX    = { CRITICAL: '#ff0044', WARNING: '#ff9933', WATCH: '#ffcc00', LOW: '#00ff88' };
  var manualPins = [];
  var feedActive = false;
  var trayOpen   = false;
  var trayEvents = [];

  // ── Nominatim geocoder — free, no key, OpenStreetMap ──────────────────────
  function geocode(query) {
    var url = 'https://nominatim.openstreetmap.org/search?q=' +
      encodeURIComponent(query) + '&format=json&limit=1';
    return fetch(url, { headers: { 'Accept-Language': 'en', 'User-Agent': 'ArgusIntel/1.0' } })
      .then(function(r) { return r.json(); })
      .then(function(results) {
        if (!results || !results.length) throw new Error('Location not found: ' + query);
        return { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon), name: results[0].display_name };
      });
  }

  // ── Classify event from text ──────────────────────────────────────────────
  function classify(text) {
    var t = text.toLowerCase();
    var type = window.argusClassifyType ? window.argusClassifyType(t) : 'POLICY';
    var sev = 'WATCH';
    if (/critical|emergency|crisis|catastrophic|imminent|escalat/i.test(t)) sev = 'CRITICAL';
    else if (/major|severe|warning|significant|offensive/i.test(t)) sev = 'WARNING';
    else if (/low|minor|stable/i.test(t)) sev = 'LOW';
    return { type: type, severity: sev };
  }

  // ── Plot a pin on the globe ───────────────────────────────────────────────
  function plotPin(lat, lon, data) {
    var AG = window.ArgusGlobe;
    if (!AG || !AG.eventMarkerGroup || !AG.latLonToVector) return;

    var pos = AG.latLonToVector(lat, lon, R.EVENT);
    var col = SEV_COLORS[data.severity] || 0x00ccff;

    var mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1.68, 16, 16),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.54 })
    );
    mesh.position.copy(pos);
    mesh.userData = {
      _manualPin: true,
      type:     data.type,
      severity: data.severity,
      title:    data.title || data.location,
      impact:   data.impact || 'User-plotted event. Click for details.',
      source:   data.source || 'MANUAL',
    };
    AG.eventMarkerGroup.add(mesh);
    window.eventMarkers.push(mesh);

    var ring = new THREE.Mesh(
      new THREE.RingGeometry(2.8, 4.2, 32),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.4, side: THREE.DoubleSide })
    );
    ring.position.copy(pos);
    ring.lookAt(pos.clone().normalize().multiplyScalar(200));
    ring.userData = { isPulseRing: true, phase: Math.random() * Math.PI * 2, _manualPin: true };
    AG.eventMarkerGroup.add(ring);

    manualPins.push({ mesh: mesh, ring: ring, data: data });
    if (typeof window.updateNodeCounts === 'function') window.updateNodeCounts();
  }

  // ── Public: plot from input ───────────────────────────────────────────────
  function plot(input) {
    if (!input || !input.trim()) return;
    var inp = document.getElementById('event-strip-input');
    if (inp) inp.value = '';

    // Parse: "EVENT TYPE: location — description" or just "location"
    var parts = input.split('—');
    var locationPart = (parts[0] || input).replace(/^(conflict|disaster|policy|cyber|economic):\s*/i, '').trim();
    var descPart     = (parts[1] || '').trim();
    var cls = classify(input);

    var label = document.getElementById('event-strip-label');
    if (label) label.textContent = '◈ GEOCODING…';

    geocode(locationPart)
      .then(function(geo) {
        var shortName = locationPart;
        var evTitle   = shortName.slice(0, 60);
        var sess = null;
        try { sess = JSON.parse(localStorage.getItem('argus_session')); } catch(e) {}
        var token = (sess && sess.access_token) || SUPA_ANON_GDELT;
        fetch('https://wbvzlxtroewxrmonxodx.supabase.co/rest/v1/argus_event_queue', {
          method: 'POST',
          headers: {
            'apikey': SUPA_ANON_GDELT,
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({
            source:    'MANUAL',
            category:  cls.type,
            status:    'pending',
            timestamp: new Date().toISOString(),
            location:  { lat: geo.lat, lon: geo.lon, country: shortName },
            data:      { title: evTitle, severity: cls.severity, type: cls.type,
                         impact: descPart || ('Event at ' + shortName + '. Type: ' + cls.type + '.') }
          })
        })
        .then(function(r) {
          if (label) label.textContent = r.ok ? '◈ PENDING REVIEW' : '◈ SUBMIT FAILED';
          setTimeout(function() { if (label) label.textContent = '◈ EVENT INTEL'; }, 3500);
          if (r.ok) console.log('ArgusEvents: submitted to review queue —', evTitle, geo.lat, geo.lon);
        })
        .catch(function() {
          if (label) { label.textContent = '◈ SUBMIT FAILED'; setTimeout(function() { label.textContent = '◈ EVENT INTEL'; }, 2500); }
        });
      })
      .catch(function(err) {
        if (label) label.textContent = '◈ NOT FOUND';
        setTimeout(function() { if (label) label.textContent = '◈ EVENT INTEL'; }, 2000);
        console.warn('ArgusEvents geocode failed:', err.message);
      });
  }

  // ── Feed mode — pull from existing GDELT/news events and plot unplotted ones ─
  function toggleFeed() {
    feedActive = !feedActive;
    var btn   = document.getElementById('es-btn-feed');
    var strip = document.getElementById('event-strip');
    if (btn)   btn.classList.toggle('is-active', feedActive);
    if (strip) strip.classList.toggle('is-active', feedActive);
    if (feedActive) runFeed();
  }

  function runFeed() {
    if (!feedActive) return;
    var gdeltEvents = window.gdelt && window.gdelt.getData && window.gdelt.getData().events || [];
    gdeltEvents.forEach(function(ev) {
      if (!ev.url || !ev.title) return;
      // Only plot actionable severity — exclude LOW (green) events
      if (ev.severity === 'LOW') return;
      var existing = manualPins.find(function(p) { return p.data.title === ev.title; });
      if (existing) return;
      // Resolve coordinates via country-marker centroid fallback
      var geo = null;
      if (ev.country) {
        var countryMarker = window.countryMarkers && window.countryMarkers.find(function(m) {
          return m.userData && m.userData.code === ev.country;
        });
        if (countryMarker) {
          var ud = countryMarker.userData;
          geo = { lat: ud.rawLat, lon: ud.rawLon };
        }
      }
      if (!geo) return; // no confirmed location — never plot
      var data = {
        type: ev.type, severity: ev.severity,
        title: ev.title.slice(0, 60),
        lat: geo.lat, lon: geo.lon,
        impact: 'GDELT feed event. Tone: ' + (ev.tone ? ev.tone.toFixed(2) : 'N/A'),
        source: 'GDELT'
      };
      plotPin(geo.lat, geo.lon, data);
      addToTray(data);
    });
    setTimeout(runFeed, 60000);
  }

  // ── Tray management ───────────────────────────────────────────────────────
  function addToTray(data) {
    trayEvents.unshift(data);
    if (trayEvents.length > 30) trayEvents.pop();
    renderTray();
  }

  function renderTray() {
    var tray = document.getElementById('event-strip-tray');
    if (!tray) return;
    if (!trayEvents.length) {
      tray.innerHTML = '<div class="es-empty">NO EVENTS PLOTTED YET</div>';
      return;
    }
    tray.innerHTML = trayEvents.map(function(ev, i) {
      var col = SEV_HEX[ev.severity] || '#00ccff';
      var hasLink = ev.link || ev.url;
      return '<div class="es-event">' +
        '<div class="es-dot" style="background:' + col + ';box-shadow:0 0 4px ' + col + ';flex-shrink:0;margin-top:4px"></div>' +
        '<div style="flex:1;min-width:0">' +
          '<div class="es-title" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (ev.title || ev.location) + '</div>' +
          '<div class="es-meta">' + ev.type + ' · ' + ev.severity +
            (ev.lat ? ' · ' + parseFloat(ev.lat).toFixed(2) + '°, ' + parseFloat(ev.lon).toFixed(2) + '°' : '') +
          '</div>' +
        '</div>' +
        '<div class="es-event-actions">' +
          '<button class="es-action-btn detail" onclick="event.stopPropagation();ArgusEvents.focusEvent(' + i + ')" title="Show detail panel">DETAIL</button>' +
          (hasLink ? '<a href="' + (ev.link || ev.url) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()" ' +
            'style="text-decoration:none"><button class="es-action-btn detail" title="Open source">↗</button></a>' : '') +
          '<button class="es-action-btn delete" onclick="event.stopPropagation();ArgusEvents.deleteEvent(' + i + ')" title="Remove event">✕</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function toggleTray() {
    trayOpen = !trayOpen;
    var tray  = document.getElementById('event-strip-tray');
    var btn   = document.getElementById('es-btn-events');
    var strip = document.getElementById('event-strip');
    if (tray)  tray.classList.toggle('is-open', trayOpen);
    if (btn)   btn.classList.toggle('is-active', trayOpen);
    if (strip) strip.classList.toggle('is-active', trayOpen);
    if (trayOpen) renderTray();
  }

  function focusEvent(idx) {
    var ev = trayEvents[idx];
    if (!ev || !ev.lat) return;
    // Rotate globe to face the event — find the pin and trigger detail panel
    var pin = manualPins.find(function(p) { return p.data.title === ev.title; });
    if (pin && typeof ArgusUI !== 'undefined') {
      ArgusUI.showEventDetail({ type: ev.type, severity: ev.severity, title: ev.title, impact: ev.impact });
    }
  }

  function deleteEvent(idx) {
    var ev = trayEvents[idx];
    if (!ev) return;
    // Remove matching globe pin
    var pinIdx = manualPins.findIndex(function(p) { return p.data.title === ev.title && p.data.lat === ev.lat; });
    if (pinIdx !== -1) {
      var AG = window.ArgusGlobe;
      if (AG && AG.eventMarkerGroup) {
        AG.eventMarkerGroup.remove(manualPins[pinIdx].mesh);
        AG.eventMarkerGroup.remove(manualPins[pinIdx].ring);
      }
      window.eventMarkers = window.eventMarkers.filter(function(m) { return m !== manualPins[pinIdx].mesh; });
      manualPins.splice(pinIdx, 1);
    }
    trayEvents.splice(idx, 1);
    renderTray();
    if (typeof window.updateNodeCounts === 'function') window.updateNodeCounts();
  }

  function clearAll() {
    var AG = window.ArgusGlobe;
    if (AG && AG.eventMarkerGroup) {
      manualPins.forEach(function(p) {
        AG.eventMarkerGroup.remove(p.mesh);
        AG.eventMarkerGroup.remove(p.ring);
      });
    }
    window.eventMarkers = window.eventMarkers.filter(function(m) { return !m.userData._manualPin; });
    manualPins = [];
    trayEvents = [];
    renderTray();
    if (typeof window.updateNodeCounts === 'function') window.updateNodeCounts();
  }

  // ── Modal ─────────────────────────────────────────────────────────────────
  function checkFormReady() {
    var title = (document.getElementById('es-m-title')    ? document.getElementById('es-m-title').value    : '').trim();
    var link  = (document.getElementById('es-m-link')     ? document.getElementById('es-m-link').value     : '').trim();
    var loc   = (document.getElementById('es-m-location') ? document.getElementById('es-m-location').value : '').trim();
    var tags  = (document.getElementById('es-m-tag')      ? document.getElementById('es-m-tag').value      : '').trim();
    var desc  = (document.getElementById('es-m-impact')   ? document.getElementById('es-m-impact').value   : '').trim();
    var btn   = document.getElementById('es-submit-btn');
    if (btn) btn.disabled = !(title && link && loc && tags && desc);
  }

  function openModal() {
    var titleEl = document.getElementById('es-m-title');
    document.getElementById('es-modal-overlay').classList.add('is-open');
    checkFormReady();
    if (titleEl) setTimeout(function() { titleEl.focus(); }, 50);
  }

  function closeModal() {
    document.getElementById('es-modal-overlay').classList.remove('is-open');
    // Restore event marker visibility to whatever the layer state says
    var evOn = !window.ArgusLayerState || window.ArgusLayerState.events;
    if (window.eventMarkers) window.eventMarkers.forEach(function(m) { m.visible = evOn; });
  }

  // ── Community Intel: Supabase helpers ────────────────────────────────────────
  var CI_SUPA_URL        = 'https://wbvzlxtroewxrmonxodx.supabase.co';
  var CI_VOTES_THRESHOLD = 20;

  function ciToken() {
    var s = null;
    try { s = JSON.parse(localStorage.getItem('argus_session')); } catch(e) {}
    return (s && s.access_token) || SUPA_ANON_GDELT;
  }

  function ciFetch(path, opts) {
    var hdrs = Object.assign({
      'apikey':        SUPA_ANON_GDELT,
      'Authorization': 'Bearer ' + ciToken(),
      'Content-Type':  'application/json'
    }, (opts && opts.headers) || {});
    return fetch(CI_SUPA_URL + path, Object.assign({}, opts || {}, { headers: hdrs }));
  }

  function parseNotes(raw) {
    if (!raw) return { description: '', tags: '', votes_up: 0, votes_down: 0, promoted: false };
    try {
      var p = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return {
        description: p.description || '',
        tags:        p.tags        || '',
        votes_up:    parseInt(p.votes_up)   || 0,
        votes_down:  parseInt(p.votes_down) || 0,
        promoted:    !!p.promoted
      };
    } catch(e) { return { description: String(raw), tags: '', votes_up: 0, votes_down: 0, promoted: false }; }
  }

  function esc(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  function getMyVote(id) {
    try { return localStorage.getItem('argus_ci_myvote_' + id) || null; } catch(e) { return null; }
  }
  function setMyVote(id, dir) {
    try { localStorage.setItem('argus_ci_myvote_' + id, dir); } catch(e) {}
  }

  // ── Submit modal ──────────────────────────────────────────────────────────────
  function submitModal() {
    var title    = (document.getElementById('es-m-title').value    || '').trim();
    var link     = (document.getElementById('es-m-link')    ? document.getElementById('es-m-link').value    : '').trim();
    var location = (document.getElementById('es-m-location').value || '').trim();
    var tags     = (document.getElementById('es-m-tag').value      || '').trim();
    var category =  document.getElementById('es-m-type').value;
    var desc     = (document.getElementById('es-m-impact').value   || '').trim();

    // Validate all required fields
    var valid = true;
    [['es-m-title', title], ['es-m-link', link], ['es-m-location', location], ['es-m-tag', tags], ['es-m-impact', desc]].forEach(function(pair) {
      if (!pair[1]) {
        valid = false;
        var el = document.getElementById(pair[0]);
        if (el) { el.style.borderColor = '#ff0044'; setTimeout(function() { el.style.borderColor = ''; }, 1800); }
      }
    });
    if (!valid) return;

    // Ensure link has protocol
    if (!/^https?:\/\//i.test(link)) link = 'https://' + link;

    closeModal();

    var email = window.ArgusSession ? window.ArgusSession.email : null;
    var notesObj = { description: desc, tags: tags, votes_up: 0, votes_down: 0, promoted: false };

    ciFetch('/rest/v1/argus_analyst_requests', {
      method: 'POST',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        title:        title.slice(0, 120),
        category:     category,
        location:     location,
        source_url:   link,
        notes:        JSON.stringify(notesObj),
        submitted_by: email || 'community',
        status:       'community'
      })
    })
    .then(function(r) {
      if (!r.ok) return r.text().then(function(t) { throw new Error('HTTP ' + r.status + ' — ' + t); });
      var toast = document.getElementById('eq-submit-toast');
      if (toast) { toast.classList.add('is-visible'); setTimeout(function() { toast.classList.remove('is-visible'); }, 4000); }
      ['es-m-title','es-m-link','es-m-location','es-m-tag','es-m-impact'].forEach(function(fid) {
        var el = document.getElementById(fid); if (el) el.value = '';
      });
      if (document.getElementById('es-m-type')) document.getElementById('es-m-type').value = 'POLICY';
      var submitBtn = document.getElementById('es-submit-btn'); if (submitBtn) submitBtn.disabled = true;
      setFeedView('community');
    })
    .catch(function(e) {
      console.warn('ArgusEvents: community intel submit failed:', e.message);
    });
  }

  // ── Community Intel: feed view toggle ────────────────────────────────────────
  function setFeedView(view) {
    window._intelFeedView = view;
    var evList = document.getElementById('ev-list');
    var ciList = document.getElementById('ci-list');
    var btnV   = document.getElementById('itb-verified');
    var btnC   = document.getElementById('itb-community');
    if (view === 'community') {
      if (evList) evList.style.display = 'none';
      if (ciList) ciList.style.display = 'block';
      if (btnV) btnV.classList.remove('active');
      if (btnC) btnC.classList.add('active');
      loadCommunityIntel();
    } else {
      if (evList) evList.style.display = '';
      if (ciList) ciList.style.display = 'none';
      if (btnV) btnV.classList.add('active');
      if (btnC) btnC.classList.remove('active');
    }
  }

  // ── Community Intel: load from Supabase ──────────────────────────────────────
  function loadCommunityIntel() {
    var ciList = document.getElementById('ci-list');
    if (ciList) ciList.innerHTML = '<div id="ci-empty">LOADING...</div>';
    ciFetch('/rest/v1/argus_analyst_requests?select=*&status=eq.community&order=created_at.desc&limit=60')
    .then(function(r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
    .then(function(rows) { window._ciRows = rows; renderCommunityIntel(rows); })
    .catch(function(e) {
      var el = document.getElementById('ci-list');
      if (el) el.innerHTML = '<div id="ci-empty">LOAD FAILED — ' + esc(e.message.toUpperCase()) + '</div>';
    });
  }

  // ── Community Intel: render cards ────────────────────────────────────────────
  function renderCommunityIntel(rows) {
    var ciList = document.getElementById('ci-list');
    if (!ciList) return;
    if (!rows || !rows.length) {
      ciList.innerHTML = '<div id="ci-empty">NO COMMUNITY INTEL YET<br>USE ⊕ ADD INTELLIGENCE TO CONTRIBUTE</div>';
      return;
    }
    var html = '';
    rows.forEach(function(row) {
      var n       = parseNotes(row.notes);
      var myVote  = getMyVote(row.id);
      var total   = n.votes_up + n.votes_down;
      var needed  = Math.max(0, CI_VOTES_THRESHOLD - n.votes_up);
      var upPct   = total > 0 ? Math.round(n.votes_up   / total * 100) : 0;
      var dnPct   = total > 0 ? (100 - upPct) : 0;
      var ts      = row.created_at ? new Date(row.created_at).toUTCString().slice(0, 22) : '';
      var tagList = n.tags ? n.tags.split(',').map(function(t) {
        return '<span class="ci-tag">' + esc(t.trim()) + '</span>';
      }).join('') : '';

      html +=
        '<div class="ci-card" id="ci-row-' + row.id + '">' +
          '<div class="ci-card-title">' + esc(row.title) + '</div>' +
          '<div class="ci-card-meta">' +
            '<span class="ci-tag">' + esc(row.category || '') + '</span>' +
            tagList +
            '<span class="ci-tag">📍 ' + esc(row.location || '') + '</span>' +
            (ts ? '<span style="font-size:7px;color:#1a3050;letter-spacing:1px;margin-left:auto;">' + ts + '</span>' : '') +
          '</div>' +
          (n.description ? '<div class="ci-card-desc">' + esc(n.description) + '</div>' : '') +
          (row.source_url
            ? '<div style="margin:3px 0 5px;"><a href="' + esc(row.source_url) + '" target="_blank" rel="noopener" ' +
              'style="font-size:8px;color:#3a6a8a;letter-spacing:1px;text-decoration:none;">↗ ' +
              esc(row.source_url.length > 60 ? row.source_url.slice(0, 60) + '…' : row.source_url) +
              '</a></div>'
            : '') +
          '<div class="ci-progress-row">' +
            '<div class="ci-conf-bar" style="flex:1;display:flex;">' +
              '<div style="height:100%;width:' + upPct + '%;background:#00ff88;border-radius:1px 0 0 1px;transition:width 0.3s;"></div>' +
              '<div style="height:100%;width:' + dnPct + '%;background:#ff4444;border-radius:0 1px 1px 0;transition:width 0.3s;"></div>' +
            '</div>' +
            '<span style="font-size:7px;color:#2a4a6a;letter-spacing:1px;white-space:nowrap;margin-left:6px;">' +
              (n.promoted ? '✓ SUBMITTED FOR ADMIN REVIEW' : needed + ' UPVOTES FOR REVIEW') +
            '</span>' +
          '</div>' +
          '<div class="ci-card-actions">' +
            '<button class="ci-vote-btn up' + (myVote === 'up'   ? ' voted-up'   : '') + '" ' +
              'onclick="ArgusEvents.vote(\'' + row.id + '\',\'up\')">▲ ' + n.votes_up + '</button>' +
            '<button class="ci-vote-btn down' + (myVote === 'down' ? ' voted-down' : '') + '" ' +
              'onclick="ArgusEvents.vote(\'' + row.id + '\',\'down\')">▼ ' + n.votes_down + '</button>' +
            '<span style="font-size:7px;color:#1a3050;letter-spacing:1px;margin-left:4px;">' +
              esc(row.submitted_by || 'community') +
            '</span>' +
            (n.promoted
              ? '<span class="ci-status-badge verified">✓ REVIEW QUEUED</span>'
              : '<span class="ci-status-badge pending">COMMUNITY</span>') +
            ((window.ArgusSession && (window.ArgusSession.tier === 'admin' || window.ArgusSession.tier === 'owner'))
              ? '<button class="ci-vote-btn" style="margin-left:auto;color:#cc2200;border-color:rgba(204,34,0,0.35);" ' +
                'onclick="ArgusEvents.removeCommunityIntel(\'' + row.id + '\')">✕ REMOVE</button>'
              : '') +
          '</div>' +
        '</div>';
    });
    ciList.innerHTML = html;
  }

  // ── Voting: fetch current, increment, PATCH back to Supabase ─────────────────
  function vote(id, dir) {
    if (getMyVote(id) === dir) return; // already voted this way

    // Disable buttons optimistically
    var card = document.getElementById('ci-row-' + id);
    if (card) card.querySelectorAll('.ci-vote-btn').forEach(function(b) {
      b.disabled = true; b.style.opacity = '0.4';
    });

    ciFetch('/rest/v1/argus_analyst_requests?id=eq.' + encodeURIComponent(id) +
            '&select=id,notes,status,title,category,location,source_url,submitted_by')
    .then(function(r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
    .then(function(rows) {
      if (!rows || !rows.length) throw new Error('Record not found');
      var row    = rows[0];
      var n      = parseNotes(row.notes);
      var prev   = getMyVote(id);

      // Undo previous vote if switching
      if (prev === 'up')   n.votes_up   = Math.max(0, n.votes_up   - 1);
      if (prev === 'down') n.votes_down = Math.max(0, n.votes_down - 1);

      // Apply new vote
      if (dir === 'up')   n.votes_up   += 1;
      if (dir === 'down') n.votes_down += 1;

      var shouldPromote = n.votes_up >= CI_VOTES_THRESHOLD && !n.promoted;
      if (shouldPromote) n.promoted = true;

      return ciFetch('/rest/v1/argus_analyst_requests?id=eq.' + encodeURIComponent(id), {
        method:  'PATCH',
        headers: { 'Prefer': 'return=minimal' },
        body:    JSON.stringify({ notes: JSON.stringify(n) })
      })
      .then(function(r) {
        if (!r.ok) throw new Error('PATCH ' + r.status);
        setMyVote(id, dir);
        if (shouldPromote) promoteToAdminQueue(row, n);
        loadCommunityIntel(); // refresh feed
      });
    })
    .catch(function(e) {
      console.warn('ArgusEvents vote failed:', e.message);
      if (card) card.querySelectorAll('.ci-vote-btn').forEach(function(b) {
        b.disabled = false; b.style.opacity = '';
      });
    });
  }

  // ── Admin/Owner: remove a community intel entry from the public feed ────────
  function removeCommunityIntel(id) {
    var tier = window.ArgusSession ? window.ArgusSession.tier : 'viewer';
    if (tier !== 'admin' && tier !== 'owner') return;
    if (!confirm('Remove this community intel entry from the public feed?')) return;
    ciFetch('/rest/v1/argus_analyst_requests?id=eq.' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: { 'Prefer': 'return=minimal' }
    })
    .then(function(r) {
      if (!r.ok) throw new Error('DELETE ' + r.status);
      loadCommunityIntel();
    })
    .catch(function(e) { console.warn('ArgusEvents removeCommunityIntel failed:', e.message); });
  }

  // ── Promote to admin REQUESTS tab when threshold reached ─────────────────────
  function promoteToAdminQueue(row, n) {
    ciFetch('/rest/v1/argus_analyst_requests', {
      method:  'POST',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        title:        '[COMMUNITY ▲' + n.votes_up + '] ' + (row.title || '').slice(0, 95),
        category:     row.category    || 'general',
        location:     row.location    || null,
        source_url:   row.source_url  || null,
        notes:        JSON.stringify({ description: n.description || '', tags: n.tags || '', votes_up: n.votes_up, votes_down: n.votes_down, promoted: true }),
        submitted_by: row.submitted_by || 'community',
        status:       'pending'
      })
    })
    .then(function(r) {
      if (!r.ok) console.warn('ArgusEvents: promote failed HTTP', r.status);
      else console.log('ArgusEvents: community intel promoted to admin queue —', row.title);
    })
    .catch(function(e) { console.warn('ArgusEvents: promote failed:', e.message); });
  }

  // Auto-refresh community intel every 30s so all users see new submissions in real-time
  setInterval(function() {
    if (window._intelFeedView === 'community') loadCommunityIntel();
  }, 30000);

  return { plot: plot, toggleFeed: toggleFeed, toggleTray: toggleTray, clearAll: clearAll, deleteEvent: deleteEvent, focusEvent: focusEvent, openModal: openModal, closeModal: closeModal, submitModal: submitModal, checkFormReady: checkFormReady, setFeedView: setFeedView, vote: vote, loadCommunityIntel: loadCommunityIntel, removeCommunityIntel: removeCommunityIntel };

})(); // end ArgusEvents


// ── Data sources panel — show on load, auto-dismiss ──────────────────────────
setTimeout(function() {
  var p = document.getElementById('panel-data-sources');
  p.classList.add('is-visible');
  setTimeout(function() { p.classList.remove('is-visible'); }, 8000);
}, 1000);

// ── Boot all data feeds ───────────────────────────────────────────────────────
ArgusData.init();
ArgusMarket.init();

})(); // end IIFE
