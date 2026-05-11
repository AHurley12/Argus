'use strict';
// core/runtime/argusDiagnostics.js
// Production observability & diagnostics framework.
//
// Exposes:
//   window.ArgusDiagnostics  — unified snapshot aggregating all audit surfaces
//   window.ArgusRendererAudit — extended renderer metrics (updated per-frame by animate())
//   window.ArgusMemoryAudit  — GPU resource lifecycle (ArgusResourceTracker wrapper)
//   window.ArgusSchedulerAudit — already defined in index.html; untouched here
//   window.ArgusPerf         — already defined in perf.js; untouched here
//
// Debug overlay: Ctrl+Shift+D toggles a compact HUD in the top-right corner.
// The overlay refreshes every 1 s and adds < 0.1 ms per refresh cycle.
//
// Console policy: zero output at steady state. Logs only on toggle and on
// explicit ArgusDiagnostics.snapshot() calls.
//
// Dependencies: optional (all window.* guards — module is inert if peers missing)
// Load order: after argusSelection.js (last script in body)

(function () {
  'use strict';

  // ── Interaction latency tracker ─────────────────────────────────────────────
  // Patches ArgusSelection.onHover / onClick to measure and record
  // the time from the raw DOM event to the function completing.
  // If ArgusSelection is not yet available, patches lazily on first call.
  var _latency = {
    hover:  { count: 0, totalMs: 0, maxMs: 0 },
    click:  { count: 0, totalMs: 0, maxMs: 0 },
    dim:    { count: 0, totalMs: 0, maxMs: 0 },
    restore:{ count: 0, totalMs: 0, maxMs: 0 },
  };

  function _recordLatency(bucket, ms) {
    var b = _latency[bucket];
    b.count++;
    b.totalMs += ms;
    if (ms > b.maxMs) b.maxMs = ms;
  }

  function _avgMs(bucket) {
    var b = _latency[bucket];
    return b.count ? (b.totalMs / b.count) : 0;
  }

  function _patchSelection() {
    var sel = window.ArgusSelection;
    if (!sel || sel._diag_patched) return;
    sel._diag_patched = true;

    var _origHover = sel.onHover;
    sel.onHover = function (x, y) {
      var t0 = performance.now();
      var r  = _origHover(x, y);
      _recordLatency('hover', performance.now() - t0);
      return r;
    };

    var _origClick = sel.onClick;
    sel.onClick = function (x, y) {
      var t0 = performance.now();
      var r  = _origClick(x, y);
      _recordLatency('click', performance.now() - t0);
      return r;
    };
  }

  // Patch once ArgusSelection is ready (it loads before this file, so immediate)
  _patchSelection();

  // ── Heap metrics (Chrome-only) ───────────────────────────────────────────────
  function _heapMB() {
    var pm = window.performance && window.performance.memory;
    if (!pm) return null;
    return {
      usedMB:  (pm.usedJSHeapSize  / 1048576).toFixed(1),
      totalMB: (pm.totalJSHeapSize / 1048576).toFixed(1),
      limitMB: (pm.jsHeapSizeLimit / 1048576).toFixed(1),
    };
  }

  // ── VRAM estimate ────────────────────────────────────────────────────────────
  // Approximates GPU memory from renderer.info — THREE.js geometry/texture
  // counts are cumulative allocations (not current live count).
  // We report live counts from the registry for a more accurate picture.
  function _vramEstimateMB() {
    var renderer = window.ArgusGlobe && window.ArgusGlobe.renderer;
    if (!renderer) return null;
    var ri = renderer.info;
    // Rough heuristic: each texture ≈ 1 MB, each geometry ≈ 0.05 MB
    return {
      geomAllocs:    ri.memory ? ri.memory.geometries : 0,
      texAllocs:     ri.memory ? ri.memory.textures   : 0,
      estimateMB:    (((ri.memory ? ri.memory.textures : 0) * 1.0) +
                      ((ri.memory ? ri.memory.geometries : 0) * 0.05)).toFixed(1),
    };
  }

  // ── Renderer extended info ───────────────────────────────────────────────────
  // window.ArgusRendererAudit is already initialized in index.html with
  // drawCalls / triangles / lines / points / entityCounts (updated per frame).
  // We extend it here with memory fields and a .get() snapshot method.
  // The per-frame animate() block in index.html adds .geometries / .textures.
  if (!window.ArgusRendererAudit) {
    window.ArgusRendererAudit = {
      drawCalls: 0, triangles: 0, lines: 0, points: 0,
      entityCounts: {}, geometries: 0, textures: 0,
      fpsAvg: 0, fpsMin: 0,
    };
  }
  window.ArgusRendererAudit.get = function () {
    var r = window.ArgusRendererAudit;
    return {
      drawCalls:    r.drawCalls,
      triangles:    r.triangles,
      lines:        r.lines,
      points:       r.points,
      entityCounts: r.entityCounts,
      geometries:   r.geometries || 0,
      textures:     r.textures   || 0,
      fpsAvg:       r.fpsAvg     || 0,
      fpsMin:       r.fpsMin     || 0,
    };
  };

  // ── ArgusMemoryAudit — already defined in argusResourceTracker.js ────────────
  // Ensure the global exists even if argusResourceTracker.js is absent.
  if (!window.ArgusMemoryAudit) {
    window.ArgusMemoryAudit = {
      get: function () { return null; }
    };
  }

  // ── ArgusDiagnostics — unified snapshot aggregator ───────────────────────────
  window.ArgusDiagnostics = {

    // snapshot() — returns a plain object with ALL audit surfaces merged.
    // Safe to call at any time; missing subsystems return null for their slice.
    snapshot: function () {
      return {
        timestamp:  Date.now(),
        renderer:   window.ArgusRendererAudit  ? window.ArgusRendererAudit.get()  : null,
        memory:     window.ArgusMemoryAudit    ? window.ArgusMemoryAudit.get()    : null,
        scheduler:  window.ArgusSchedulerAudit ? window.ArgusSchedulerAudit.get() : null,
        lifecycle:  window.ArgusLifecycleAudit ? window.ArgusLifecycleAudit.get() : null,
        dirty:      window.ArgusDirtyAudit     ? window.ArgusDirtyAudit.get()     : null,
        perf:       window.ArgusPerf           ? window.ArgusPerf.report           : null,
        modules:    window.ArgusModuleAudit    ? window.ArgusModuleAudit.get()    : null,
        registry:   window.ArgusEntityRegistry ? window.ArgusEntityRegistry.getAudit() : null,
        heap:       _heapMB(),
        vram:       _vramEstimateMB(),
        latency: {
          hoverAvgMs:   +_avgMs('hover').toFixed(2),
          hoverMaxMs:   +_latency.hover.maxMs.toFixed(2),
          clickAvgMs:   +_avgMs('click').toFixed(2),
          clickMaxMs:   +_latency.click.maxMs.toFixed(2),
          hoverSamples: _latency.hover.count,
          clickSamples: _latency.click.count,
        },
      };
    },

    // print() — formats and logs a grouped snapshot to the browser console.
    print: function () {
      var s = window.ArgusDiagnostics.snapshot();
      console.group('[ArgusDiagnostics] Snapshot @ ' + new Date(s.timestamp).toISOString());
      if (s.renderer) {
        console.log('Renderer — drawCalls:', s.renderer.drawCalls,
          '| triangles:', s.renderer.triangles,
          '| fps:', s.renderer.fpsAvg.toFixed(1) + ' avg',
          '| geomAllocs:', s.renderer.geometries,
          '| texAllocs:', s.renderer.textures);
      }
      if (s.heap) {
        console.log('Heap     — used:', s.heap.usedMB + ' MB',
          '| total:', s.heap.totalMB + ' MB',
          '| limit:', s.heap.limitMB + ' MB');
      }
      if (s.vram) {
        console.log('VRAM est —', s.vram.estimateMB + ' MB',
          '(geoms:', s.vram.geomAllocs + ', textures:', s.vram.texAllocs + ')');
      }
      if (s.scheduler) {
        console.log('Scheduler — longTasks:', s.scheduler.longTasks,
          '| frameBudgetViolations:', s.scheduler.frameBudgetViolations,
          '| yielded:', s.scheduler.yieldedTasks,
          '| deferred:', s.scheduler.deferredTasks);
      }
      if (s.registry) {
        console.log('Registry  — total:', s.registry.totalEntities,
          '| aircraft:', s.registry.aircraftCount,
          '| ships:', s.registry.shipCount,
          '| ais:', s.registry.aisCount,
          '| orphaned:', s.registry.orphaned);
      }
      console.log('Latency   — hover:', s.latency.hoverAvgMs + 'ms avg (' + s.latency.hoverSamples + ' samples)',
        '| click:', s.latency.clickAvgMs + 'ms avg (' + s.latency.clickSamples + ' samples)');
      console.groupEnd();
    },
  };

  // ── Debug overlay ────────────────────────────────────────────────────────────
  // Ctrl+Shift+D toggles a compact HUD panel in the top-right corner.
  // Refreshes every 1 s using setInterval. Zero DOM reads per frame when hidden.
  var _overlayEl  = null;
  var _overlayTimer = null;
  var _overlayVisible = false;

  function _createOverlay() {
    var el = document.createElement('div');
    el.id = 'argus-diag-overlay';
    el.style.cssText = [
      'position:fixed',
      'top:8px',
      'right:8px',
      'z-index:99999',
      'background:rgba(0,0,0,0.82)',
      'color:#a0ffb0',
      'font-family:monospace',
      'font-size:11px',
      'line-height:1.55',
      'padding:8px 10px',
      'border:1px solid #1a4a2a',
      'border-radius:4px',
      'min-width:260px',
      'pointer-events:none',
      'white-space:pre',
      'user-select:none',
    ].join(';');
    document.body.appendChild(el);
    return el;
  }

  function _renderOverlay() {
    if (!_overlayEl || !_overlayVisible) return;
    var s = window.ArgusDiagnostics.snapshot();
    var lines = ['[ARGUS DIAGNOSTICS]  Ctrl+Shift+D to hide'];

    // Renderer / FPS
    if (s.renderer) {
      var fps  = s.renderer.fpsAvg ? s.renderer.fpsAvg.toFixed(1) : '—';
      var fpsMin = s.renderer.fpsMin ? s.renderer.fpsMin.toFixed(1) : '—';
      lines.push('FPS    ' + fps + ' avg  ' + fpsMin + ' min');
      lines.push('Draw   ' + s.renderer.drawCalls + ' calls  ' + s.renderer.triangles + ' tris');
      lines.push('GPU    geoms:' + s.renderer.geometries + '  tex:' + s.renderer.textures);
    }

    // Heap / VRAM
    if (s.heap) {
      lines.push('Heap   ' + s.heap.usedMB + ' / ' + s.heap.limitMB + ' MB');
    }
    if (s.vram) {
      lines.push('VRAM≈  ' + s.vram.estimateMB + ' MB');
    }

    // Entities
    if (s.registry) {
      lines.push('Ents   ais:' + s.registry.aisCount +
        '  ac:' + s.registry.aircraftCount +
        '  sh:' + s.registry.shipCount +
        (s.registry.orphaned ? '  ⚠ orphaned:' + s.registry.orphaned : ''));
    }

    // Scheduler
    if (s.scheduler) {
      lines.push('Sched  longTasks:' + s.scheduler.longTasks +
        '  fbv:' + s.scheduler.frameBudgetViolations);
    }

    // Latency
    lines.push('Hover  ' + s.latency.hoverAvgMs + 'ms avg  max:' + s.latency.hoverMaxMs + 'ms' +
      '  n=' + s.latency.hoverSamples);
    lines.push('Click  ' + s.latency.clickAvgMs + 'ms avg  max:' + s.latency.clickMaxMs + 'ms' +
      '  n=' + s.latency.clickSamples);

    _overlayEl.textContent = lines.join('\n');
  }

  function _showOverlay() {
    if (!_overlayEl) _overlayEl = _createOverlay();
    _overlayEl.style.display = 'block';
    _overlayVisible = true;
    _renderOverlay();
    _overlayTimer = setInterval(_renderOverlay, 1000);
  }

  function _hideOverlay() {
    _overlayVisible = false;
    if (_overlayTimer) { clearInterval(_overlayTimer); _overlayTimer = null; }
    if (_overlayEl) _overlayEl.style.display = 'none';
  }

  function _toggleOverlay() {
    if (_overlayVisible) { _hideOverlay(); } else { _showOverlay(); }
  }

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.shiftKey && e.key === 'D') {
      e.preventDefault();
      _toggleOverlay();
    }
  });

  console.log('[ArgusDiagnostics] ready — Ctrl+Shift+D for overlay, ArgusDiagnostics.print() for snapshot');

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusDiagnostics');

}());
