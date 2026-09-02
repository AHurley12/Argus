'use strict';
// modules/argusWeatherGate.js
// Cross-source weather event deduplication gate with organizational priority ranking.
//
// Purpose:
//   Prevents duplicate markers when NOAA, GDACS, and EONET report the same real-world
//   event. Enforces: ONE REAL-WORLD EVENT → ONE CANONICAL MARKER, with all contributing
//   sources recorded in that marker's userData.sources.
//
// Priority system:
//   When a duplicate is detected, the source with the highest organizational credibility
//   for that event type wins ownership of the canonical marker. The lower-priority source's
//   marker creation is suppressed and its metadata is merged onto the owner's marker.
//   Priority is ONLY active during duplicate detection — unique events always render.
//
// Matching criteria (all applied before blocking):
//   1. Canonical key  — derived from category + normalized storm name + basin/grid
//   2. Geographic proximity — event centroids within GEO_THRESHOLD (2°, ≈222km)
//   3. Time proximity — event onset within TIME_THRESHOLD (72 hours)
//   Hard cap of 2 rendered markers per name+category cluster as an absolute safety net.
//
// Priority research basis:
//   NOAA NHC  — WMO-designated RSMC for Atlantic + E. Pacific tropical cyclones.
//               Sole authority for US NWS severe weather (tornado, winter storm,
//               thunderstorm, flash flood). Advisories within minutes of issuance.
//   GDACS     — Joint Research Centre (EU) + UN OCHA multi-agency fusion.
//               Uses USGS PAGER (earthquakes, ≤15 min), PTWC/NWPTAC/JMA (tsunamis),
//               JTWC (W. Pacific/Indian Ocean cyclones), JRC GloFAS (global floods),
//               JRC NDVI/SPI (drought), Smithsonian GVP + VAAC (volcanoes).
//               Best non-US global disaster data. Latency: 15-60 min.
//   EONET     — NASA GSFC. Uses FIRMS MODIS/VIIRS (wildfires, ≤3-6 h thermal anomaly),
//               VAAC (volcanic ash), NatICE (sea ice + icebergs).
//               Fastest fire detection globally. Satellite-only — misses ground events.
//
// Public API: window.ArgusWeatherGate
//   .claim(ev, sourceId)              → { allowed, canonicalKey, owner, priority,
//                                         handoff?, handoffFrom?, handoffFromId? }
//   .keepAlive(sourceEventId, src)    → void
//   .release(sourceEventId, src)      → void
//   .getPendingRemovals(sourceId)     → string[] | null  (consumed on read, resets)
//   .query(ev)                        → RegistryEntry | null
//   .diagReport()                     → void
//   .SOURCE_PRIORITY                  → priority table (read-only reference)
//
// Load order: before argusGdacs.js, argusEonet.js, argusNoaa.js, argusWeatherLayer.js

