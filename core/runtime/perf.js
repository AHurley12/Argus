'use strict';

// ── Deferred localStorage write helper ───────────────────────────────────────
// Schedules writes via setTimeout so serialization runs after the current call
// stack clears. This prevents synchronous main-thread stalls caused by large
// JSON payloads (aircraft ~75 KB every 90 s, GDELT ~150 KB every 25 min).
// API is a drop-in replacement for localStorage.setItem — pass a string or any
// JSON-serializable value. Optional delayMs debounces rapid successive writes.
// NOTE: Do NOT use for session tokens or auth state — those must persist
// immediately. Use synchronous localStorage.setItem for those.
(function() {
  var _timers = {};
  window._lsWrite = function(key, value, delayMs) {
    if (_timers[key]) clearTimeout(_timers[key]);
    _timers[key] = setTimeout(function() {
      delete _timers[key];
      try {
        localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
      } catch(e) {}
    }, delayMs || 0);
  };
}());

// ── Performance monitor ───────────────────────────────────────────────────────
// Tracks timing stats for named operations across the session.
// Call  ArgusPerf.report()  from the browser console at any time.
// Budgets (ms): FRAME_TIME=16.67, SCAN=200, AIRCRAFT_RENDER=200, RAYCAST=10
(function() {
  var _stats = {}; // name → { count, totalMs, maxMs, overBudget }

  function record(name, ms, budgetMs) {
    var s = _stats[name] || (_stats[name] = { count: 0, totalMs: 0, maxMs: 0, overBudget: 0 });
    s.count++;
    s.totalMs += ms;
    if (ms > s.maxMs) s.maxMs = ms;
    if (budgetMs && ms > budgetMs) {
      s.overBudget++;
      console.warn('[ArgusPerf] ' + name + ' ' + ms.toFixed(1) + 'ms (budget ' + budgetMs + 'ms)');
    }
  }

  // Measure a synchronous function and record its duration.
  function measure(name, fn, budgetMs) {
    var t0 = performance.now();
    var r  = fn();
    record(name, performance.now() - t0, budgetMs);
    return r;
  }

  // Print a formatted session report to the browser console.
  function report() {
    var names = Object.keys(_stats).sort();
    if (!names.length) { console.log('[ArgusPerf] No data yet.'); return; }
    console.group('[ArgusPerf] Session Performance Report');
    names.forEach(function(name) {
      var s   = _stats[name];
      var avg = s.count ? (s.totalMs / s.count).toFixed(1) : '—';
      var row = name
        + '  avg='  + avg + 'ms'
        + '  max='  + s.maxMs.toFixed(1) + 'ms'
        + '  n='    + s.count;
      if (s.overBudget) row += '  ⚠ over-budget=' + s.overBudget + '/' + s.count;
      console.log(row);
    });
    console.groupEnd();
  }

  // Long Tasks API — browser fires this automatically for any task > 50 ms.
  // Catches unexpected main-thread stalls with zero manual instrumentation.
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      new PerformanceObserver(function(list) {
        list.getEntries().forEach(function(e) { record('LONG_TASK', e.duration, 50); });
      }).observe({ type: 'longtask', buffered: true });
    } catch(_) {}
  }

  window.ArgusPerf = { record: record, measure: measure, report: report };
}());
