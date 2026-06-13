'use strict';
// modules/argusHumanitarian.js
// Unified UN Humanitarian Intelligence Ingestion Layer.
//
// Architecture:
//   Consolidates ReliefWeb and UNHCR into one normalized pipeline.
//   Two sources → canonical schema → backward-compat bridge to existing consumers.
//
// Sources:
//   ReliefWeb (/v1/disasters status=current) — humanitarian event intelligence
//     Covers: Conflict, Famine, Epidemic, Food Insecurity, Humanitarian Emergency
//   UNHCR Population API (/population/v1/population/) — displacement intelligence
//     Covers: Refugees, IDPs, Asylum Seekers (current data year)
//
// GDACS remains authoritative for natural disasters (EQ/FL/TC/VO/DR/WF).
// This module does not replace, modify, or duplicate GDACS ingestion.
//
// Backward Compat Bridges (preserved for all existing consumers):
//   window._rwData         — per-ISO3 index { disasters[], sitreps[], displaced, refugees }
//   window._rwCrisisEvents — flat event array for main feed, search, neural web
//   window.ArgusRW         — set by argusGdacs.js, reads shared _rwData object
//
// Canonical Store (new):
//   window._argusHumanitarianStore — { entities[], byIso3{}, byGlide{}, fetchedAt{} }
//   window._argusGlideIndex        — { byGlide{}, byIso3{} }
//
// Public API:
//   window.ArgusHumanitarian — { getCountryData, getAllEntities, getByGlide,
//                               getCorrelation, getStore, refresh, _onGdacsLoad }
//
// Load order: after argusGdacs.js (SCRIPT 4b)
// argusGdacs.js initializes window._rwData before this module loads.

