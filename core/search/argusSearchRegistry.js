'use strict';
// core/search/argusSearchRegistry.js
// Unified search and navigation registry for ARGUS.
//
// Design: one flat entry array covering all searchable entity types.
// Phase 1: country, chokepoint
// Phase 2: port, lng
// Phase 3 (future): register(type, entries) — identical call for events/flights/vessels
//
// Entry shape (internal):
//   { id, type, name, aliases[], lat, lon, metadata }
//
// Query behavior (deterministic, no AI):
//   score 3 — exact name match
//   score 2 — name starts with query (prefix)
//   score 1 — name or any alias contains query (substring)
//   Results sorted: score desc → type priority → name asc
//   Capped at 12 results — sufficient for navigation, avoids scroll overflow
//
// Phase 3 expansion: call register(type, preparedEntries) from any module
// that has lat/lon-bearing entities. No registry redesign needed.
//
// Dependencies: window.COUNTRIES_DATA, window.CHOKEPOINTS_DATA,
//               window.PORTS_DATA, window.LNG_FACILITIES_DATA
// Public API: window.ArgusSearchRegistry
//   .init()              — populate from window globals (call once at page ready)
//   .register(entries)   — add pre-built entries (Phase 3 dynamic expansion)
//   .query(text)         — returns filtered/sorted entry array
//   .getAll()            — returns full entry array (diagnostic)
//   .getCount()          — total entry count

