'use strict';
// core/providers/maritime/maritimeDiagnostics.js
// Per-provider request logging, failure classification, and health metrics.
//
// Every request must call logStart() before and logSuccess() or logFailure() after.
// Failures are NEVER swallowed — every error produces a classified log entry.
//
// Failure classes:
//   CORS            — browser cross-origin block (often surfaces as "Failed to fetch")
//   auth            — HTTP 401 or 403
//   timeout         — AbortController abort / fetch timeout
//   malformed_json  — SyntaxError during JSON parse
//   empty_payload   — HTTP 200 but zero vessels returned
//   upstream_denial — HTTP 5xx or provider-side rejection
//   network_reset   — ECONNRESET or equivalent
//   rate_limit      — HTTP 429
//   schema_mismatch — response parsed but required fields absent
//   unknown         — unclassified failure
//
// Usage:
//   var tok = ArgusMaritimeDiagnostics.logStart('digitraffic');
//   fetch(url).then(function(r) {
//     ArgusMaritimeDiagnostics.logSuccess(tok, r.status, vessels.length, bytes);
//   }).catch(function(err) {
//     ArgusMaritimeDiagnostics.logFailure(tok, err, null);
//   });
//
// Inspection:
//   ArgusMaritimeDiagnostics.report()          — prints health table to console
//   ArgusMaritimeDiagnostics.getHealth()       — returns structured health object
//   ArgusMaritimeDiagnostics.getLogs('name')   — returns ring buffer for provider

