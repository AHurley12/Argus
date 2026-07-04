/*
 * argusTradeWeb.js — Bilateral Trade Analysis Panel
 * Fetches UN Comtrade bilateral trade data on demand and renders a
 * structured panel with summary cards, commodity chart, and GDELT signal.
 *
 * CSS classes required in index.css:
 * ─────────────────────────────────────────────────────────────────────────────
 * .trade-selectors { display:flex; align-items:flex-end; gap:8px; flex-wrap:wrap; padding:12px 0; }
 * .trade-selector-group { display:flex; flex-direction:column; gap:4px; flex:1; min-width:140px; }
 * .trade-selector-group label { font-size:10px; color:#64748b; letter-spacing:.06em; text-transform:uppercase; }
 * .trade-selector-arrow { font-size:18px; color:#475569; padding-bottom:6px; }
 * .trade-selector-year { display:flex; flex-direction:column; gap:4px; width:80px; }
 * .trade-selector-year label { font-size:10px; color:#64748b; letter-spacing:.06em; text-transform:uppercase; }
 * select.trade-select { background:#0f172a; color:#e2e8f0; border:1px solid #334155; padding:5px 8px; font-size:11px; width:100%; cursor:pointer; }
 * select.trade-select:focus { outline:none; border-color:#475569; }
 * #trade-compare-btn { background:#1e293b; color:#e2e8f0; border:1px solid #334155; padding:7px 16px; font-size:11px; letter-spacing:.08em; cursor:pointer; align-self:flex-end; text-transform:uppercase; }
 * #trade-compare-btn:hover { background:#334155; }
 * #trade-compare-btn:disabled { opacity:.4; cursor:not-allowed; }
 * .trade-summary-cards { display:flex; gap:8px; margin:12px 0; flex-wrap:wrap; }
 * .trade-card { flex:1; min-width:110px; background:#0f172a; border:1px solid #1e293b; padding:10px 12px; }
 * .trade-card-label { font-size:9px; color:#64748b; letter-spacing:.08em; text-transform:uppercase; margin-bottom:4px; }
 * .trade-card-value { font-size:18px; font-weight:700; color:#e2e8f0; line-height:1.1; }
 * .trade-card--exports .trade-card-value { color:#22c55e; }
 * .trade-card--imports .trade-card-value { color:#f59e0b; }
 * .trade-card--surplus .trade-card-value { color:#22c55e; }
 * .trade-card--deficit .trade-card-value { color:#ef4444; }
 * .trade-chart-section { margin:12px 0; }
 * .trade-chart-title { font-size:9px; color:#64748b; letter-spacing:.08em; text-transform:uppercase; margin-bottom:6px; }
 * .trade-chart-container { background:#0f172a; border:1px solid #1e293b; padding:12px; }
 * .trade-signal { margin:12px 0; padding:10px 12px; background:#0f172a; border:1px solid #1e293b; }
 * .trade-signal-label { font-size:9px; color:#64748b; letter-spacing:.08em; text-transform:uppercase; margin-bottom:6px; }
 * .trade-signal-bar { height:4px; background:#1e293b; border-radius:2px; margin:4px 0; }
 * .trade-signal-fill { height:100%; background:#f59e0b; border-radius:2px; transition:width .4s ease; }
 * .trade-signal-fill--high { background:#ef4444; }
 * .trade-signal-fill--low  { background:#22c55e; }
 * .trade-signal-value { font-size:13px; color:#e2e8f0; font-weight:600; }
 * .trade-signal-note { font-size:9px; color:#475569; margin-top:2px; }
 * .trade-source-note { font-size:9px; color:#334155; margin-top:16px; text-align:right; }
 * .trade-no-data { color:#475569; font-size:11px; padding:20px 0; text-align:center; }
 * .trade-error { color:#ef4444; font-size:11px; padding:12px 0; }
 * .trade-loading { color:#64748b; font-size:11px; padding:12px 0; letter-spacing:.06em; }
 * ─────────────────────────────────────────────────────────────────────────────
 */

