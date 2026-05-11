// ── ArgusDataAge — stale-while-revalidate badge helper ────────────────────────
// Marks data-age badge elements as fresh (with decay animation) or stale.
// Extracted from index.html inline script — pure DOM utility, no dependencies.

(function() {
'use strict';

// Format a Date as HH:MMZ
function fmtZ(d) {
  var h = d.getUTCHours().toString().padStart(2, '0');
  var m = d.getUTCMinutes().toString().padStart(2, '0');
  return h + ':' + m + 'Z';
}

// Mark a data-age badge as fresh, then decay to normal after 8s
function mark(badgeId, isoTs) {
  var el = document.getElementById(badgeId);
  if (!el) return;
  var ts   = isoTs ? new Date(isoTs) : new Date();
  el.textContent = 'AS OF ' + fmtZ(ts);
  el.classList.remove('is-stale');
  el.classList.add('is-fresh');
  // Re-trigger animation by forcing reflow
  void el.offsetWidth;
  clearTimeout(el._ageTimer);
  el._ageTimer = setTimeout(function() {
    el.classList.remove('is-fresh');
  }, 8000);
}

// Mark a badge as stale (called when TTL exceeds threshold)
function stale(badgeId) {
  var el = document.getElementById(badgeId);
  if (!el) return;
  el.classList.remove('is-fresh');
  el.classList.add('is-stale');
}

window.ArgusDataAge = { mark: mark, stale: stale };

if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusDataAge');

}());
