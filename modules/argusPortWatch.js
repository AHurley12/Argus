window.ArgusPortWatch = (function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────────────
  var POLL_MS   = 10 * 60 * 1000;  // 10-minute poll — data is daily, no need for faster
  var ENDPOINT  = '/.netlify/functions/fetch-portwatch';

  // ── Categorization map (spec §5) ────────────────────────────────────────────
  var PORT_CATEGORIES = {
    IMPORT_CONTAINER: { key: 'imports.container' },
    EXPORT_CONTAINER: { key: 'exports.container' },
    IMPORT_TANKER:    { key: 'imports.tanker'    },
    EXPORT_TANKER:    { key: 'exports.tanker'    },
    TOTAL_ACTIVITY:   { key: 'total_calls'       },
  };

  // ── Color scale (spec §6) ────────────────────────────────────────────────────
  var PORT_COLOR_SCALE = {
    LOW:      '#2ecc71',  // green
    MED:      '#f1c40f',  // yellow
    HIGH:     '#e67e22',  // orange
    CRITICAL: '#e74c3c',  // red
  };

  // ── Intensity classifier — min/max scaled across the live dataset ────────────
  function getPortIntensity(value, min, max) {
    if (max <= min) return { level: 'LOW', color: PORT_COLOR_SCALE.LOW };
    var norm = Math.max(0, Math.min(1, (value - min) / (max - min)));
    if (norm < 0.25) return { level: 'LOW',      color: PORT_COLOR_SCALE.LOW      };
    if (norm < 0.55) return { level: 'MED',      color: PORT_COLOR_SCALE.MED      };
    if (norm < 0.80) return { level: 'HIGH',     color: PORT_COLOR_SCALE.HIGH     };
    return             { level: 'CRITICAL', color: PORT_COLOR_SCALE.CRITICAL };
  }

  // ── Chokepoint name → our internal ID mapping ────────────────────────────────
  // Regex matched against "portname country" — additive, new IDs can be appended.
  var CHOKEPOINT_MATCHERS = [
    // Gulf / Indian Ocean
    { id: 'hormuz',      re: /jebel.ali|abu.dhabi|muscat|bandar.?abbas|fujairah|salalah|sohar|khor.fakkan|umm.al.quwain/i },
    { id: 'bab_cp',      re: /djibouti|aden|hodeidah|berbera|obock/i },
    // Mediterranean / Black Sea
    { id: 'suez',        re: /port.?said|suez|damietta|ismailia/i },
    { id: 'bosphorus',   re: /istanbul|ambarli|haydarpasa|izmit|gebze|derince|tekirdag/i },
    { id: 'dardanelles', re: /canakkale|izmir|aliaga/i },
    // Atlantic / North Sea
    // 'gibraltar' removed — no matching chokepoint ID in the UI; algeciras/tangier served by nearby data
    { id: 'dover',       re: /calais|dunkerque|zeebrugge|antwerp|antwerpen|rotterdam|felixstowe|dover/i },
    // Baltic approaches
    { id: 'oresund',     re: /copenhagen|kobenhavn|malmoe|malmö|helsingborg|helsingor|elsinore|aarhus/i },
    { id: 'great_belt',  re: /fredericia|odense|vejle|korsoor|korsoer|nyborg/i },
    // Americas
    { id: 'panama_cp',   re: /balboa|colon|cristobal|panama/i },
    // Asia-Pacific
    { id: 'malacca',     re: /singapore|port.klang|tanjung.pelepas|penang|batam|belawan|dumai/i },
    { id: 'taiwan_cp',   re: /keelung|kaohsiung|taichung|taipei|xiamen|amoy/i },
    { id: 'lombok',      re: /lombok|makassar|surabaya|balikpapan/i },
    { id: 'sunda',       re: /merak|panjang|cilegon|banten/i },
    // Southern routes
    { id: 'cape_cp',     re: /cape.?town|durban|port.elizabeth|east.london/i },
  ];

  function matchChokepoint(portname, country) {
    var combined = ((portname || '') + ' ' + (country || ''));
    for (var i = 0; i < CHOKEPOINT_MATCHERS.length; i++) {
      if (CHOKEPOINT_MATCHERS[i].re.test(combined)) return CHOKEPOINT_MATCHERS[i].id;
    }
    return null;
  }

  // ── State (separate from AIS — spec §3) ─────────────────────────────────────
  var _state = {
    ports:     new Map(),  // portid → normalized port object  (NOT vessels)
    lastFetch: 0,
    lastHash:  '',
    period:    '',
    signals:   [],
  };
  window._portWatchState = _state;

  // ── Normalization (spec §2 strict schema) ────────────────────────────────────
  function num(v) { return (v == null || v === '') ? 0 : Number(v) || 0; }

  function normalizeIMFPortData(features) {
    return features
      .map(function (f) {
        var a = f.attributes || f;  // ArcGIS wraps in .attributes
        var portid = String(a.portid || '').trim();
        if (!portid) return null;

        var portname = String(a.portname || '').trim();
        var country  = String(a.country  || '').trim();

        return {
          id:            portid,
          type:          'PORT_ACTIVITY',
          port:          portname,
          country:       country,
          total_calls:   num(a.portcalls),
          imports_total: num(a.import),
          exports_total: num(a.export),
          imports: {
            container: num(a.import_container),
            tanker:    num(a.import_tanker),
          },
          exports: {
            container: num(a.export_container),
            tanker:    num(a.export_tanker),
          },
          // Flat categories object for uniform classification (spec §5)
          categories: {
            import_container: num(a.import_container),
            export_container: num(a.export_container),
            import_tanker:    num(a.import_tanker),
            export_tanker:    num(a.export_tanker),
          },
          date:         num(a.date),
          year:         num(a.year),
          month:        num(a.month),
          source:       'IMF_PORTWATCH',
          visual:       null,          // assigned after dataset min/max
          chokepointId: matchChokepoint(portname, country),
        };
      })
      .filter(Boolean);
  }

  // ── Visual assignment — requires full dataset for accurate min/max ────────────
  function assignVisuals(ports) {
    if (!ports.length) return;
    var values = ports.map(function (p) { return p.total_calls; });
    var minV   = Math.min.apply(null, values);
    var maxV   = Math.max.apply(null, values);
    ports.forEach(function (p) {
      p.visual = getPortIntensity(p.total_calls, minV, maxV);
    });
  }

  // ── Analytics layer (spec §7) — signals only, no DOM writes ─────────────────
  function runAnalytics(ports) {
    var signals = [];

    ports.forEach(function (p) {

      // Disruption: port calls at zero while flow data exists → possible closure
      if (p.total_calls === 0 && (p.imports_total > 0 || p.exports_total > 0)) {
        signals.push({
          type:     'DISRUPTION',
          severity: 'WARNING',
          port:     p.port,
          country:  p.country,
          detail:   p.port + ' (' + p.country + '): port calls dropped to zero — possible disruption or data gap',
          portId:   p.id,
          chokepointId: p.chokepointId,
          source:   'IMF_PORTWATCH',
        });
        return; // if zero calls, ratio checks are meaningless
      }

      // Trade imbalance: import/export ratio > 3:1 or < 1:3 on meaningful volume
      if (p.imports_total + p.exports_total >= 10 && p.exports_total > 0 && p.imports_total > 0) {
        var ratio = p.imports_total / p.exports_total;
        if (ratio > 3) {
          signals.push({
            type:     'TRADE_IMBALANCE',
            severity: 'WATCH',
            port:     p.port,
            country:  p.country,
            detail:   p.port + ' (' + p.country + '): import surplus — ratio ' + ratio.toFixed(1) + ':1 (possible supply accumulation or export constraint)',
            portId:   p.id,
            chokepointId: p.chokepointId,
            source:   'IMF_PORTWATCH',
          });
        } else if (ratio < 0.33) {
          signals.push({
            type:     'TRADE_IMBALANCE',
            severity: 'WATCH',
            port:     p.port,
            country:  p.country,
            detail:   p.port + ' (' + p.country + '): export surplus — ratio 1:' + (1 / ratio).toFixed(1) + ' (possible demand shock or strategic stockpiling)',
            portId:   p.id,
            chokepointId: p.chokepointId,
            source:   'IMF_PORTWATCH',
          });
        }
      }

      // Energy concentration: tanker share > 70% → chokepoint energy sensitivity
      if (p.total_calls >= 20) {
        var tankerTotal = p.imports.tanker + p.exports.tanker;
        var tankerShare = tankerTotal / p.total_calls;
        if (tankerShare > 0.70) {
          signals.push({
            type:     'ENERGY_CONCENTRATION',
            severity: 'WATCH',
            port:     p.port,
            country:  p.country,
            detail:   p.port + ' (' + p.country + '): ' + Math.round(tankerShare * 100) + '% tanker traffic — elevated energy route sensitivity',
            portId:   p.id,
            chokepointId: p.chokepointId,
            source:   'IMF_PORTWATCH',
          });
        }
      }
    });

    return signals;
  }

  // ── Backward-compat: populate window._portData ────────────────────────────────
  // Existing chokepoint detail panel + buildSnapshot() already read from
  // window._portData[chokepointId] — this keeps those hooks working without
  // any modification to the existing code.
  function populateLegacyPortData(ports) {
    var legacy = {};
    ports.forEach(function (p) {
      var cpId = p.chokepointId;
      if (!cpId) return;
      // If multiple ports match the same chokepoint, keep the busiest one
      if (legacy[cpId] && (legacy[cpId]._calls || 0) >= p.total_calls) return;
      legacy[cpId] = {
        portname:            p.port,
        portcalls:           p.total_calls,
        portcalls_container: p.categories.import_container + p.categories.export_container,
        portcalls_tanker:    p.categories.import_tanker    + p.categories.export_tanker,
        portcalls_dry_bulk:  0,  // not in PortWatch outFields (80/20 exclusion)
        import:              p.imports_total,
        export:              p.exports_total,
        year:                p.year,
        month:               p.month,
        day:                 1,  // PortWatch is monthly; day=1 placeholder
        _calls:              p.total_calls,  // dedup key — not rendered
      };
    });
    window._portData = legacy;
  }

  // ── Memoization hash — avoids reprocessing unchanged fetches ─────────────────
  function quickHash(features) {
    var first = features[0] && (features[0].attributes || features[0]);
    return String(features.length) + '_' + String(first && (first.date || first.year || 0));
  }

  // ── Core fetch + ingest (spec §1 + §4) ───────────────────────────────────────
  async function fetchIMFPortData() {
    // Respect tab-visibility gate (set by SCRIPT 5 Visibility API)
    if (window._argusTabVisible === false) return;

    try {
      var res = await fetch(ENDPOINT, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);

      var json = await res.json();
      if (json.error) throw new Error(json.error);

      var features = Array.isArray(json.features) ? json.features : [];
      if (!features.length) {
        console.warn('[ArgusPortWatch] Netlify function returned 0 features');
        return;
      }

      // Memoize — skip full reprocess if data hash unchanged (spec §8)
      var hash = quickHash(features);
      if (hash === _state.lastHash) {
        console.log('[ArgusPortWatch] data unchanged (' + hash + ') — skipping reprocess');
        return;
      }
      _state.lastHash = hash;
      _state.period   = json.period || '';

      // ── Normalize → color → state → analytics ──────────────────────────────
      var ports = normalizeIMFPortData(features);  // strict schema
      assignVisuals(ports);                         // min/max color scale

      _state.ports.clear();
      ports.forEach(function (p) { _state.ports.set(p.id, p); });

      _state.signals         = runAnalytics(ports);  // disruption / imbalance / energy
      window._portWatchSignals = _state.signals;      // expose for buildSnapshot + neural web

      populateLegacyPortData(ports);  // fills window._portData for existing UI

      _state.lastFetch = Date.now();

      // Signal to any open detail panel that port data is now ready
      window.dispatchEvent(new CustomEvent('argus:portwatch:ready'));

      var cpKeys = Object.keys(window._portData || {});
      console.log(
        '[ArgusPortWatch] ingested ' + ports.length + ' ports' +
        ' | period=' + _state.period +
        ' | signals=' + _state.signals.length +
        ' | chokepoints matched: ' + (cpKeys.length ? cpKeys.join(', ') : 'none')
      );

    } catch (err) {
      console.warn('[ArgusPortWatch] fetch error:', err.message);
    }
  }

  // ── Bootstrap — defer initial fetch to idle so it doesn't block first render ──
  // Port data is non-critical at startup; no UI is gated on it at load time.
  // requestIdleCallback lets the browser complete render boot before the first fetch.
  var _pollTimer = null;
  (window.requestIdleCallback || function(cb) { setTimeout(cb, 200); })(function() {
    fetchIMFPortData();
    _pollTimer = setInterval(fetchIMFPortData, POLL_MS);
    if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusPortWatch', { deferred: true });
  });

  return {
    getState:         function () { return _state; },
    getPortIntensity: getPortIntensity,
    PORT_COLOR_SCALE: PORT_COLOR_SCALE,
    PORT_CATEGORIES:  PORT_CATEGORIES,
    refresh:          fetchIMFPortData,
    _pollTimer:       _pollTimer,
  };
}());