window.ArgusSearchRegistry = (function () {
  'use strict';

  var _entries = [];   // flat array of all registered entries

  // ── Type display priority (lower = earlier in results) ───────────────────
  var _TYPE_ORDER = { country: 0, chokepoint: 1, port: 2, lng: 3 };

  // ── Country short-form aliases ────────────────────────────────────────────
  // Deterministic string map — covers the most common lookup shorthands.
  // Searched via the aliases[] array per entry; not fuzzy, not AI.
  var _COUNTRY_ALIASES = {
    'GBR': ['uk', 'britain', 'great britain', 'england'],
    'USA': ['us', 'america', 'united states of america'],
    'CHN': ['prc', 'peoples republic of china'],
    'RUS': ['russia', 'russian federation'],
    'KOR': ['south korea', 'republic of korea'],
    'PRK': ['north korea', 'dprk'],
    'TWN': ['taiwan', 'republic of china'],
    'IRN': ['iran', 'persia'],
    'ARE': ['uae', 'emirates'],
    'CZE': ['czech', 'czechia'],
    'BIH': ['bosnia'],
    'VNM': ['vietnam'],
    'MDA': ['moldova'],
    'MKD': ['north macedonia', 'macedonia'],
    'SAU': ['ksa', 'saudi'],
    'ISR': ['israel', 'isr'],
    'PAK': ['pakistan'],
    'NGA': ['nigeria'],
    'ZAF': ['south africa'],
  };

  // ── Scoring ───────────────────────────────────────────────────────────────
  // Returns 3=exact, 2=prefix, 1=contains, 0=no match.
  // Operates on pre-normalized lowercase strings.
  function _score(haystack, needle) {
    if (haystack === needle)               return 3;
    if (haystack.indexOf(needle) === 0)    return 2;
    if (haystack.indexOf(needle) !== -1)   return 1;
    return 0;
  }

  // ── Shallow copy (ES5 safe) ───────────────────────────────────────────────
  function _copy(src) {
    var out = {};
    for (var k in src) {
      if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
    }
    return out;
  }

  // ── Public: register ──────────────────────────────────────────────────────
  // Phase 3 entry point — accepts an array of pre-built entry objects.
  // Each entry must carry: { id, type, name, aliases[], lat, lon, metadata }
  // Called by init() internally; can also be called by future dynamic modules.
  function register(entries) {
    for (var i = 0; i < entries.length; i++) {
      _entries.push(entries[i]);
    }
  }

  // ── Public: query ─────────────────────────────────────────────────────────
  // Returns matching entries sorted by relevance, capped at 12.
  // Input under 2 characters returns an empty array — avoids noise on first keystroke.
  function query(text) {
    var q = text ? text.trim().toLowerCase() : '';
    if (q.length < 2) return [];

    var scored = [];
    for (var i = 0; i < _entries.length; i++) {
      var e    = _entries[i];
      var best = _score(e.name.toLowerCase(), q);
      if (best < 3) {
        for (var j = 0; j < e.aliases.length; j++) {
          var s = _score(e.aliases[j], q);
          if (s > best) { best = s; if (best === 3) break; }
        }
      }
      if (best > 0) scored.push({ entry: e, score: best });
    }

    scored.sort(function (a, b) {
      if (b.score !== a.score)           return b.score - a.score;
      var ta = _TYPE_ORDER[a.entry.type] !== undefined ? _TYPE_ORDER[a.entry.type] : 99;
      var tb = _TYPE_ORDER[b.entry.type] !== undefined ? _TYPE_ORDER[b.entry.type] : 99;
      if (ta !== tb)                     return ta - tb;
      return a.entry.name < b.entry.name ? -1 : a.entry.name > b.entry.name ? 1 : 0;
    });

    var out = [];
    var cap = Math.min(scored.length, 12);
    for (var k = 0; k < cap; k++) out.push(scored[k].entry);
    return out;
  }

  // ── Public: init ─────────────────────────────────────────────────────────
  // Populates the registry from all available window globals.
  // Called once at page-ready by ArgusSearchUI.
  function init() {
    _entries = [];

    // ── Countries (from static-data.js, ~152 entries) ──────────────────────
    var CD = window.COUNTRIES_DATA;
    if (CD) {
      for (var ci = 0; ci < CD.length; ci++) {
        var c       = CD[ci];
        var cMeta   = _copy(c);
        cMeta.isCountry = true;
        var cAl     = [c.code.toLowerCase()];
        var extra   = _COUNTRY_ALIASES[c.code];
        if (extra) {
          for (var xi = 0; xi < extra.length; xi++) cAl.push(extra[xi]);
        }
        _entries.push({
          id:       'country:' + c.code,
          type:     'country',
          name:     c.label,
          aliases:  cAl,
          lat:      c.rawLat,
          lon:      c.rawLon,
          metadata: cMeta,
        });
      }
    }

    // ── Chokepoints (from static-data.js, 14 entries) ─────────────────────
    var KD = window.CHOKEPOINTS_DATA;
    if (KD) {
      for (var ki = 0; ki < KD.length; ki++) {
        var cp     = KD[ki];
        var cpMeta = _copy(cp);
        cpMeta.isChokepoint = true;
        // Short-form alias: 'suez canal' → 'suez'; 'strait of hormuz' → 'hormuz'; etc.
        var cpShort = cp.id.replace(/_cp$/, '').replace(/_/g, ' ');
        _entries.push({
          id:       'chokepoint:' + cp.id,
          type:     'chokepoint',
          name:     cp.label,
          aliases:  [cpShort],
          lat:      cp.rawLat,
          lon:      cp.rawLon,
          metadata: cpMeta,
        });
      }
    }

    // ── Ports (from static-data-search.js) ───────────────────────────────
    var PD = window.PORTS_DATA;
    if (PD) {
      for (var pi = 0; pi < PD.length; pi++) {
        var p     = PD[pi];
        var pMeta = _copy(p);
        pMeta.isPort = true;
        // Aliases: country name + simplified port id strip
        var pIdAlias = p.id.replace(/^port_/, '').replace(/_/g, ' ');
        _entries.push({
          id:       'port:' + p.id,
          type:     'port',
          name:     p.label,
          aliases:  [p.country.toLowerCase(), p.region.toLowerCase(), pIdAlias],
          lat:      p.lat,
          lon:      p.lon,
          metadata: pMeta,
        });
      }
    }

    // ── LNG Facilities (from static-data-search.js) ───────────────────────
    var LD = window.LNG_FACILITIES_DATA;
    if (LD) {
      for (var li = 0; li < LD.length; li++) {
        var lng     = LD[li];
        var lMeta   = _copy(lng);
        lMeta.isLNG = true;
        var lIdAlias = lng.id.replace(/^lng_/, '').replace(/_/g, ' ');
        _entries.push({
          id:       'lng:' + lng.id,
          type:     'lng',
          name:     lng.label,
          aliases:  [lng.country.toLowerCase(), lng.operator.toLowerCase(), lIdAlias],
          lat:      lng.lat,
          lon:      lng.lon,
          metadata: lMeta,
        });
      }
    }

    var counts = {
      countries:   CD ? CD.length : 0,
      chokepoints: KD ? KD.length : 0,
      ports:       PD ? PD.length : 0,
      lng:         LD ? LD.length : 0,
    };
    console.log('[ArgusSearchRegistry] init — ' + _entries.length + ' entries', counts);
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────
  function getAll()   { return _entries.slice(); }
  function getCount() { return _entries.length; }

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusSearchRegistry');

  return {
    init:     init,
    register: register,
    query:    query,
    getAll:   getAll,
    getCount: getCount,
  };

}());
