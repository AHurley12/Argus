// ── ArgusModuleAudit — parse-time and initialization order tracker ─────────────
//
// Must load EARLY (before other modules) to capture all register() calls.
// Measures: time from page navigation to each module's first initialization.
//
// Usage (in any module):
//   if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ModuleName');
//   if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ModuleName', { deferred: true });
//
// Diagnostics: ArgusModuleAudit.get()

window.ArgusModuleAudit = (function () {
  'use strict';

  // Baseline: elapsed time since page navigation when THIS script was parsed.
  // All subsequent register() calls measure relative to this.
  var _t0 = performance.now();

  var _order    = [];   // { name, ms } — registration order + timestamp
  var _deferred = [];   // names of modules that declared deferred init
  var _seen     = {};   // idempotency guard

  // ── register ─────────────────────────────────────────────────────────────────
  // Call once per module, at the end of module initialization.
  // opts.deferred = true  → module was initialized via idle/setTimeout, not inline.
  function register(name, opts) {
    if (_seen[name]) return;
    _seen[name] = true;
    var ms = Math.round(performance.now());
    _order.push({ name: name, ms: ms });
    if (opts && opts.deferred) _deferred.push(name);
  }

  // ── get ───────────────────────────────────────────────────────────────────────
  // Returns a diagnostic snapshot. Safe to call at any time.
  function get() {
    // External script load durations from the browser's resource timing buffer.
    // Duration ≈ download + parse time for each script file.
    var scriptLoadTimes = {};
    try {
      var resources = performance.getEntriesByType('resource');
      for (var i = 0; i < resources.length; i++) {
        var e = resources[i];
        if (e.initiatorType === 'script') {
          var file = e.name.split('/').pop().split('?')[0];
          scriptLoadTimes[file] = Math.round(e.duration);
        }
      }
    } catch (_) { /* resource timing blocked */ }

    return {
      // ms from nav-start to when ArgusModuleAudit itself was parsed
      parseTime:           Math.round(_t0),
      // Not directly measurable from JS — would require devtools instrumentation
      compileTime:         null,
      // Count of registered modules
      moduleCounts:        _order.length,
      // Modules that self-reported deferred (idle/setTimeout) initialization
      deferredModules:     _deferred.slice(),
      // Registration order + timestamp (ms from nav-start)
      initializationOrder: _order.slice(),
      // Per-script download+parse duration from browser resource timing
      scriptLoadTimes:     scriptLoadTimes,
    };
  }

  return { register: register, get: get };

}());
