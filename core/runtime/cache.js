'use strict';

// ── Event listener registry ───────────────────────────────────────────────────
// Tracks every addEventListener call made by the globe engine so that all
// handlers can be removed in one pass on beforeunload. Without this, browsers
// may retain the JS heap (including Three.js objects) for the lifetime of the
// tab even after navigation, because live event handlers count as GC roots.
// Usage: evtMgr.add(element, event, handler[, options])
//        evtMgr.removeAll()
(function() {
  function EventManager() {
    // Map<element, Array<{event, handler, options}>>
    this._reg = new Map();
  }
  EventManager.prototype.add = function(element, event, handler, options) {
    if (!this._reg.has(element)) this._reg.set(element, []);
    this._reg.get(element).push({ event: event, handler: handler, options: options });
    element.addEventListener(event, handler, options);
  };
  EventManager.prototype.removeAll = function() {
    this._reg.forEach(function(entries, element) {
      entries.forEach(function(e) {
        element.removeEventListener(e.event, e.handler, e.options);
      });
    });
    this._reg.clear();
  };
  window.ArgusEventManager = EventManager;
}());

// ── Request coalescer / in-flight cache ───────────────────────────────────────
// Deduplicates concurrent fetches to the same URL (e.g. two rapid calls to the
// aircraft or vessel endpoint while a fetch is already in-flight) and caches
// successful responses for `ttlMs` milliseconds so a brief surge of callers
// all get the same payload without hitting the Netlify function again.
// Backed by a plain Map so memory is bounded to open requests + TTL window.
// Usage: window._argusReqCache.fetch(url) → Promise<response>
(function() {
  function RequestCache(ttlMs) {
    this._ttl     = ttlMs || 30000;
    this._cache   = new Map(); // url → { data, ts }
    this._pending = new Map(); // url → Promise
  }
  RequestCache.prototype.fetch = function(url) {
    var self = this;
    // Return cached entry if still fresh
    var cached = this._cache.get(url);
    if (cached && (Date.now() - cached.ts) < this._ttl) {
      return Promise.resolve(cached.data);
    }
    // Coalesce: reuse in-flight promise if one already exists for this URL
    if (this._pending.has(url)) {
      return this._pending.get(url);
    }
    // Issue a new fetch and cache the result
    var promise = fetch(url)
      .then(function(r) {
        if (!r.ok) return Promise.reject('HTTP ' + r.status);
        return r.json();
      })
      .then(function(data) {
        self._cache.set(url, { data: data, ts: Date.now() });
        self._pending.delete(url);
        return data;
      })
      .catch(function(err) {
        self._pending.delete(url);
        return Promise.reject(err);
      });
    this._pending.set(url, promise);
    return promise;
  };
  // Expose a shared singleton; individual callers can also create their own instances.
  window.ArgusRequestCache = RequestCache;
  window._argusReqCache    = new RequestCache(0); // TTL=0 → coalesce only, no extra caching
}());