(function () {
  'use strict';

  var RING_SIZE = 50; // log entries kept per provider

  var _logs   = {};  // provider → Array (ring buffer of log entries)
  var _health = {};  // provider → {ok, fail, lastMs, lastStatus, lastError}

  // ── Failure class constants ────────────────────────────────────────────────────
  var FAIL = {
    CORS:            'CORS',
    AUTH:            'auth',
    TIMEOUT:         'timeout',
    MALFORMED_JSON:  'malformed_json',
    EMPTY_PAYLOAD:   'empty_payload',
    UPSTREAM_DENIAL: 'upstream_denial',
    NETWORK_RESET:   'network_reset',
    RATE_LIMIT:      'rate_limit',
    SCHEMA_MISMATCH: 'schema_mismatch',
    UNKNOWN:         'unknown',
  };

  // ── Failure classifier ────────────────────────────────────────────────────────
  // Browser CORS blocks surface as "Failed to fetch" (Chrome/Firefox) or
  // "Load failed" (Safari) — there is no way to get the HTTP status code.
  // Classify these as CORS so operators know to add a server-side proxy.
  function classifyFailure(err, httpStatus) {
    var msg = err ? (err.message || String(err)).toLowerCase() : '';
    if (httpStatus === 429)                                    return FAIL.RATE_LIMIT;
    if (httpStatus === 401 || httpStatus === 403)              return FAIL.AUTH;
    if (httpStatus >= 500)                                     return FAIL.UPSTREAM_DENIAL;
    if (httpStatus >= 400)                                     return FAIL.AUTH;
    if (msg.includes('failed to fetch') ||
        msg.includes('load failed')     ||
        msg.includes('cors')            ||
        msg.includes('cross-origin'))                         return FAIL.CORS;
    if (msg.includes('aborted') || msg.includes('timeout'))   return FAIL.TIMEOUT;
    if (msg.includes('syntaxerror') ||
        msg.includes('unexpected token'))                     return FAIL.MALFORMED_JSON;
    if (msg.includes('econnreset') || msg.includes('reset'))  return FAIL.NETWORK_RESET;
    return FAIL.UNKNOWN;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────────
  function _ensureProvider(id) {
    if (!_logs[id]) {
      _logs[id]   = [];
      _health[id] = { ok: 0, fail: 0, lastMs: 0, lastStatus: null, lastError: null };
    }
  }

  function _push(id, entry) {
    _ensureProvider(id);
    _logs[id].push(entry);
    if (_logs[id].length > RING_SIZE) _logs[id].shift();
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  // Call BEFORE the fetch — returns an opaque token for logSuccess/logFailure.
  function logStart(provider) {
    _ensureProvider(provider);
    return { provider: provider, t0: Date.now() };
  }

  // Call after a successful response.
  // rateLimitHeaders: object containing x-rate-limit-* headers if present, else null.
  function logSuccess(token, httpStatus, vesselCount, responseBytes, rateLimitHeaders) {
    var nowMs      = Date.now();
    var durationMs = nowMs - token.t0;
    var entry = {
      ok:               true,
      provider:         token.provider,
      durationMs:       durationMs,
      httpStatus:       httpStatus,
      vesselCount:      vesselCount,
      responseBytes:    responseBytes || 0,
      rateLimitHeaders: rateLimitHeaders || null,
      timestamp:        nowMs,
    };
    _push(token.provider, entry);
    var h = _health[token.provider];
    h.ok++;
    h.lastMs     = nowMs;
    h.lastStatus = httpStatus;
    h.lastError  = null;
    return entry;
  }

  // Call on any failure. err is an Error object; httpStatus is optional.
  function logFailure(token, err, httpStatus) {
    var nowMs      = Date.now();
    var durationMs = nowMs - token.t0;
    var failClass  = classifyFailure(err, httpStatus);
    var entry = {
      ok:         false,
      provider:   token.provider,
      durationMs: durationMs,
      httpStatus: httpStatus || null,
      failClass:  failClass,
      message:    err ? (err.message || String(err)) : 'unknown error',
      timestamp:  nowMs,
    };
    _push(token.provider, entry);
    var h = _health[token.provider];
    h.fail++;
    h.lastMs     = nowMs;
    h.lastStatus = httpStatus || null;
    h.lastError  = failClass;
    console.warn('[MaritimeDiagnostics]', token.provider, '⚠', failClass, '—', entry.message);
    return entry;
  }

  // Returns a copy of the log ring buffer for one provider, or all providers.
  function getLogs(provider) {
    if (provider) return (_logs[provider] || []).slice();
    var all = {};
    Object.keys(_logs).forEach(function (p) { all[p] = _logs[p].slice(); });
    return all;
  }

  // Returns a structured health summary for all tracked providers.
  function getHealth() {
    var out = {};
    Object.keys(_health).forEach(function (p) {
      var h    = _health[p];
      var log  = _logs[p] || [];
      var ok   = log.filter(function (e) { return e.ok; });
      var avgMs = ok.length
        ? Math.round(ok.reduce(function (a, e) { return a + e.durationMs; }, 0) / ok.length)
        : null;
      out[p] = {
        totalOk:         h.ok,
        totalFail:       h.fail,
        successRate:     h.ok + h.fail > 0 ? +(h.ok / (h.ok + h.fail)).toFixed(2) : null,
        avgDurationMs:   avgMs,
        lastVesselCount: ok.length ? ok[ok.length - 1].vesselCount : null,
        lastMs:          h.lastMs,
        lastStatus:      h.lastStatus,
        lastError:       h.lastError,
      };
    });
    return out;
  }

  // Prints a formatted health report to the browser console.
  // Call this in DevTools: ArgusMaritimeDiagnostics.report()
  function report() {
    var h = getHealth();
    var keys = Object.keys(h);
    if (!keys.length) {
      console.log('[ArgusMaritimeDiagnostics] No provider data yet.');
      return h;
    }
    console.group('[ArgusMaritimeDiagnostics] Provider Health Report');
    keys.forEach(function (p) {
      var d    = h[p];
      var rate = d.successRate !== null ? (d.successRate * 100).toFixed(0) + '%' : 'n/a';
      var flag = d.lastError ? ('⚠ ' + d.lastError) : '✓';
      console.log(
        p.toUpperCase().padEnd(22),
        ('ok=' + d.totalOk).padEnd(8),
        ('fail=' + d.totalFail).padEnd(8),
        ('rate=' + rate).padEnd(10),
        ('avg=' + (d.avgDurationMs || '—') + 'ms').padEnd(12),
        ('vessels=' + (d.lastVesselCount != null ? d.lastVesselCount : '—')).padEnd(14),
        flag
      );
    });
    console.groupEnd();
    return h;
  }

  window.ArgusMaritimeDiagnostics = {
    FAIL:            FAIL,
    classifyFailure: classifyFailure,
    logStart:        logStart,
    logSuccess:      logSuccess,
    logFailure:      logFailure,
    getLogs:         getLogs,
    getHealth:       getHealth,
    report:          report,
  };

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusMaritimeDiagnostics');
}());
