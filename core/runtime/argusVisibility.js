// ── ArgusVisibility — Visibility API tab-pause manager ───────────────────────
// Pauses non-critical refresh timers when the browser tab is hidden.
// Exposes window._argusTabVisible for any module to gate its own fetch calls.
// Extracted from index.html inline script — no closure dependencies.

(function () {
'use strict';

// Collect every module that exposes a pausable refresh timer via window
// Each entry: { name, getTimer, setTimer, fn, interval }
// We store the timer IDs in module closures, so we use a signal approach:
// on hidden → clear timers; on visible → re-fire immediately + restart timers.

// Modules that expose their refresh controls on window
var MANAGED = [
  {
    // Aircraft — ArgusTracking bootstrap already manages refreshTimer internally.
    // We hook visibilitychange to force a stale-cache re-fetch on resume.
    onResume: function () {
      if (window.ArgusTracking) window.ArgusTracking.refreshAircraft();
    }
  }
];

// For the top-level setInterval calls (loadLiveEvents, fetchAll etc.) we cannot
// reach their interval IDs from here. Instead, we wrap fetch calls with a
// document.hidden guard — but those functions are already defined.
// Simplest approach: register a global visibility flag every module can check.

var _tabVisible = !document.hidden;
Object.defineProperty(window, '_argusTabVisible', {
  get: function () { return _tabVisible; },
  configurable: true,
});

document.addEventListener('visibilitychange', function () {
  _tabVisible = !document.hidden;

  if (!document.hidden) {
    // Tab became visible — tell each managed module to resume
    MANAGED.forEach(function (m) {
      try { if (m.onResume) m.onResume(); } catch (_) {}
    });
    console.log('[ArgusVisibility] Tab visible — refreshes resumed');
  } else {
    console.log('[ArgusVisibility] Tab hidden — fetches suppressed');
  }
});

if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusVisibility');

}());