window.ArgusHumanitarian = (function () {
  'use strict';

  // ── Configuration ─────────────────────────────────────────────────────────────
  var RW_FN          = '/.netlify/functions/fetch-reliefweb';
  var UNHCR_BASE_URL = 'https://api.unhcr.org/population/v1/population/';
  var UNHCR_YEAR     = (new Date().getFullYear() - 1); // UNHCR data lags ~1 year

  var CACHE_KEY_RW    = 'argus_rw_v2';      // same key as old loadReliefWeb — reads existing cache
  var CACHE_TS_RW     = 'argus_rw_ts_v2';
  var CACHE_KEY_UNHCR = 'argus_unhcr_v1';
  var CACHE_TS_UNHCR  = 'argus_unhcr_ts_v1';
  var TTL_RW          = 60 * 60 * 1000;      // 1 hour
  var TTL_UNHCR       = 24 * 60 * 60 * 1000; // 24 hours — UNHCR data is annual

  // ── ISO2 → ISO3 lookup ────────────────────────────────────────────────────────
  // Covers all major humanitarian crisis countries returned by ReliefWeb and UNHCR.
  var ISO2_TO_ISO3 = {
    'AF':'AFG','AL':'ALB','DZ':'DZA','AO':'AGO','AR':'ARG','AM':'ARM','AU':'AUS',
    'AT':'AUT','AZ':'AZE','BD':'BGD','BY':'BLR','BE':'BEL','BZ':'BLZ','BJ':'BEN',
    'BO':'BOL','BA':'BIH','BW':'BWA','BR':'BRA','BF':'BFA','BI':'BDI','CV':'CPV',
    'KH':'KHM','CM':'CMR','CA':'CAN','CF':'CAF','TD':'TCD','CL':'CHL','CN':'CHN',
    'CO':'COL','KM':'COM','CD':'COD','CG':'COG','CR':'CRI','CI':'CIV','HR':'HRV',
    'CU':'CUB','CY':'CYP','CZ':'CZE','DK':'DNK','DJ':'DJI','DO':'DOM','EC':'ECU',
    'EG':'EGY','SV':'SLV','GQ':'GNQ','ER':'ERI','ET':'ETH','FJ':'FJI','FR':'FRA',
    'GA':'GAB','GM':'GMB','GE':'GEO','DE':'DEU','GH':'GHA','GR':'GRC','GT':'GTM',
    'GN':'GIN','GW':'GNB','HT':'HTI','HN':'HND','HK':'HKG','HU':'HUN','IN':'IND',
    'ID':'IDN','IR':'IRN','IQ':'IRQ','IL':'ISR','IT':'ITA','JM':'JAM','JP':'JPN',
    'JO':'JOR','KZ':'KAZ','KE':'KEN','KP':'PRK','KR':'KOR','KW':'KWT','KG':'KGZ',
    'LB':'LBN','LR':'LBR','LY':'LBY','LK':'LKA','MG':'MDG','MW':'MWI','MY':'MYS',
    'ML':'MLI','MR':'MRT','MX':'MEX','MD':'MDA','MN':'MNG','ME':'MNE','MA':'MAR',
    'MZ':'MOZ','MM':'MMR','NA':'NAM','NP':'NPL','NL':'NLD','NZ':'NZL','NI':'NIC',
    'NE':'NER','NG':'NGA','MK':'MKD','NO':'NOR','OM':'OMN','PK':'PAK','PA':'PAN',
    'PG':'PNG','PY':'PRY','PE':'PER','PH':'PHL','PL':'POL','PT':'PRT','PS':'PSE',
    'QA':'QAT','RO':'ROU','RU':'RUS','RW':'RWA','SA':'SAU','SN':'SEN','RS':'SRB',
    'SL':'SLE','SO':'SOM','ZA':'ZAF','SS':'SSD','ES':'ESP','SD':'SDN','SE':'SWE',
    'CH':'CHE','SY':'SYR','TW':'TWN','TJ':'TJK','TZ':'TZA','TH':'THA','TL':'TLS',
    'TG':'TGO','TT':'TTO','TN':'TUN','TR':'TUR','TM':'TKM','UG':'UGA','UA':'UKR',
    'AE':'ARE','GB':'GBR','US':'USA','UY':'URY','UZ':'UZB','VU':'VUT','VE':'VEN',
    'VN':'VNM','YE':'YEM','ZM':'ZMB','ZW':'ZWE',
  };

  // ── Canonical category definitions ────────────────────────────────────────────
  // Canonical label + default severity for each category.
  // Prevents category drift between sources over time.
  var CANONICAL_CATEGORIES = {
    'Conflict':                { label: 'Conflict',                 defaultSeverity: 'Critical' },
    'Famine':                  { label: 'Famine',                   defaultSeverity: 'Critical' },
    'Humanitarian Emergency':  { label: 'Humanitarian Emergency',   defaultSeverity: 'Severe'   },
    'Epidemic':                { label: 'Epidemic',                 defaultSeverity: 'Severe'   },
    'Food Security':           { label: 'Food Security',            defaultSeverity: 'High'     },
    'Disease Outbreak':        { label: 'Disease Outbreak',         defaultSeverity: 'High'     },
    'Refugee Crisis':          { label: 'Refugee Crisis',           defaultSeverity: 'Severe'   },
    'Displacement':            { label: 'Displacement',             defaultSeverity: 'High'     },
    'Natural Disaster Impact': { label: 'Natural Disaster Impact',  defaultSeverity: 'High'     },
    'Protection Crisis':       { label: 'Protection Crisis',        defaultSeverity: 'Severe'   },
  };

  // ── ReliefWeb API type name → canonical category ──────────────────────────────
  var RW_TYPE_TO_CATEGORY = {
    'Conflict':               'Conflict',
    'Complex Emergency':      'Humanitarian Emergency',
    'Epidemic':               'Epidemic',
    'Food Insecurity':        'Food Security',
    'Famine':                 'Famine',
    'Flood':                  'Natural Disaster Impact',
    'Earthquake':             'Natural Disaster Impact',
    'Tropical Cyclone':       'Natural Disaster Impact',
    'Drought':                'Natural Disaster Impact',
    'Tsunami':                'Natural Disaster Impact',
    'Volcano':                'Natural Disaster Impact',
    'Land Slide':             'Natural Disaster Impact',
    'Cold Wave':              'Natural Disaster Impact',
    'Fire':                   'Natural Disaster Impact',
    'Storm':                  'Natural Disaster Impact',
    'Flash Flood':            'Natural Disaster Impact',
    'Wild Fire':              'Natural Disaster Impact',
    'Technological Disaster': 'Natural Disaster Impact',
    'Mud Slide':              'Natural Disaster Impact',
    'Snow Avalanche':         'Natural Disaster Impact',
    'Insect Infestation':     'Natural Disaster Impact',
  };

  // ── Severity → legacy string (backward compat for _rwData .sev field) ─────────
  // Maps canonical severity to existing consumer-expected strings.
  function _toLegacySev(severity) {
    if (severity === 'Critical') return 'CRITICAL';
    if (severity === 'Severe')   return 'WARNING';
    if (severity === 'High')     return 'WARNING';
    if (severity === 'Moderate') return 'WATCH';
    if (severity === 'Low')      return 'WATCH';
    return 'WATCH';
  }

  // ── Severity → legacy plotPriority (backward compat for events feed) ──────────
  function _toLegacyPriority(severity) {
    if (severity === 'Critical') return 85;
    if (severity === 'Severe')   return 70;
    if (severity === 'High')     return 55;
    if (severity === 'Moderate') return 40;
    return 30;
  }

  // ── Canonical category from ReliefWeb type name ───────────────────────────────
  function _rwCategory(typeName) {
    return RW_TYPE_TO_CATEGORY[typeName] || 'Humanitarian Emergency';
  }

  // ── Default severity for a canonical category ─────────────────────────────────
  function _categoryDefaultSeverity(category) {
    var def = CANONICAL_CATEGORIES[category];
    return def ? def.defaultSeverity : 'Unknown';
  }

  // ── UNHCR severity from total displacement scale ──────────────────────────────
  // Derives severity from displacement magnitude since UNHCR provides no severity field.
  function _unhcrSeverity(total) {
    if (!total || total <= 0) return 'Unknown';
    if (total >= 1000000)     return 'Critical';
    if (total >= 100000)      return 'Severe';
    if (total >= 10000)       return 'High';
    if (total >= 1000)        return 'Moderate';
    return 'Low';
  }

  // ── Canonical store ───────────────────────────────────────────────────────────
  // Arrays/objects mutated in place — external references to store remain valid.
  var _entities = [];   // all canonical entities
  var _byIso3   = {};   // ISO3 → array of entity IDs
  var _byGlide  = {};   // GLIDE → entity (for GDACS cross-reference)
  var _correlations = {};  // gdacsEventId → rwEntityId

  var _store = {
    entities:  _entities,
    byIso3:    _byIso3,
    byGlide:   _byGlide,
    fetchedAt: { rw: null, unhcr: null },
  };

  // ── Helper: find entity by ID ─────────────────────────────────────────────────
  function _findById(id) {
    for (var i = 0; i < _entities.length; i++) {
      if (_entities[i].id === id) return _entities[i];
    }
    return null;
  }

  // ── Helper: indexOf on _byIso3 entries ───────────────────────────────────────
  function _indexOfId(arr, id) {
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] === id) return i;
    }
    return -1;
  }

  // ── Normalize a ReliefWeb disaster record → canonical entity ─────────────────
  function _normalizeRW(item, index) {
    var f = item.fields || {};

    var typeName = f.type && f.type[0] ? f.type[0].name : null;
    var category = typeName ? _rwCategory(typeName) : 'Humanitarian Emergency';
    var severity = _categoryDefaultSeverity(category);

    // Country resolution — use ISO2 → ISO3 for accurate mapping
    var primaryCountry = null;
    var allCountries   = [];
    if (f.country && f.country.length) {
      for (var ci = 0; ci < f.country.length; ci++) {
        var c    = f.country[ci];
        var iso2 = (c.iso2 || '').toUpperCase();
        var iso3 = ISO2_TO_ISO3[iso2] || null;
        if (iso3 && _indexOfId(allCountries, iso3) === -1) allCountries.push(iso3);
        if (!primaryCountry && iso3) primaryCountry = iso3;
      }
    }

    var glide = f.glide || null;

    return {
      id:      'rw_' + (item.id || (9500 + index)),
      source:  'ReliefWeb',
      sourceId: String(item.id || (9500 + index)),
      sourceUrl: 'https://reliefweb.int',
      title:   f.name || (typeName ? typeName + ' — Active Crisis' : 'Active Humanitarian Crisis'),
      category:  category,
      subtype:   typeName || null,
      country:   primaryCountry,
      countries: allCountries,
      region:    f.country && f.country[0] ? f.country[0].name : null,
      coordinates: null,
      eventDate:  f.date && f.date.created ? f.date.created.slice(0, 10) : null,
      updatedAt:  f.date && f.date.changed  ? f.date.changed.slice(0, 10)  : null,
      severity:   severity,
      humanitarianImpact: {
        populationAffected: null,
        description:  f.status ? 'UN-designated crisis. Status: ' + f.status : null,
        glide:        glide,
      },
      displacementImpact: null,
      aidOperations:  [],
      sourceMetadata: f,
    };
  }

  // ── Normalize a UNHCR population row → canonical entity ──────────────────────
  function _normalizeUNHCR(row) {
    var iso2 = (row.coa_iso || '').toUpperCase();
    var iso3 = ISO2_TO_ISO3[iso2] || null;
    if (!iso3) return null;  // cannot place without ISO3

    var refugees = parseInt(row.refugees)      || 0;
    var idps     = parseInt(row.idps)          || 0;
    var asylum   = parseInt(row.asylum_seekers) || parseInt(row.asylum) || 0;
    var total    = refugees + idps + asylum;
    if (total <= 0) return null;  // no displacement data — discard per Part 9

    return {
      id:        'unhcr_' + iso3 + '_' + UNHCR_YEAR,
      source:    'UNHCR',
      sourceId:  iso2,
      sourceUrl: null,
      title:     'Displacement Situation — ' + iso3,
      category:  'Displacement',
      subtype:   null,
      country:   iso3,
      countries: [iso3],
      region:    null,
      coordinates: null,
      eventDate:  UNHCR_YEAR + '-01-01',
      updatedAt:  null,
      severity:   _unhcrSeverity(total),
      humanitarianImpact: null,
      displacementImpact: {
        refugees:      refugees > 0 ? refugees : null,
        idps:          idps     > 0 ? idps     : null,
        asylumSeekers: asylum   > 0 ? asylum   : null,
        total:         total    > 0 ? total    : null,
      },
      aidOperations:  [],
      sourceMetadata: row,
    };
  }

  // ── Write canonical entity to _rwData backward-compat bridge ─────────────────
  // Writes to all affected countries, not just primary country.
  // ReliefWeb → adds to .disasters (skips exact duplicates by sourceId+source)
  // UNHCR     → overwrites .refugees / .displaced (idempotent)
  function _writeRwDataBridge(entity) {
    var iso3s = entity.countries.length ? entity.countries
              : (entity.country ? [entity.country] : []);

    for (var ii = 0; ii < iso3s.length; ii++) {
      var iso3 = iso3s[ii];

      if (!window._rwData[iso3]) {
        window._rwData[iso3] = { disasters: [], sitreps: [], displaced: null, refugees: null };
      }

      if (entity.source === 'ReliefWeb') {
        // Dedup check: skip if same sourceId+source already present
        var dup = false;
        var dis = window._rwData[iso3].disasters;
        for (var di = 0; di < dis.length; di++) {
          if (dis[di].source === 'ReliefWeb' && dis[di].sourceId === entity.sourceId) {
            dup = true; break;
          }
        }
        if (!dup) {
          dis.push({
            name:     entity.title,
            types:    [entity.subtype || entity.category],
            sev:      _toLegacySev(entity.severity),
            date:     entity.eventDate || '',
            url:      entity.sourceUrl || 'https://reliefweb.int',
            source:   'ReliefWeb',
            sourceId: entity.sourceId,
            glide:    entity.humanitarianImpact ? entity.humanitarianImpact.glide : null,
          });
        }
      }

      if (entity.source === 'UNHCR' && entity.displacementImpact) {
        var di2 = entity.displacementImpact;
        if (di2.refugees != null) window._rwData[iso3].refugees  = di2.refugees;
        if (di2.idps     != null) window._rwData[iso3].displaced = di2.idps;
      }
    }
  }

  // ── Ingest normalized entities into canonical store + _rwData bridge ──────────
  function _ingest(entities) {
    for (var i = 0; i < entities.length; i++) {
      var entity = entities[i];
      if (!entity) continue;

      _entities.push(entity);

      // Index by ISO3
      var iso3s = entity.countries.length ? entity.countries
                : (entity.country ? [entity.country] : []);
      for (var j = 0; j < iso3s.length; j++) {
        var iso3 = iso3s[j];
        if (!_byIso3[iso3]) _byIso3[iso3] = [];
        if (_indexOfId(_byIso3[iso3], entity.id) === -1) {
          _byIso3[iso3].push(entity.id);
        }
      }

      // Index by GLIDE
      if (entity.humanitarianImpact && entity.humanitarianImpact.glide) {
        _byGlide[entity.humanitarianImpact.glide] = entity;
      }

      _writeRwDataBridge(entity);
    }
  }

  // ── Build _rwCrisisEvents from ReliefWeb entities (events feed bridge) ────────
  // Preserves expected shape for all consumers of window._rwCrisisEvents.
  function _buildCrisisEvents(rwEntities) {
    var events = [];
    for (var i = 0; i < rwEntities.length; i++) {
      var entity = rwEntities[i];
      events.push({
        id:          9500 + i,
        type:        'DISASTER',
        severity:    _toLegacySev(entity.severity),
        title:       entity.subtype
          ? entity.subtype + ' \u2014 ' + (entity.region || entity.country || 'Active Crisis')
          : entity.title,
        impact:      'Active UN-designated crisis.' +
          (entity.region ? ' Country: ' + entity.region + '.' : '') + ' Status: current.',
        region:      entity.region || entity.country || '',
        pubDate:     entity.eventDate
          ? new Date(entity.eventDate).toLocaleDateString()
          : '',
        source:      'UN RELIEFWEB',
        link:        'https://reliefweb.int',
        category:    entity.category,
        lat:         null,
        lon:         null,
        plotPriority: _toLegacyPriority(entity.severity),
      });
    }
    window._rwCrisisEvents = events;
    return events;
  }

  // ── Publish GLIDE index for external consumers ────────────────────────────────
  function _publishGlideIndex() {
    window._argusGlideIndex = { byGlide: _byGlide, byIso3: _byIso3 };
  }

  // ── Clear ReliefWeb entries from _rwData (called before refresh) ──────────────
  // Prevents accumulation of stale ReliefWeb entries across re-fetches.
  // GDACS entries (source:'GDACS') and UNHCR fields are preserved.
  function _clearRwBridgeRW() {
    if (!window._rwData) return;
    var keys = Object.keys(window._rwData);
    for (var i = 0; i < keys.length; i++) {
      var entry = window._rwData[keys[i]];
      if (entry && entry.disasters) {
        entry.disasters = entry.disasters.filter(function (d) {
          return d.source !== 'ReliefWeb';
        });
      }
    }
  }

  // ── Guard: defer fn until DOMContentLoaded ────────────────────────────────────
  // Module scripts execute before DOMContentLoaded fires. This ensures functions
  // like window.mergeAuxEvents (set by index.html) are available before we call them.
  function _onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  // ── Process ReliefWeb items → normalize → ingest → bridge ────────────────────
  function _processRW(items) {
    if (!Array.isArray(items) || !items.length) return;

    var rwEntities = [];
    for (var i = 0; i < items.length; i++) {
      try {
        rwEntities.push(_normalizeRW(items[i], i));
      } catch (e) {
        console.warn('[ArgusHumanitarian] RW normalize error, skipping record:', e.message);
      }
    }

    _ingest(rwEntities);
    _buildCrisisEvents(rwEntities);
    _publishGlideIndex();

    _store.fetchedAt.rw = Date.now();

    if (typeof window.mergeAuxEvents === 'function') window.mergeAuxEvents();

    console.log('[ArgusHumanitarian] ReliefWeb: ' + rwEntities.length + ' crises normalized');
  }

  // ── Fetch ReliefWeb (with localStorage cache) ─────────────────────────────────
  // Source isolation: failure does not affect UNHCR pipeline.
  function _fetchReliefWeb() {
    try {
      var cached = localStorage.getItem(CACHE_KEY_RW);
      var ts     = parseInt(localStorage.getItem(CACHE_TS_RW) || '0');
      if (cached && Date.now() - ts < TTL_RW) {
        _onReady(function () { _processRW(JSON.parse(cached)); });
        return;
      }
    } catch (e) { /* corrupt cache — fall through to network */ }

    fetch(RW_FN)
      .then(function (r) { return r.ok ? r.json() : Promise.reject('HTTP ' + r.status); })
      .then(function (data) {
        if (!data) return;
        var items = data.data || [];
        try {
          localStorage.setItem(CACHE_KEY_RW, JSON.stringify(items));
          localStorage.setItem(CACHE_TS_RW,  String(Date.now()));
        } catch (e) { /* storage full — skip cache write */ }
        _processRW(items);
      })
      .catch(function (e) {
        console.warn('[ArgusHumanitarian] ReliefWeb fetch failed (non-critical):', e.message);
        // UNHCR pipeline continues independently
      });
  }

  // ── Process UNHCR rows → normalize → ingest ───────────────────────────────────
  function _processUNHCR(rows) {
    if (!Array.isArray(rows) || !rows.length) return;

    var unhcrEntities = [];
    for (var i = 0; i < rows.length; i++) {
      try {
        var entity = _normalizeUNHCR(rows[i]);
        if (entity) unhcrEntities.push(entity);
      } catch (e) {
        console.warn('[ArgusHumanitarian] UNHCR normalize error, skipping row:', e.message);
      }
    }

    _ingest(unhcrEntities);
    _store.fetchedAt.unhcr = Date.now();

    console.log('[ArgusHumanitarian] UNHCR: ' + unhcrEntities.length + ' displacement records normalized');
  }

  // ── Fetch UNHCR (with localStorage cache, dynamic year) ──────────────────────
  // 24hr localStorage cache — data is annual reference, not real-time signal.
  // Source isolation: failure does not affect ReliefWeb pipeline.
  function _fetchUnhcr() {
    try {
      var cached = localStorage.getItem(CACHE_KEY_UNHCR);
      var ts     = parseInt(localStorage.getItem(CACHE_TS_UNHCR) || '0');
      if (cached && Date.now() - ts < TTL_UNHCR) {
        _processUNHCR(JSON.parse(cached));
        return;
      }
    } catch (e) { /* corrupt cache — fall through to network */ }

    var url = UNHCR_BASE_URL +
      '?limit=500&dataset=population&displayType=totals' +
      '&columns[]=refugees&columns[]=idps&columns[]=asylum_seekers' +
      '&yearFrom=' + UNHCR_YEAR + '&yearTo=' + UNHCR_YEAR + '&coa_all=true';

    fetch(url)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (json) {
        if (!json || !json.items) return;
        try {
          localStorage.setItem(CACHE_KEY_UNHCR, JSON.stringify(json.items));
          localStorage.setItem(CACHE_TS_UNHCR,  String(Date.now()));
        } catch (e) { /* storage full */ }
        _processUNHCR(json.items);
      })
      .catch(function (e) {
        console.warn('[ArgusHumanitarian] UNHCR fetch failed (non-critical):', e.message);
        // ReliefWeb pipeline continues independently
      });
  }

  // ── GDACS load callback (GLIDE cross-reference correlation) ───────────────────
  // Called by argusGdacs.js after _populateRwData() completes.
  // Stores GLIDE correlations for future consumers — no rendering changes.
  function _onGdacsLoad(gdacsEvents) {
    if (!gdacsEvents || !gdacsEvents.length) return;
    var correlated = 0;
    for (var i = 0; i < gdacsEvents.length; i++) {
      var ev    = gdacsEvents[i];
      var glide = ev.rawSourceMetadata && ev.rawSourceMetadata.glide;
      if (!glide) continue;
      var rwEntity = _byGlide[glide];
      if (!rwEntity) continue;
      _correlations[ev.eventId] = rwEntity.id;
      correlated++;
    }
    if (correlated > 0) {
      console.log('[ArgusHumanitarian] GLIDE correlation: ' + correlated + ' GDACS events matched to ReliefWeb records');
    }
  }

  // ── Initialize ────────────────────────────────────────────────────────────────
  // Ensure _rwData exists — argusGdacs.js sets it first, but guard for load order edge cases.
  if (!window._rwData) window._rwData = {};

  // Fetch both sources independently on start.
  // Failure of one does not block or affect the other.
  _fetchReliefWeb();
  setTimeout(_fetchUnhcr, 90 * 1000); // 90s — deferred after GDACS (75s) has loaded first

  // Publish canonical store (mutated in place — external references remain valid)
  window._argusHumanitarianStore = _store;

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusHumanitarian');

  // ── Public API ────────────────────────────────────────────────────────────────
  return {
    // Returns all canonical entities for a given ISO3 country code.
    getCountryData: function (iso3) {
      var ids = _byIso3[iso3] || [];
      var result = [];
      for (var i = 0; i < ids.length; i++) {
        var e = _findById(ids[i]);
        if (e) result.push(e);
      }
      return result;
    },

    // Returns all canonical entities across all sources.
    getAllEntities: function () {
      return _entities.slice();
    },

    // Returns the canonical entity for a GLIDE number, or null.
    getByGlide: function (glide) {
      return _byGlide[glide] || null;
    },

    // Returns the ReliefWeb entity ID correlated to a GDACS event ID, or null.
    getCorrelation: function (gdacsEventId) {
      return _correlations[gdacsEventId] || null;
    },

    // Returns the full canonical store reference.
    getStore: function () { return _store; },

    // Re-fetch both sources. Clears stale ReliefWeb entries from _rwData bridge.
    // UNHCR: served from 24hr localStorage cache unless expired.
    // GDACS entries in _rwData are not modified.
    refresh: function () {
      _clearRwBridgeRW();
      // Clear in-place (external references to arrays/objects remain valid)
      _entities.length = 0;
      var k;
      for (k in _byIso3)  { if (_byIso3.hasOwnProperty(k))  delete _byIso3[k];  }
      for (k in _byGlide) { if (_byGlide.hasOwnProperty(k)) delete _byGlide[k]; }
      for (k in _correlations) { if (_correlations.hasOwnProperty(k)) delete _correlations[k]; }
      _fetchReliefWeb();
      _fetchUnhcr();
    },

    // Internal — called by argusGdacs.js after _populateRwData() for GLIDE correlation.
    _onGdacsLoad: _onGdacsLoad,
  };

}());
