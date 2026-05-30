'use strict';
// core/perf/argusPerf.js
// High-resolution startup profiler for the Argus globe.
//
// Usage (console):
//   ArgusPerf.report()                    — full timeline + renderer stats
//   ArgusPerf.startPeriodicReport(5000)   — log draw calls + memory every 5 s
//   ArgusPerf.stopPeriodicReport()
//   ArgusPerf.FLAGS.DISABLE_AIRCRAFT      — read/set feature flags
//
// Feature flags persist across page reloads via localStorage:
//   localStorage.setItem('argus_disable_aircraft', '1'); location.reload();
//   localStorage.removeItem('argus_disable_aircraft'); location.reload();
//
// Marks already wired in production code (no-ops before this script loads):
//   animate() line ~1904    → ArgusPerf.record('FRAME_TIME_MS', delta, 16.67)
//   fetchAndRenderAircraft  → ArgusPerf.record('AIRCRAFT_RENDER', ...)
//
// This module must load BEFORE DOMContentLoaded fires so marks from the
// globe init block are captured. Add the script tag near the top of <head>.

(function () {
  'use strict';

  var _t0     = performance.now();  // module load time (earliest possible anchor)
  var _marks  = [];                 // [{name, t, elapsed}]
  var _metrics = {};                // name → [{value, t}]
  var _periodicTimer = null;

  // ── Feature flags ──────────────────────────────────────────────────────────
  // Read from localStorage so they survive page reload.
  var FLAGS = {
    get DISABLE_AIRCRAFT() { return localStorage.getItem('argus_disable_aircraft') === '1'; },
    set DISABLE_AIRCRAFT(v) { v ? localStorage.setItem('argus_disable_aircraft', '1') : localStorage.removeItem('argus_disable_aircraft'); },

    get DISABLE_VESSELS()  { return localStorage.getItem('argus_disable_vessels') === '1'; },
    set DISABLE_VESSELS(v) { v ? localStorage.setItem('argus_disable_vessels', '1') : localStorage.removeItem('argus_disable_vessels'); },

    get DISABLE_TEXTURES() { return localStorage.getItem('argus_disable_textures') === '1'; },
    set DISABLE_TEXTURES(v){ v ? localStorage.setItem('argus_disable_textures', '1') : localStorage.removeItem('argus_disable_textures'); },
  };

  // ── mark(name) ─────────────────────────────────────────────────────────────
  // Records a named timestamp and immediately logs it with elapsed since load.
  function mark(name) {
    var t       = performance.now();
    var elapsed = Math.round(t - _t0);
    _marks.push({ name: name, t: t, elapsed: elapsed });
    console.log('[ArgusPerf] ' + name + ' +' + elapsed + 'ms');
    return elapsed;
  }

  // ── record(name, value, threshold) ─────────────────────────────────────────
  // Accumulates a named metric sample. Warns if value > threshold.
  // This bridges the pre-existing calls in animate() and fetchAndRenderAircraft()
  // that were no-ops before this module existed.
  function record(name, value, threshold) {
    if (!_metrics[name]) _metrics[name] = [];
    _metrics[name].push({ value: value, t: performance.now() });
    if (threshold !== undefined && value > threshold) {
      // Only warn at 2× threshold to avoid log spam on every slow frame
      if (value > threshold * 2) {
        console.warn('[ArgusPerf] ' + name + ' = ' + Math.round(value) + 'ms (threshold: ' + threshold + 'ms)');
      }
    }
  }

  // ── report() ───────────────────────────────────────────────────────────────
  // Prints the full timeline plus renderer / scheduler / memory snapshots.
  function report() {
    console.group('[ArgusPerf] Startup Timeline');
    if (_marks.length === 0) {
      console.log('  (no marks recorded yet — add ArgusPerf.mark() calls to init code)');
    } else {
      var prev = _t0;
      for (var i = 0; i < _marks.length; i++) {
        var m    = _marks[i];
        var gap  = Math.round(m.t - prev);
        console.log('  +' + _pad(m.elapsed, 6) + 'ms  [+' + _pad(gap, 5) + 'ms gap]  ' + m.name);
        prev = m.t;
      }
    }
    console.groupEnd();

    // ── Renderer stats ──────────────────────────────────────────────────────
    var ra = window.ArgusRenderAudit;
    if (ra) {
      console.group('[ArgusPerf] Renderer (last frame)');
      console.log('  Draw calls : ' + ra.drawCalls);
      console.log('  Triangles  : ' + ra.triangles);
      console.log('  Geometries : ' + ra.geometries);
      console.log('  Textures   : ' + ra.textures);
      console.log('  FPS avg    : ' + (ra.fpsAvg  || 0).toFixed(1));
      console.log('  FPS min    : ' + (ra.fpsMin  || 0).toFixed(1));
      var ec = ra.entityCounts || {};
      console.log('  Entities   — AIS: ' + (ec.ais || 0) + '  aircraft: ' + (ec.aircraft || 0) + '  ships: ' + (ec.ships || 0));
      console.groupEnd();
    }

    // ── Scheduler / long-task stats ─────────────────────────────────────────
    var sa = window.ArgusSchedulerAudit;
    if (sa) {
      console.group('[ArgusPerf] Scheduler');
      console.log('  Frame budget violations : ' + (sa.frameBudgetViolations || 0));
      console.log('  Long tasks detected     : ' + (sa.longTasks || 0));
      console.log('  Worst task durations    : ' + (sa.worstTaskDurations || []).join(', ') + ' ms');
      console.groupEnd();
    }

    // ── Memory ─────────────────────────────────────────────────────────────
    if (performance.memory) {
      var mem = performance.memory;
      console.group('[ArgusPerf] Memory (Chrome only)');
      console.log('  JS heap used  : ' + _mb(mem.usedJSHeapSize) + ' MB');
      console.log('  JS heap total : ' + _mb(mem.totalJSHeapSize) + ' MB');
      console.log('  JS heap limit : ' + _mb(mem.jsHeapSizeLimit) + ' MB');
      console.groupEnd();
    }

    // ── FRAME_TIME_MS metric summary ────────────────────────────────────────
    var ftSamples = _metrics['FRAME_TIME_MS'];
    if (ftSamples && ftSamples.length > 0) {
      var ftVals = ftSamples.map(function(s) { return s.value; });
      var ftSum  = ftVals.reduce(function(a, b) { return a + b; }, 0);
      var ftMax  = Math.max.apply(null, ftVals);
      console.group('[ArgusPerf] Frame time samples (' + ftVals.length + ')');
      console.log('  avg : ' + (ftSum / ftVals.length).toFixed(2) + ' ms');
      console.log('  max : ' + ftMax.toFixed(2) + ' ms');
      console.log('  (budget = 16.67 ms @ 60 fps)');
      console.groupEnd();
    }

    // ── Feature flags ────────────────────────────────────────────────────────
    console.group('[ArgusPerf] Feature flags');
    console.log('  DISABLE_AIRCRAFT : ' + FLAGS.DISABLE_AIRCRAFT);
    console.log('  DISABLE_VESSELS  : ' + FLAGS.DISABLE_VESSELS);
    console.log('  DISABLE_TEXTURES : ' + FLAGS.DISABLE_TEXTURES);
    console.log('  (set via: ArgusPerf.FLAGS.DISABLE_AIRCRAFT = true; location.reload())');
    console.groupEnd();
  }

  // ── startPeriodicReport / stopPeriodicReport ───────────────────────────────
  function startPeriodicReport(ms) {
    ms = ms || 5000;
    stopPeriodicReport();
    _periodicTimer = setInterval(function () {
      var ra  = window.ArgusRenderAudit || {};
      var mem = performance.memory;
      var memStr = mem ? ('heap ' + _mb(mem.usedJSHeapSize) + '/' + _mb(mem.totalJSHeapSize) + ' MB') : 'memory N/A';
      console.log(
        '[ArgusPerf] periodic — drawCalls: ' + (ra.drawCalls || 0) +
        '  fps: ' + ((ra.fpsAvg || 0).toFixed(1)) +
        '  AIS: ' + ((ra.entityCounts || {}).ais || 0) +
        '  aircraft: ' + ((ra.entityCounts || {}).aircraft || 0) +
        '  ' + memStr
      );
    }, ms);
    console.log('[ArgusPerf] periodic report started (every ' + ms + ' ms) — call stopPeriodicReport() to cancel');
  }

  function stopPeriodicReport() {
    if (_periodicTimer !== null) {
      clearInterval(_periodicTimer);
      _periodicTimer = null;
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  function _pad(n, w) {
    var s = String(n);
    while (s.length < w) s = ' ' + s;
    return s;
  }

  function _mb(bytes) {
    return (bytes / 1048576).toFixed(1);
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  window.ArgusPerf = {
    FLAGS:               FLAGS,
    mark:                mark,
    record:              record,
    report:              report,
    startPeriodicReport: startPeriodicReport,
    stopPeriodicReport:  stopPeriodicReport,
    getMarks:            function() { return _marks.slice(); },
    getMetrics:          function() { return _metrics; },
  };

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusPerf');

  mark('ARGUS_PERF_LOADED');
}());