window.ArgusWeatherGate = (function () {
  'use strict';

  // ── Organizational Priority Table ─────────────────────────────────────────────
  // Scores 0-100. Higher = more authoritative for this event type.
  // Only consulted during duplicate detection — no effect on unique events.

  var SOURCE_PRIORITY = {
    'tropical_cyclone': { NOAA: 95, GDACS: 80, EONET: 40 },
    // NHC = WMO-designated RSMC. Fastest official track + intensity data.
    // GDACS re-broadcasts NHC/JTWC advisories with 1-2 h lag.
    // EONET has no track, forecast, or intensity data.

    'tornado':          { NOAA: 99, GDACS: 10, EONET:  5 },
    'thunderstorm':     { NOAA: 95, GDACS: 15, EONET:  5 },
    'winter_storm':     { NOAA: 97, GDACS: 15, EONET:  5 },
    'wind':             { NOAA: 90, GDACS: 20, EONET: 10 },
    // NWS is the sole authority for US convective and winter weather.
    // No global org matches NWS fidelity for US-territory events.

    'flood':            { NOAA: 78, GDACS: 82, EONET: 55 },
    // Global floods: GDACS (JRC GloFAS modeling) edges NOAA.
    // US floods: NOAA (NWS River Forecast Centers) is authoritative.
    // Flood tiebreak in _priorityScore() boosts NOAA for contiguous US lon range.

    'earthquake':       { NOAA:  5, GDACS: 92, EONET: 68 },
    // GDACS ingests USGS PAGER + EMSC within ~15 min. Best global coverage.
    // EONET also uses USGS but with lower alert integration.
    // NOAA issues no earthquake alerts.

    'tsunami':          { NOAA: 75, GDACS: 92, EONET: 15 },
    // GDACS aggregates PTWC, NWPTAC, JMA, and regional warning centers.
    // NOAA NTWC covers US coasts well; GDACS covers the rest.

    'volcano':          { NOAA: 10, GDACS: 80, EONET: 88 },
    // EONET uses VAAC (Volcanic Ash Advisory Centers) + satellite thermal anomaly
    // for earliest detection. GDACS uses observatory networks + Smithsonian GVP.

    'wildfire':         { NOAA: 20, GDACS: 58, EONET: 95 },
    // NASA FIRMS (MODIS/VIIRS) detects thermal anomalies within 3-6 h — gold standard.
    // GDACS uses JRC EFFIS (European fires, slower). NOAA has minimal fire coverage.

    'drought':          { NOAA: 35, GDACS: 88, EONET: 52 },
    // JRC/GDACS publishes NDVI + SPI indices — best global drought monitoring.

    'sea_ice':          { NOAA: 20, GDACS: 10, EONET: 95 },
    // NatICE (via EONET) is the definitive iceberg + sea ice authority.

    'dust_haze':        { NOAA: 25, GDACS: 22, EONET: 92 },
    // NASA MODIS aerosol optical depth — no peer for dust/haze detection speed.

    'landslide':        { NOAA: 12, GDACS: 78, EONET: 62 },

    '_default':         { NOAA: 50, GDACS: 60, EONET: 55 },
  };

  // ── Matching thresholds ────────────────────────────────────────────────────────
  var GEO_THRESHOLD  = 2.0;                 // degrees (≈222 km at equator)
  var TIME_THRESHOLD = 72 * 60 * 60 * 1000; // 72 hours in ms
  var HARD_CAP       = 2;                   // max markers per name+category cluster

  // ── Canonical event registry ───────────────────────────────────────────────────
  // Map<canonicalKey, RegistryEntry>
  var _registry = new Map();

  // Source-event → canonicalKey index for O(1) keepAlive / release lookups.
  // Map<'SOURCEEID:eventId', canonicalKey>
  var _sourceIndex = new Map();

  // Events whose sprites must be removed by a specific source on next tick().
  // Populated on priority handoff. Consumed (and cleared) by getPendingRemovals().
  // { [sourceId]: [sourceEventId, ...] }
  var _pendingRemovals = {};

  // ── Audit ─────────────────────────────────────────────────────────────────────
  var _audit = {
    claimsGranted:    0,
    claimsBlocked:    0,
    enrichments:      0,
    handoffs:         0,
    hardCapHits:      0,
  };

  // ── Category normalization ────────────────────────────────────────────────────
  // NOAA uses _wMarkerType ('cyclone', 'flood', 'pulse'); GDACS + EONET are already
  // in the standard category namespace. Pulse events are mapped from eventType string.
  function _normalizeCategory(ev) {
    if (ev.category) return ev.category;
    if (ev._wMarkerType === 'cyclone') return 'tropical_cyclone';
    if (ev._wMarkerType === 'flood')   return 'flood';
    var et = (ev.eventType || '').toLowerCase();
    if (/tornado/.test(et))                     return 'tornado';
    if (/thunder|severe\s*storm/.test(et))      return 'thunderstorm';
    if (/winter|blizzard|ice\s*storm/.test(et)) return 'winter_storm';
    if (/wind|gale/.test(et))                   return 'wind';
    if (/flood/.test(et))                       return 'flood';
    return '_default';
  }

  // ── Storm name extraction ─────────────────────────────────────────────────────
  // Strips meteorological category prefixes and year suffixes, returns uppercase name.
  // Returns '' when no extractable name is found (area-based NWS alerts, unnamed events).
  var _PREFIX_RE = /^(super\s+)?((tropical\s+)?(storm|cyclone|depression|disturbance)|hurricane|typhoon|cyclone|remnants?\s+of)\s+/i;
  var _SUFFIX_RE = /[-_]\d{2,4}$/;
  var _GENERIC_RE = /^(FLASH\s+FLOOD|FLOOD|TORNADO|WINTER\s+STORM|THUNDERSTORM|WIND|GALE|ICE\s+STORM|BLIZZARD|WARNING|WATCH|ADVISORY)/;

  function _extractName(ev) {
    var raw = ev.title || ev.headline || ev.eventType || '';
    // Take segment before em-dash or detail suffix: "Hurricane Milton — 65 kt" → "Hurricane Milton"
    var seg     = raw.split(/\s*[—–-]\s*/)[0].trim();
    var cleaned = seg.replace(_PREFIX_RE, '').replace(_SUFFIX_RE, '').trim().toUpperCase();
    if (_GENERIC_RE.test(cleaned) || cleaned.length < 2 || cleaned.length > 24) return '';
    return cleaned;
  }

  // ── Basin derivation from longitude ──────────────────────────────────────────
  function _basin(lon) {
    if (lon == null) return '';
    if (lon < -20)              return 'ATL';  // Atlantic
    if (lon >= -20 && lon < 70) return 'IND';  // Indian Ocean
    if (lon >= 70 && lon < 180) return 'WPAC'; // Western Pacific
    return 'EPAC';                             // Eastern Pacific (lon >180 wraps)
  }

  // ── Canonical key ─────────────────────────────────────────────────────────────
  function _canonicalKey(ev) {
    var cat  = _normalizeCategory(ev);
    var name = _extractName(ev);

    if (cat === 'tropical_cyclone' && name) {
      // Named cyclone: globally unique per active season within a basin
      return cat + ':' + name + ':' + _basin(ev.lon);
    }
    if (name) {
      // Named non-cyclone (e.g., named wildfire complex, named flood event)
      return cat + ':' + name;
    }
    // Unnamed event: category + 2° lat/lon grid bucket
    var latB = Math.round((ev.lat  || 0) / GEO_THRESHOLD) * GEO_THRESHOLD;
    var lonB = Math.round((ev.lon  || 0) / GEO_THRESHOLD) * GEO_THRESHOLD;
    return cat + ':' + latB + ':' + lonB;
  }

  // ── Source event ID extraction ────────────────────────────────────────────────
  function _eventId(ev) {
    return ev.id || ev.eventId || ev._weatherId || '';
  }

  // ── Timestamp parsing ─────────────────────────────────────────────────────────
  function _toMs(ts) {
    if (!ts) return null;
    var n = (typeof ts === 'number') ? ts : Date.parse(ts);
    return isNaN(n) ? null : n;
  }

  function _evTimestamp(ev) {
    return _toMs(ev.timestamp || ev.onset || ev.effective || ev.startTime || null);
  }

  // ── Geographic proximity ──────────────────────────────────────────────────────
  function _geoMatch(lat1, lon1, lat2, lon2) {
    return Math.abs(lat1 - lat2) < GEO_THRESHOLD &&
           Math.abs(lon1 - lon2) < GEO_THRESHOLD;
  }

  // ── Time proximity ────────────────────────────────────────────────────────────
  function _timeMatch(ts1, ts2) {
    if (ts1 == null || ts2 == null) return true; // unknown timestamp → assume match
    return Math.abs(ts1 - ts2) < TIME_THRESHOLD;
  }

  // ── Priority score ─────────────────────────────────────────────────────────────
  // Returns the score for (source, category), with US-flood tiebreak for NOAA.
  function _priorityScore(sourceId, category, lon) {
    var table = SOURCE_PRIORITY[category] || SOURCE_PRIORITY['_default'];
    var score = table[sourceId] || 0;
    // Flood tiebreak: boost NOAA within contiguous US longitude range.
    // NWS River Forecast Centers are more authoritative than JRC GloFAS for US basins.
    if (category === 'flood' && sourceId === 'NOAA' && lon != null) {
      if (lon > -130 && lon < -60) score = 85;
    }
    return score;
  }

  // ── Ownership transfer decision ───────────────────────────────────────────────
  // Returns true if newSourceId should take over ownership from the current owner.
  function _shouldTransfer(entry, newSourceId, newLon) {
    var currentScore = _priorityScore(entry.ownerSource, entry.category, entry.lon);
    var newScore     = _priorityScore(newSourceId,       entry.category, newLon);
    return newScore > currentScore;
  }

  // ── Queue pending removal for the old owner on handoff ────────────────────────
  function _queueRemoval(sourceId, eventId) {
    if (!_pendingRemovals[sourceId]) _pendingRemovals[sourceId] = [];
    _pendingRemovals[sourceId].push(eventId);
  }

  // ── Find marker object for enrichment ─────────────────────────────────────────
  // Searches weatherMarkers (NOAA sprites) and eventMarkers (GDACS/EONET ghost meshes).
  function _findMarker(entry) {
    var wm = window.weatherMarkers || [];
    for (var i = 0; i < wm.length; i++) {
      var s = wm[i];
      if (s && s.userData && s.userData._weatherId === entry.ownerId) return s;
    }
    var em = window.eventMarkers || [];
    for (var j = 0; j < em.length; j++) {
      var m = em[j];
      if (!m || !m.userData) continue;
      if (m.userData._gdacsId === entry.ownerId) return m;
      if (m.userData._eonetId === entry.ownerId) return m;
    }
    return null;
  }

  // ── Internal enrich ───────────────────────────────────────────────────────────
  // Merges secondary-source attribution onto the owner's existing marker userData.
  // Called exactly once when a source is first blocked for a given event.
  function _enrich(canonicalKey, secondaryEvent, sourceId) {
    var entry = _registry.get(canonicalKey);
    if (!entry) return;

    var marker = _findMarker(entry);
    if (!marker || !marker.userData) return;

    var ud = marker.userData;

    // Unified sources array
    if (!Array.isArray(ud.sources)) ud.sources = [entry.ownerSource];
    if (ud.sources.indexOf(sourceId) === -1) ud.sources.push(sourceId);

    // Source-specific metadata — write once, do not overwrite existing block
    if (sourceId === 'EONET' && !ud.eonetMeta) {
      ud.eonetMeta = {
        id:            secondaryEvent.id,
        link:          secondaryEvent.link,
        sources:       secondaryEvent.sources,
        timestamp:     secondaryEvent.timestamp,
        magnitude:     secondaryEvent.magnitude,
        magnitudeUnit: secondaryEvent.magnitudeUnit,
      };
      // Delegate to ArgusEventCorrelation.enrichMarker for full backward compatibility
      if (window.ArgusEventCorrelation && typeof window.ArgusEventCorrelation.enrichMarker === 'function') {
        window.ArgusEventCorrelation.enrichMarker(marker, secondaryEvent);
      }
    }
    if (sourceId === 'GDACS' && !ud.gdacsMeta) {
      ud.gdacsMeta = {
        eventId:    secondaryEvent.eventId,
        severity:   secondaryEvent.severity,
        alertScore: secondaryEvent.alertScore,
        sourceUrl:  secondaryEvent.sourceUrl,
        glide:      secondaryEvent.glide,
      };
    }
    if (sourceId === 'NOAA' && !ud.noaaMeta) {
      ud.noaaMeta = {
        id:       secondaryEvent.id,
        severity: secondaryEvent.severity,
        headline: secondaryEvent.headline,
        areaDesc: secondaryEvent.areaDesc,
        expires:  secondaryEvent.expires,
        url:      secondaryEvent.url,
      };
    }

    _audit.enrichments++;
    console.log('[ArgusWeatherGate] enriched ' + canonicalKey + ' +' + sourceId +
      ' → sources=[' + ud.sources.join(',') + ']');
  }

  // ── claim ─────────────────────────────────────────────────────────────────────
  // Primary gate entry point. Call before creating any weather marker.
  //
  // Returns:
  //   { allowed: true,  canonicalKey, owner, priority }          — caller renders
  //   { allowed: true,  ..., handoff: true, handoffFrom, handoffFromId }
  //                                                               — caller renders, previous owner must remove
  //   { allowed: false, canonicalKey, owner, priority }          — caller suppressed; enrich was auto-applied
  function claim(ev, sourceId) {
    var key      = _canonicalKey(ev);
    var evId     = _eventId(ev);
    var cat      = _normalizeCategory(ev);
    var evTs     = _evTimestamp(ev);
    var priority = _priorityScore(sourceId, cat, ev.lon);
    var indexKey = sourceId + ':' + evId;

    // ── Fast path: source already registered for this event ──────────────────────
    if (_sourceIndex.has(indexKey)) {
      var existingKey = _sourceIndex.get(indexKey);
      var existing    = _registry.get(existingKey);
      if (existing) {
        existing.lastSeen = Date.now();
        var isOwner = (existing.ownerSource === sourceId && existing.ownerId === evId);
        return {
          allowed:      isOwner,
          canonicalKey: existingKey,
          owner:        existing.ownerSource,
          priority:     priority,
        };
      }
    }

    var existing = _registry.get(key);

    // ── No existing registry entry ─────────────────────────────────────────────
    if (!existing) {
      // Hard-cap check: count nearby active entries with same category
      var nearbyCount = 0;
      _registry.forEach(function (e) {
        if (e.category !== cat) return;
        if (!_geoMatch(ev.lat || 0, ev.lon || 0, e.lat || 0, e.lon || 0)) return;
        if (!_timeMatch(evTs, e.timestamp)) return;
        nearbyCount++;
      });
      if (nearbyCount >= HARD_CAP) {
        _audit.hardCapHits++;
        console.warn('[ArgusWeatherGate] hard-cap: ' + key + ' blocked (' + sourceId +
          ', cap=' + HARD_CAP + ')');
        return { allowed: false, canonicalKey: key, owner: null, priority: priority };
      }

      // Register as primary owner
      var entry = {
        canonicalKey: key,
        category:     cat,
        name:         _extractName(ev),
        basin:        _basin(ev.lon),
        lat:          ev.lat  || 0,
        lon:          ev.lon  || 0,
        timestamp:    evTs,
        ownerSource:  sourceId,
        ownerId:      evId,
        sources:      [sourceId],
        lastSeen:     Date.now(),
      };
      _registry.set(key, entry);
      _sourceIndex.set(indexKey, key);
      _audit.claimsGranted++;
      console.log('[ArgusWeatherGate] granted: ' + key + ' → ' + sourceId +
        ' (priority ' + priority + ')');
      return { allowed: true, canonicalKey: key, owner: sourceId, priority: priority };
    }

    // ── Existing entry found — validate geo + time proximity ──────────────────
    // If proximity fails, this is a different real-world event sharing the same key.
    // Disambiguate by appending a lat/lon suffix.
    if (!_geoMatch(ev.lat || 0, ev.lon || 0, existing.lat, existing.lon) ||
        !_timeMatch(evTs, existing.timestamp)) {
      var disambig = key + ':' + Math.round(ev.lat || 0) + ':' + Math.round(ev.lon || 0);
      var entry2   = {
        canonicalKey: disambig,
        category:     cat,
        name:         _extractName(ev),
        basin:        _basin(ev.lon),
        lat:          ev.lat  || 0,
        lon:          ev.lon  || 0,
        timestamp:    evTs,
        ownerSource:  sourceId,
        ownerId:      evId,
        sources:      [sourceId],
        lastSeen:     Date.now(),
      };
      _registry.set(disambig, entry2);
      _sourceIndex.set(indexKey, disambig);
      _audit.claimsGranted++;
      console.log('[ArgusWeatherGate] granted (disambig): ' + disambig + ' → ' + sourceId);
      return { allowed: true, canonicalKey: disambig, owner: sourceId, priority: priority };
    }

    // ── True duplicate: same real-world event ─────────────────────────────────
    _sourceIndex.set(indexKey, key);
    existing.lastSeen = Date.now();

    // Check if incoming source outranks current owner
    if (existing.ownerSource && _shouldTransfer(existing, sourceId, ev.lon)) {
      var prevOwner   = existing.ownerSource;
      var prevOwnerId = existing.ownerId;

      existing.ownerSource = sourceId;
      existing.ownerId     = evId;
      if (existing.sources.indexOf(sourceId) === -1) existing.sources.push(sourceId);

      _queueRemoval(prevOwner, prevOwnerId);
      _audit.handoffs++;
      _audit.claimsGranted++;
      console.log('[ArgusWeatherGate] handoff: ' + key + ' ' + prevOwner + ' → ' + sourceId +
        ' (scores ' + _priorityScore(prevOwner, cat, existing.lon) + ' → ' + priority + ')');
      return {
        allowed:       true,
        canonicalKey:  key,
        owner:         sourceId,
        priority:      priority,
        handoff:       true,
        handoffFrom:   prevOwner,
        handoffFromId: prevOwnerId,
      };
    }

    // Current owner has equal or higher priority — block new source
    // First time this source is blocked → auto-enrich the owner's marker
    if (existing.sources.indexOf(sourceId) === -1) {
      existing.sources.push(sourceId);
      _enrich(key, ev, sourceId);
    }

    _audit.claimsBlocked++;
    console.log('[ArgusWeatherGate] blocked: ' + key + ' owner=' + existing.ownerSource +
      '(' + _priorityScore(existing.ownerSource, cat, existing.lon) + ')' +
      ' blocked=' + sourceId + '(' + priority + ')');
    return {
      allowed:      false,
      canonicalKey: key,
      owner:        existing.ownerSource,
      priority:     priority,
    };
  }

  // ── keepAlive ─────────────────────────────────────────────────────────────────
  // Signal that a source still holds this event (called on each refresh cycle).
  // Updates lastSeen to prevent premature stale detection in future TTL logic.
  function keepAlive(sourceEventId, sourceId) {
    var indexKey = sourceId + ':' + sourceEventId;
    var key      = _sourceIndex.get(indexKey);
    if (!key) return;
    var entry = _registry.get(key);
    if (entry) entry.lastSeen = Date.now();
  }

  // ── release ───────────────────────────────────────────────────────────────────
  // Called when a source evicts or expires an event. Removes source from registry.
  // If the owner releases, ownership is cleared; remaining sources may re-claim.
  function release(sourceEventId, sourceId) {
    var indexKey = sourceId + ':' + sourceEventId;
    var key      = _sourceIndex.get(indexKey);
    if (!key) return;
    _sourceIndex.delete(indexKey);

    var entry = _registry.get(key);
    if (!entry) return;

    entry.sources = entry.sources.filter(function (s) { return s !== sourceId; });

    if (entry.sources.length === 0) {
      _registry.delete(key);
      console.log('[ArgusWeatherGate] released: ' + key + ' (no sources remain)');
      return;
    }

    if (entry.ownerSource === sourceId) {
      // Owner released — clear ownership so a remaining source can re-claim
      entry.ownerSource = null;
      entry.ownerId     = null;
      console.log('[ArgusWeatherGate] owner released: ' + key +
        ' remaining=[' + entry.sources.join(',') + ']');
    }
  }

  // ── getPendingRemovals ────────────────────────────────────────────────────────
  // Returns and clears the list of source event IDs that must be removed by the
  // given source because a priority handoff transferred ownership away from it.
  // Called from each source's tick() for near-immediate handoff cleanup.
  function getPendingRemovals(sourceId) {
    var list = _pendingRemovals[sourceId];
    if (!list || list.length === 0) return null;
    _pendingRemovals[sourceId] = [];
    return list;
  }

  // ── query ─────────────────────────────────────────────────────────────────────
  // Non-mutating registry lookup. Used by sprite loops to verify live ownership.
  function query(ev) {
    return _registry.get(_canonicalKey(ev)) || null;
  }

  // ── diagReport ────────────────────────────────────────────────────────────────
  function diagReport() {
    console.group('%c[ArgusWeatherGate]', 'color:#ff9944;font-weight:bold');
    console.log('  Registry entries     :', _registry.size);
    console.log('  Claims granted       :', _audit.claimsGranted);
    console.log('  Claims blocked       :', _audit.claimsBlocked);
    console.log('  Enrichments applied  :', _audit.enrichments);
    console.log('  Priority handoffs    :', _audit.handoffs);
    console.log('  Hard-cap activations :', _audit.hardCapHits);
    console.log('── Priority table (score / 100 per source) ─────────────────────');
    Object.keys(SOURCE_PRIORITY).forEach(function (cat) {
      var t = SOURCE_PRIORITY[cat];
      console.log('  ' + cat + ': NOAA=' + t.NOAA + ' GDACS=' + t.GDACS + ' EONET=' + t.EONET);
    });
    console.log('── Active registry ─────────────────────────────────────────────');
    _registry.forEach(function (e, k) {
      console.log(' ', k,
        '| owner=' + (e.ownerSource || 'NONE') +
        ' | sources=[' + e.sources.join(',') + ']' +
        ' | lat=' + e.lat + ' lon=' + e.lon);
    });
    console.groupEnd();
  }

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusWeatherGate');

  return {
    claim:              claim,
    keepAlive:          keepAlive,
    release:            release,
    getPendingRemovals: getPendingRemovals,
    query:              query,
    diagReport:         diagReport,
    SOURCE_PRIORITY:    SOURCE_PRIORITY,
  };

}());
