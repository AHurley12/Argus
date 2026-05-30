'use strict';
// core/providers/maritime/maritimeProviderRegistry.js
// Static catalog of maritime data providers with capability matrix.
// Used by diagnostics, browser test harnesses, and scheduling logic.
//
// Fields per provider:
//   id               — unique identifier (used as diagnostics key)
//   name             — human-readable name
//   type             — 'websocket' | 'rest' | 'push'
//   auth             — 'none' | 'api_key' | 'oauth2' | 'enterprise'
//   cors             — 'allowed' | 'server_only' | 'unknown'
//   coverage         — array of geographic descriptors
//   updateCadenceSec — seconds between position updates (null = realtime push)
//   rateLimitPerMin  — requests/min (null = unknown or unlimited)
//   cost             — 'free' | 'freemium' | 'paid' | 'enterprise'
//   viable           — 'active' | 'server_only' | 'auth_required' | 'unverified' | 'blocked'
//   integrated       — boolean (currently wired into Argus)
//   endpoint         — primary API endpoint or null
//   proxyFn          — Netlify function path or null
//   notes            — capability summary and recommendations
//
// printMatrix() — console table of all providers
// runBrowserProbes() — empirically test all browser-accessible endpoints

(function () {
  'use strict';

  var PROVIDERS = [

    // ── Currently integrated ─────────────────────────────────────────────────────
    {
      id:               'aisstream',
      name:             'AISstream.io WebSocket',
      type:             'websocket',
      auth:             'api_key',
      cors:             'allowed',
      coverage:         ['global', '10 strategic maritime regions'],
      updateCadenceSec: null,
      rateLimitPerMin:  null,
      cost:             'freemium',
      viable:           'active',
      integrated:       true,
      endpoint:         'wss://stream.aisstream.io/v0/stream',
      proxyFn:          '/.netlify/functions/ais-config',
      notes:            'Primary real-time AIS source. Push model — no polling. 1500 vessel cap. API key secured via Netlify env. 10 strategic regions subscribed.',
    },
    {
      id:               'vessel_api',
      name:             'VesselAPI REST',
      type:             'rest',
      auth:             'api_key',
      cors:             'server_only',
      coverage:         ['global', '5 regions / 28 corridors'],
      updateCadenceSec: 1800,
      rateLimitPerMin:  null,
      cost:             'paid',
      viable:           'active',
      integrated:       true,
      endpoint:         'https://api.vesselapi.com/v1/location/vessels/bounding-box',
      proxyFn:          '/.netlify/functions/fetch-vessels',
      notes:            'Primary REST vessel source. ~330 credits/day budget. 450 vessel cap. Per-region Supabase cache. Stratified sampling by vessel priority.',
    },
    {
      id:               'aishub',
      name:             'AISHub REST',
      type:             'rest',
      auth:             'api_key',
      cors:             'server_only',
      coverage:         ['global', '10 strategic zones'],
      updateCadenceSec: 120,
      rateLimitPerMin:  1,
      cost:             'free',
      viable:           'active',
      integrated:       true,
      endpoint:         'https://data.aishub.net/ws.php',
      proxyFn:          '/.netlify/functions/ais-vessels',
      notes:            'Free-tier AIS fallback. Sequential zone polling with 200ms stagger (free-tier TOS). 10 zones, ~1800 vessels.',
    },

    // ── Phase 1: newly integrated ────────────────────────────────────────────────
    {
      id:               'digitraffic',
      name:             'Digitraffic.fi (Väylävirasto)',
      type:             'rest',
      auth:             'none',
      cors:             'allowed',
      coverage:         ['Baltic Sea', 'Gulf of Finland', 'Bothnian Bay', 'Bothnian Sea', 'Finnish coastal waters'],
      updateCadenceSec: 120,
      rateLimitPerMin:  null,
      cost:             'free',
      viable:           'active',
      integrated:       true,
      endpoint:         'https://meri.digitraffic.fi/api/v1/locations/latest',
      proxyFn:          '/.netlify/functions/fetch-maritime-supplement',
      notes:            'Open AIS from Finnish Transport Infrastructure Agency. No auth, CORS-enabled. Baltic/North Sea coverage — strong supplement for gap between AISstream regions. Vessel metadata at /api/v1/metadata/vessels.',
    },

    // ── Evaluated but not integrated ────────────────────────────────────────────
    {
      id:               'marinetraffic',
      name:             'MarineTraffic API',
      type:             'rest',
      auth:             'api_key',
      cors:             'server_only',
      coverage:         ['global'],
      updateCadenceSec: null,
      rateLimitPerMin:  null,
      cost:             'paid',
      viable:           'auth_required',
      integrated:       false,
      endpoint:         'https://services.marinetraffic.com/api/',
      proxyFn:          null,
      notes:            'Premium global coverage, high vessel density. Requires paid API units plan. Server-side proxy required (CORS blocked). Best-in-class if budget allows. Probe returns 403.',
    },
    {
      id:               'vesselfinder',
      name:             'VesselFinder API',
      type:             'rest',
      auth:             'api_key',
      cors:             'server_only',
      coverage:         ['global', 'strong European/Mediterranean coverage'],
      updateCadenceSec: null,
      rateLimitPerMin:  null,
      cost:             'paid',
      viable:           'auth_required',
      integrated:       false,
      endpoint:         'https://api.vesselfinder.com/vessels',
      proxyFn:          null,
      notes:            'Good European/Med bias. Paid API key required. Server-side proxy required. Good complement to Digitraffic for Western European waters.',
    },
    {
      id:               'global_fishing_watch',
      name:             'Global Fishing Watch API',
      type:             'rest',
      auth:             'api_key',
      cors:             'allowed',
      coverage:         ['global', 'fishing vessels only'],
      updateCadenceSec: null,
      rateLimitPerMin:  null,
      cost:             'free',
      viable:           'unverified',
      integrated:       false,
      endpoint:         'https://gateway.api.globalfishingwatch.org/v3/events',
      proxyFn:          null,
      notes:            'Free API key (https://globalfishingwatch.org/our-apis/). CORS-enabled. Fishing vessel events, not live AIS positions. Good supplement for fishing fleet layer if GFW_KEY added to env.',
    },
    {
      id:               'kpler',
      name:             'Kpler Maritime Intelligence',
      type:             'rest',
      auth:             'enterprise',
      cors:             'server_only',
      coverage:         ['global', 'commodity vessels — tanker/LNG/bulk specialist'],
      updateCadenceSec: null,
      rateLimitPerMin:  null,
      cost:             'enterprise',
      viable:           'blocked',
      integrated:       false,
      endpoint:         null,
      proxyFn:          null,
      notes:            'Enterprise contract required. Industry-grade commodity flow intelligence. Not viable without formal agreement. Future consideration for tanker analytics.',
    },
    {
      id:               'spire_maritime',
      name:             'Spire Maritime (Satellite AIS)',
      type:             'rest',
      auth:             'enterprise',
      cors:             'server_only',
      coverage:         ['global', 'satellite AIS — full polar coverage'],
      updateCadenceSec: null,
      rateLimitPerMin:  null,
      cost:             'enterprise',
      viable:           'blocked',
      integrated:       false,
      endpoint:         null,
      proxyFn:          null,
      notes:            'S-AIS with polar coverage (gap in all terrestrial AIS providers). Enterprise contract required. Future option for Arctic/Antarctic shipping route monitoring.',
    },
  ];

  // ── Provider lookups ──────────────────────────────────────────────────────────
  function getAll()        { return PROVIDERS.slice(); }
  function getById(id)     { return PROVIDERS.find(function (p) { return p.id === id; }) || null; }
  function getIntegrated() { return PROVIDERS.filter(function (p) { return p.integrated; }); }
  function getViable()     { return PROVIDERS.filter(function (p) { return p.viable === 'active'; }); }

  // Prints the full capability matrix to the browser console.
  function printMatrix() {
    console.group('[ArgusMaritimeProviderRegistry] Capability Matrix');
    console.log(
      'ID'.padEnd(24) + 'AUTH'.padEnd(12) + 'CORS'.padEnd(13) +
      'COST'.padEnd(12) + 'VIABLE'.padEnd(16) + 'INT'
    );
    console.log('─'.repeat(82));
    PROVIDERS.forEach(function (p) {
      console.log(
        p.id.padEnd(24)     +
        p.auth.padEnd(12)   +
        p.cors.padEnd(13)   +
        p.cost.padEnd(12)   +
        p.viable.padEnd(16) +
        (p.integrated ? 'YES' : 'no')
      );
    });
    console.groupEnd();
  }

  // ── Browser-side provider probes ──────────────────────────────────────────────
  // Empirically determines which providers are directly accessible from the browser
  // (no server proxy) vs which are blocked by CORS or require auth.
  // Results are fed into maritimeDiagnostics.
  function runBrowserProbes() {
    var diag = window.ArgusMaritimeDiagnostics;
    if (!diag) { console.warn('[MaritimeProviderRegistry] ArgusMaritimeDiagnostics not loaded'); return; }

    console.group('[ArgusMaritimeProviderRegistry] Running browser-side provider probes…');

    var probes = [
      // Digitraffic — expect: 200 OK, CORS allowed
      {
        id:  'digitraffic_browser',
        url: 'https://meri.digitraffic.fi/api/v1/locations/latest',
        expect: 'CORS allowed, 200 OK',
      },
      // MarineTraffic — expect: CORS blocked or 403 auth
      {
        id:  'marinetraffic_browser',
        url: 'https://services.marinetraffic.com/api/exportvessels/v:8/MMSI:123456789/timespan:5/protocol:jsono',
        expect: 'CORS blocked or 403 auth_required',
      },
      // VesselFinder — expect: CORS blocked or 401/403
      {
        id:  'vesselfinder_browser',
        url: 'https://api.vesselfinder.com/vessels?userkey=test&mmsi=123456789',
        expect: 'CORS blocked or auth_required',
      },
    ];

    probes.forEach(function (probe) {
      var tok = diag.logStart(probe.id);
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, 6000);

      fetch(probe.url, {
        signal:  controller.signal,
        headers: { Accept: 'application/json' },
      })
        .then(function (resp) {
          clearTimeout(timer);
          var status = resp.status;
          console.log(probe.id, '→ HTTP', status, '(expected:', probe.expect + ')');
          diag.logSuccess(tok, status, 0, 0, null);
        })
        .catch(function (err) {
          clearTimeout(timer);
          var entry = diag.logFailure(tok, err, null);
          console.log(probe.id, '→', entry.failClass, '(expected:', probe.expect + ')');
        });
    });

    console.log('Probes fired — results in ArgusMaritimeDiagnostics.report() after ~6s');
    console.groupEnd();

    setTimeout(function () {
      console.group('[ArgusMaritimeProviderRegistry] Probe Results');
      diag.report();
      console.groupEnd();
    }, 7000);
  }

  window.ArgusMaritimeProviderRegistry = {
    getAll:          getAll,
    getById:         getById,
    getIntegrated:   getIntegrated,
    getViable:       getViable,
    printMatrix:     printMatrix,
    runBrowserProbes: runBrowserProbes,
  };

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusMaritimeProviderRegistry');
}());
