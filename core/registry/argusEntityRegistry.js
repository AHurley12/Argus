'use strict';
// core/registry/argusEntityRegistry.js
// Centralized entity registry — single authoritative source of truth for all
// interactive entity state (aircraft, VesselAPI ships, AIS vessels).
//
// Replaces three fragmented parallel structures:
//   aircraftHits / window._aircraftMarkers  (argusTracking.js)
//   shipHits     / window._vesselMarkers    (argusTracking.js)
//   _aisSprites  / window._aisSprites       (argusAIS.js)
//
// Architecture:
//   Producers call register() / remove() / clearType() to maintain state.
//   Consumers call getSprites(types) for raycasters, ArgusSelection, NeuralWeb.
//   Compat getters on window._aircraftMarkers etc. make legacy consumers work
//   without modification — those globals now delegate here instead of holding
//   their own stale copies.
//
// Entity types: 'aircraft' | 'ship' | 'ais_vessel'
// Entity record: { id, type, sprite, data }
//
// Lifecycle patterns:
//   Full-rebuild (aircraft, ship): clearType() → N × register()  — every 90s / 30min
//   Incremental   (ais_vessel):    register() / remove()          — per WS message
//
// Dependencies: none (loads before all entity modules)
// Public API:   window.ArgusEntityRegistry, window.ArgusRegistryAudit

window.ArgusEntityRegistry = (function () {
  'use strict';

  // ── Canonical store ─────────────────────────────────────────────────────────
  var _entities = new Map();  // id → { id, type, sprite, data }

  // Type-indexed sprite arrays — kept in sync with _entities.
  // Direct references allow O(1) getSprites() for single-type queries.
  var _acArr  = [];  // type === 'aircraft'
  var _shArr  = [];  // type === 'ship'
  var _aisArr = [];  // type === 'ais_vessel'

  // ── Audit counters ──────────────────────────────────────────────────────────
  var _audit = { registered: 0, updated: 0, removed: 0, typesCleared: 0 };

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function _typeArr(type) {
    if (type === 'aircraft')   return _acArr;
    if (type === 'ship')       return _shArr;
    if (type === 'ais_vessel') return _aisArr;
    return null;
  }

  // ── register — create or overwrite a single entity record ───────────────────
  // For full-rebuild types, clearType() is called first so no existing record
  // exists. For AIS (incremental), an existing record means the sprite ref is
  // stable — skip array push, just update data.
  function register(id, type, sprite, data) {
    if (_entities.has(id)) {
      var ent = _entities.get(id);
      // Sprite identity may change when pool returns a different object.
      // Swap in the type array so getSprites() stays current.
      if (ent.sprite !== sprite) {
        var arr = _typeArr(ent.type);
        if (arr) {
          var oi = arr.indexOf(ent.sprite);
          if (oi !== -1) arr[oi] = sprite;  // swap in place — preserves array order
        }
        ent.sprite = sprite;
      }
      ent.data = data;
      _audit.updated++;
      return;
    }
    _entities.set(id, { id: id, type: type, sprite: sprite, data: data });
    var ta = _typeArr(type);
    if (ta) ta.push(sprite);
    _audit.registered++;
  }

  // ── remove — evict a single entity (AIS cap eviction, layer toggle) ─────────
  function remove(id) {
    var ent = _entities.get(id);
    if (!ent) return;
    var arr = _typeArr(ent.type);
    if (arr) {
      var i = arr.indexOf(ent.sprite);
      if (i !== -1) arr.splice(i, 1);
    }
    _entities.delete(id);
    _audit.removed++;
  }

  // ── clearType — bulk-evict all entities of a type (full-rebuild cycles) ─────
  // Called at the top of renderAircraft() / renderShips() before the new batch
  // of register() calls. O(entity-count) but unavoidable for full rebuilds.
  function clearType(type) {
    var arr = _typeArr(type);
    if (arr) arr.length = 0;
    var toDelete = [];
    _entities.forEach(function (ent, id) { if (ent.type === type) toDelete.push(id); });
    for (var i = 0; i < toDelete.length; i++) _entities.delete(toDelete[i]);
    _audit.typesCleared++;
  }

  // ── get — fetch a single entity record by ID ─────────────────────────────────
  // Returns null (not undefined) when the entity is not registered.
  function get(id) { return _entities.get(id) || null; }

  // ── getSprites — filtered sprite array for raycasters / ArgusSelection ────────
  // Single-type: returns the live type array by reference — zero allocation.
  // Multi-type or unfiltered: allocates and returns a concatenated snapshot.
  function getSprites(types) {
    if (!types || !types.length) {
      return _acArr.concat(_shArr, _aisArr);
    }
    if (types.length === 1) return _typeArr(types[0]) || [];
    var out = [];
    for (var i = 0; i < types.length; i++) {
      var a = _typeArr(types[i]);
      if (a) for (var j = 0; j < a.length; j++) out.push(a[j]);
    }
    return out;
  }

  // ── getCount — entity count, optionally filtered by type ─────────────────────
  function getCount(type) {
    if (type) return (_typeArr(type) || []).length;
    return _entities.size;
  }

  // ── getAudit ─────────────────────────────────────────────────────────────────
  function getAudit() {
    var orphaned = 0;
    _entities.forEach(function (ent) {
      var arr = _typeArr(ent.type);
      if (arr && arr.indexOf(ent.sprite) === -1) orphaned++;
    });
    return {
      totalEntities: _entities.size,
      aircraftCount: _acArr.length,
      shipCount:     _shArr.length,
      aisCount:      _aisArr.length,
      registered:    _audit.registered,
      updated:       _audit.updated,
      removed:       _audit.removed,
      typesCleared:  _audit.typesCleared,
      orphaned:      orphaned,
    };
  }

  // ── Compatibility window.* getters ────────────────────────────────────────────
  // window._aircraftMarkers / _vesselMarkers / _aisSprites were previously plain
  // array assignments in argusTracking.js / argusAIS.js. Installing getters here
  // makes every existing consumer (raycasters, NeuralWeb, analysis functions)
  // transparently read from the registry without any changes to those callers.
  //
  // REQUIREMENT: the plain `window._aircraftMarkers = aircraftHits` assignments
  // in argusTracking.js and `window._aisSprites = _aisSprites` in argusAIS.js
  // MUST be removed. A strict-mode write to a getter-only property throws TypeError.
  try {
    Object.defineProperty(window, '_aircraftMarkers', {
      get: function () { return _acArr; },
      configurable: true, enumerable: true,
    });
    Object.defineProperty(window, '_vesselMarkers', {
      get: function () { return _shArr; },
      configurable: true, enumerable: true,
    });
    Object.defineProperty(window, '_aisSprites', {
      get: function () { return _aisArr; },
      configurable: true, enumerable: true,
    });
  } catch (e) {
    console.warn('[ArgusEntityRegistry] compat getter install failed —',
      'ensure window._* plain assignments are removed from argusTracking.js + argusAIS.js:', e.message);
  }

  console.log('[ArgusEntityRegistry] ready');

  return {
    register:   register,
    remove:     remove,
    clearType:  clearType,
    get:        get,
    getSprites: getSprites,
    getCount:   getCount,
    getAudit:   getAudit,
  };
}());

// ── ArgusRegistryAudit — console diagnostic ───────────────────────────────────
// Usage: ArgusRegistryAudit.get()
window.ArgusRegistryAudit = {
  get: function () {
    return window.ArgusEntityRegistry ? window.ArgusEntityRegistry.getAudit() : null;
  },
};

if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusEntityRegistry');