window.ArgusTradeWeb = (function () {
  'use strict';

  var _store = {
    reporter:     null,
    partner:      null,
    year:         2023,
    data:         null,
    loading:      false,
    chart:        null,
    countryCodes: null,
    initialized:  false,
  };

  // ── Formatting ──────────────────────────────────────────────────────────────
  function _formatUSD(n) {
    if (!n || isNaN(n)) return '$0';
    var abs = Math.abs(n);
    var prefix = n < 0 ? '-$' : '$';
    if (abs >= 1e12) return prefix + (abs / 1e12).toFixed(1) + 'T';
    if (abs >= 1e9)  return prefix + (abs / 1e9).toFixed(1) + 'B';
    if (abs >= 1e6)  return prefix + (abs / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3)  return prefix + (abs / 1e3).toFixed(1) + 'K';
    return prefix + abs.toFixed(0);
  }

  // ── Country codes ───────────────────────────────────────────────────────────
  function _loadCountryCodes() {
    if (_store.countryCodes) return Promise.resolve(_store.countryCodes);
    return fetch('data/country-codes.json')
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('country-codes load failed')); })
      .then(function (codes) {
        _store.countryCodes = codes;
        _populateDropdown(document.getElementById('trade-reporter-select'), codes);
        _populateDropdown(document.getElementById('trade-partner-select'), codes);
        return codes;
      });
  }

  function _populateDropdown(sel, codes) {
    if (!sel) return;
    var current = sel.value;
    // Remove all options except first placeholder
    while (sel.options.length > 1) sel.remove(1);
    codes.forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c.iso3;
      opt.textContent = c.name;
      sel.appendChild(opt);
    });
    if (current) sel.value = current;
  }

  // ── Hash state ──────────────────────────────────────────────────────────────
  function _updateHash() {
    if (_store.reporter && _store.partner) {
      history.replaceState(null, '', '#trade/' + _store.reporter + '/' + _store.partner + '/' + _store.year);
    }
  }

  function _restoreHash() {
    var hash = location.hash || '';
    var m = hash.match(/^#trade\/([A-Z]{3})\/([A-Z]{3})\/(\d{4})$/);
    if (!m) return;
    var rep = document.getElementById('trade-reporter-select');
    var par = document.getElementById('trade-partner-select');
    var yr  = document.getElementById('trade-year-select');
    if (rep) rep.value = m[1];
    if (par) par.value = m[2];
    if (yr)  yr.value  = m[3];
    _store.reporter = m[1];
    _store.partner  = m[2];
    _store.year     = parseInt(m[3]);
    _fetchTrade(m[1], m[2], parseInt(m[3]));
  }

  // ── GDELT stress signal ─────────────────────────────────────────────────────
  // Reads window.ArgusGdelt live events (if available) and counts events
  // that reference both the reporter and partner country names.
  function _gdeltSignal(reporterName, partnerName) {
    try {
      var raw = localStorage.getItem('argus_live_events_v2');
      if (!raw) return null;
      var events = JSON.parse(raw);
      if (!Array.isArray(events) || !events.length) return null;

      var repLow = (reporterName || '').toLowerCase();
      var parLow = (partnerName  || '').toLowerCase();
      if (!repLow || !parLow) return null;

      var total   = events.length;
      var matched = 0;
      events.forEach(function (ev) {
        var text = ((ev.title || '') + ' ' + (ev.description || '') + ' ' + (ev.source_country || '')).toLowerCase();
        if (text.indexOf(repLow) !== -1 && text.indexOf(parLow) !== -1) matched++;
      });

      // Score: percentage of recent GDELT events mentioning both countries, capped at 100
      var score = Math.min(100, Math.round((matched / Math.max(total, 1)) * 100 * 3));
      return { score: score, matched: matched, total: total };
    } catch (_) { return null; }
  }

  // ── Fetch ───────────────────────────────────────────────────────────────────
  function _fetchTrade(reporter, partner, year) {
    if (_store.loading) return;
    _store.loading  = true;
    _store.reporter = reporter;
    _store.partner  = partner;
    _store.year     = year || _store.year;

    var results = document.getElementById('trade-results');
    var btn     = document.getElementById('trade-compare-btn');
    if (results) results.innerHTML = '<div class="trade-loading">FETCHING TRADE DATA…</div>';
    if (btn) btn.disabled = true;

    _updateHash();

    fetch('/.netlify/functions/fetch-comtrade?reporter=' + encodeURIComponent(reporter) +
          '&partner=' + encodeURIComponent(partner) +
          '&year=' + encodeURIComponent(year))
      .then(function (r) {
        if (r.status === 429) throw Object.assign(new Error('rate_limit'), { status: 429 });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        _store.data    = data;
        _store.loading = false;
        if (btn) btn.disabled = false;
        _renderPanel(data);
      })
      .catch(function (err) {
        _store.loading = false;
        if (btn) btn.disabled = false;
        var msg = err.status === 429
          ? 'Rate limit reached — Comtrade allows ~500 requests/day. Try again in a minute.'
          : 'Failed to load trade data: ' + (err.message || 'unknown error');
        if (results) results.innerHTML = '<div class="trade-error">' + _esc(msg) + '</div>';
      });
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  function _esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function _countryName(iso3) {
    if (!_store.countryCodes) return iso3;
    for (var i = 0; i < _store.countryCodes.length; i++) {
      if (_store.countryCodes[i].iso3 === iso3) return _store.countryCodes[i].name;
    }
    return iso3;
  }

  function _renderPanel(data) {
    var results = document.getElementById('trade-results');
    if (!results) return;

    var exportUSD  = data.exports && data.exports.total_usd ? data.exports.total_usd : 0;
    var importUSD  = data.imports && data.imports.total_usd ? data.imports.total_usd : 0;
    var balance    = data.balance_usd || (exportUSD - importUSD);
    var isSurplus  = balance >= 0;
    var balClass   = isSurplus ? 'trade-card--surplus' : 'trade-card--deficit';
    var balLabel   = isSurplus ? 'TRADE SURPLUS' : 'TRADE DEFICIT';

    var repName = _countryName(data.reporter || _store.reporter);
    var parName = _countryName(data.partner  || _store.partner);

    var noData = exportUSD === 0 && importUSD === 0;

    var html = '';

    // ── Pair header ──
    html += '<div style="font-size:11px;color:#94a3b8;margin:8px 0 4px;">' +
      _esc(repName) + ' <span style="color:#475569">↔</span> ' + _esc(parName) +
      ' <span style="color:#334155;font-size:10px;">(' + _esc(String(data.year || _store.year)) + ')</span>' +
      (data.cached ? '<span style="color:#334155;font-size:9px;margin-left:6px;">cached</span>' : '') +
      '</div>';

    if (noData) {
      html += '<div class="trade-no-data">No Comtrade data available for this country pair and year.' +
        '<br><span style="color:#334155;font-size:9px;">Some countries have limited data in the public Comtrade preview API.</span></div>';
      results.innerHTML = html;
      return;
    }

    // ── Summary cards ──
    html += '<div class="trade-summary-cards">';
    html += '<div class="trade-card trade-card--exports">' +
      '<div class="trade-card-label">EXPORTS TO ' + _esc(parName.toUpperCase()) + '</div>' +
      '<div class="trade-card-value">' + _formatUSD(exportUSD) + '</div></div>';
    html += '<div class="trade-card trade-card--imports">' +
      '<div class="trade-card-label">IMPORTS FROM ' + _esc(parName.toUpperCase()) + '</div>' +
      '<div class="trade-card-value">' + _formatUSD(importUSD) + '</div></div>';
    html += '<div class="trade-card ' + balClass + '">' +
      '<div class="trade-card-label">' + _esc(balLabel) + '</div>' +
      '<div class="trade-card-value">' + _formatUSD(Math.abs(balance)) + '</div></div>';
    html += '</div>';

    // ── Chart placeholder (rendered separately after innerHTML) ──
    html += '<div class="trade-chart-section">' +
      '<div class="trade-chart-title">TOP COMMODITIES</div>' +
      '<div class="trade-chart-container"><canvas id="trade-chart" height="280"></canvas></div>' +
      '</div>';

    // ── GDELT signal ──
    var signal = _gdeltSignal(repName, parName);
    if (signal !== null) {
      var fillClass = signal.score >= 60 ? 'trade-signal-fill--high' :
                      signal.score <= 20 ? 'trade-signal-fill--low'  : '';
      html += '<div class="trade-signal">' +
        '<div class="trade-signal-label">TRADE STRESS SIGNAL</div>' +
        '<div class="trade-signal-bar"><div class="trade-signal-fill ' + fillClass + '" style="width:' + signal.score + '%"></div></div>' +
        '<div class="trade-signal-value">' + signal.score + ' / 100</div>' +
        '<div class="trade-signal-note">Based on GDELT event coverage for this country pair (' + signal.matched + ' of ' + signal.total + ' recent events)</div>' +
        '</div>';
    }

    // ── Source note ──
    html += '<div class="trade-source-note">Source: UN Comtrade · Data may be delayed 12–18 months</div>';

    results.innerHTML = html;

    // Render chart after DOM update
    _renderChart(data.top_exports || [], data.top_imports || []);
  }

  // ── Chart.js bar chart ──────────────────────────────────────────────────────
  function _renderChart(topExports, topImports) {
    var canvas = document.getElementById('trade-chart');
    if (!canvas) return;
    if (typeof window.Chart === 'undefined') return;

    // Destroy previous instance
    if (_store.chart) {
      try { _store.chart.destroy(); } catch (_) {}
      _store.chart = null;
    }

    // Build combined dataset: top 8 each
    var expSlice = topExports.slice(0, 8);
    var impSlice = topImports.slice(0, 8);

    // Build label set from exports (primary)
    var labels = expSlice.map(function (r) {
      return r.desc ? r.desc.slice(0, 28) : ('HS ' + r.code);
    });

    // Build import labels if we want separate charts — use two datasets on same labels
    // Use a horizontal bar chart showing exports vs imports for top export categories
    var expValues = expSlice.map(function (r) { return r.value_usd / 1e9; });

    // For imports, try to match by code, else use impSlice directly as second dataset
    var impLabels = impSlice.map(function (r) {
      return r.desc ? r.desc.slice(0, 28) : ('HS ' + r.code);
    });
    var impValues = impSlice.map(function (r) { return r.value_usd / 1e9; });

    // Use two separate Y axes for clarity — exports on top half, imports on bottom
    var allLabels  = labels.concat(impLabels.length ? ['──────────────────────────'] : []).concat(impLabels);
    var allExports = expValues.concat(impLabels.length ? [0] : []).concat(impSlice.map(function() { return 0; }));
    var allImports = expSlice.map(function() { return 0; }).concat(impLabels.length ? [0] : []).concat(impValues);

    var ctx = canvas.getContext('2d');
    _store.chart = new window.Chart(ctx, {
      type: 'bar',
      data: {
        labels: allLabels,
        datasets: [
          {
            label: 'Exports (B USD)',
            data:  allExports,
            backgroundColor: 'rgba(34,197,94,0.7)',
            borderColor:     'rgba(34,197,94,1)',
            borderWidth: 1,
          },
          {
            label: 'Imports (B USD)',
            data:  allImports,
            backgroundColor: 'rgba(245,158,11,0.7)',
            borderColor:     'rgba(245,158,11,1)',
            borderWidth: 1,
          },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            labels: { color: '#94a3b8', font: { size: 10 } },
          },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                return ctx.dataset.label + ': ' + _formatUSD(ctx.parsed.x * 1e9);
              },
            },
          },
        },
        scales: {
          x: {
            stacked: false,
            ticks:   { color: '#64748b', font: { size: 9 }, callback: function(v) { return '$' + v.toFixed(1) + 'B'; } },
            grid:    { color: '#1e293b' },
          },
          y: {
            ticks: { color: '#94a3b8', font: { size: 9 } },
            grid:  { color: '#1e293b' },
          },
        },
      },
    });
  }

  // ── Public: _compare (called from button onclick) ───────────────────────────
  function _compare() {
    var rep = document.getElementById('trade-reporter-select');
    var par = document.getElementById('trade-partner-select');
    var yr  = document.getElementById('trade-year-select');
    var reporter = rep ? rep.value : '';
    var partner  = par ? par.value : '';
    var year     = yr  ? parseInt(yr.value) || 2023 : 2023;

    if (!reporter || !partner) {
      var results = document.getElementById('trade-results');
      if (results) results.innerHTML = '<div class="trade-error">Please select both a reporter and a partner country.</div>';
      return;
    }
    if (reporter === partner) {
      var results2 = document.getElementById('trade-results');
      if (results2) results2.innerHTML = '<div class="trade-error">Reporter and partner must be different countries.</div>';
      return;
    }
    _fetchTrade(reporter, partner, year);
  }

  // ── Public: openPanel ───────────────────────────────────────────────────────
  function openPanel(reporterIso3, partnerIso3) {
    var rep = document.getElementById('trade-reporter-select');
    var par = document.getElementById('trade-partner-select');
    if (rep && reporterIso3) rep.value = reporterIso3;
    if (par && partnerIso3)  par.value = partnerIso3;
    if (reporterIso3 && partnerIso3) _fetchTrade(reporterIso3, partnerIso3, _store.year);
  }

  // ── Public: init ────────────────────────────────────────────────────────────
  function init() {
    if (_store.initialized) return;
    _store.initialized = true;
    _loadCountryCodes()
      .then(function () { _restoreHash(); })
      .catch(function (err) {
        console.warn('[ArgusTradeWeb] init failed:', err.message);
      });
  }

  // ── Public: destroy ─────────────────────────────────────────────────────────
  function destroy() {
    if (_store.chart) {
      try { _store.chart.destroy(); } catch (_) {}
      _store.chart = null;
    }
  }

  return {
    init:       init,
    destroy:    destroy,
    openPanel:  openPanel,
    _compare:   _compare,  // exposed for button onclick
  };

})();
