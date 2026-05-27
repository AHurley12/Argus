'use strict';
// netlify/lib/gdacs-normalizer.js
// Normalization layer — maps validated GDACS GeoJSON features → canonical ARGUS event schema.
//
// Contract:
//   normalizeFeature(feature, adapter) → normalized event object | null
//
// Design principles:
//   - Never throws — exceptions are caught internally; return null to signal failure
//   - Full provenance preservation — rawSourceMetadata retains original GDACS properties
//   - Type-specific metric extraction — EQ/TC/FL/VO/DR/WF each have domain metrics
//   - Stable eventId — survives re-fetches; deduplication-safe across ingestion cycles
//   - Downstream agnostic — no frontend field names, no globe coordinates, no render hints
//   - Schema version tagged — enables future migration detection
//
// Output schema:
//   {
//     eventId, source, sourceEventId, sourceEpisodeId,
//     title, description, category, severity, alertScore,
//     coordinates: { lat, lon }, geometry,
//     startTime, updatedTime, expiresTime,
//     confidence, affectedRegions, tags, typeMetrics,
//     glide, sourceUrl,
//     rawSourceMetadata, ingestionTimestamp, schemaVersion
//   }

var SCHEMA_VERSION = '1.0.0';

// ── Safe scalar helpers ───────────────────────────────────────────────────────────

function _str(v, maxLen) {
  if (v == null) return null;
  var s = String(v);
  return maxLen ? s.slice(0, maxLen) : s;
}

function _num(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  return null;
}

function _date(v) {
  if (!v) return null;
  try {
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  } catch (_) { return null; }
}

// ── Metric object extraction ───────────────────────────────────────────────────────
// GDACS metric objects: { value: number, unit: string, description: string }

function _metric(obj) {
  if (!obj || typeof obj !== 'object') return null;
  return {
    value:       _num(obj.value),
    unit:        _str(obj.unit, 32),
    description: _str(obj.description, 512),
  };
}

// ── Event ID ─────────────────────────────────────────────────────────────────────
// Format: gdacs:{EVENTTYPE}:{eventid}:{episodeid}
// Stable across re-fetches. Deduplication-safe: same event+episode → same ID.

function _buildEventId(props) {
  var type    = _str(props.eventtype, 4)  || 'XX';
  var evid    = _str(props.eventid,   32) || '0';
  var episode = _str(props.episodeid, 16) || '0';
  return 'gdacs:' + type.toUpperCase() + ':' + evid + ':' + episode;
}

// ── Coordinate extraction ─────────────────────────────────────────────────────────
// Returns { lat, lon } from GeoJSON geometry, or null.
// GeoJSON convention: coordinates = [lon, lat].
// Handles Point, Polygon (first ring centroid), MultiPoint (first point).

function _extractCoordinates(geometry) {
  if (!geometry || !Array.isArray(geometry.coordinates)) return null;

  var coords = geometry.coordinates;

  if (geometry.type === 'Point') {
    var lon = coords[0];
    var lat = coords[1];
    if (typeof lon !== 'number' || typeof lat !== 'number') return null;
    if (!isFinite(lon) || !isFinite(lat)) return null;
    return { lat: lat, lon: lon };
  }

  if (geometry.type === 'Polygon' && Array.isArray(coords[0]) && coords[0].length > 0) {
    var ring = coords[0];
    var sumLon = 0, sumLat = 0, n = ring.length;
    for (var i = 0; i < n; i++) {
      sumLon += (ring[i][0] || 0);
      sumLat += (ring[i][1] || 0);
    }
    return { lat: sumLat / n, lon: sumLon / n };
  }

  if (geometry.type === 'MultiPoint' && Array.isArray(coords[0])) {
    return { lat: coords[0][1], lon: coords[0][0] };
  }

  return null;
}

// ── Type-specific metrics ─────────────────────────────────────────────────────────
// Extracts domain-specific operational metrics by event type.
// Returns a flat object — no nested event-type objects downstream needs to branch on.

function _extractTypeMetrics(eventType, props) {
  var t = (eventType || '').toUpperCase();
  var m = {};

  // All event types: severity extent + exposed population (if present)
  if (props.severity)   m.severityMetric   = _metric(props.severity);
  if (props.population) m.populationMetric = _metric(props.population);

  if (t === 'EQ') {
    // Earthquake: Richter magnitude, focal depth, vulnerability index
    if (props.magnitude) m.magnitudeMetric = _metric(props.magnitude);
    if (props.depth)     m.depthMetric     = _metric(props.depth);
    if (props.vuln != null) m.vulnerabilityIndex = _num(props.vuln);
  }

  if (t === 'TC') {
    // Tropical cyclone: wind speed, storm category
    if (props.wind)  m.windMetric   = _metric(props.wind);
    if (props.class) m.stormClass   = _str(props.class, 16);
  }

  if (t === 'VO') {
    // Volcano: Volcanic Explosivity Index (0–8 scale)
    if (props.vei != null) m.volcanicExplosivityIndex = _num(props.vei);
  }

  if (t === 'DR') {
    // Drought: affected area extent (severity object carries km² or %)
    // No additional fields beyond severity/population in standard GDACS schema
  }

  if (t === 'WF') {
    // Wildfire: fire radiative power or area extent via severity object
  }

  if (t === 'TS') {
    // Tsunami: wave height, warning level (custom GDACS fields when present)
    if (props.maxwave != null) m.maxWaveMetric = _metric(props.maxwave);
  }

  return m;
}

// ── Title ─────────────────────────────────────────────────────────────────────────
// Priority: eventname (if non-trivial) > constructed from category + country

function _buildTitle(props, adapter) {
  var name = _str(props.eventname, 200);
  if (name && name.trim().length > 0) return name.trim();

  var category = adapter.canonicalCategory(props.eventtype);
  var label = category.charAt(0).toUpperCase() + category.slice(1).replace(/_/g, ' ');
  var country = props.country ? (' — ' + _str(props.country, 80)) : '';
  return label + country;
}

// ── Description ───────────────────────────────────────────────────────────────────
// Synthesizes a human-readable description from available severity/population fields.

function _buildDescription(props) {
  var parts = [];
  if (props.severity   && props.severity.description)   parts.push(_str(props.severity.description,   256));
  if (props.population && props.population.description) parts.push(_str(props.population.description, 256));
  if (parts.length === 0 && props.description) parts.push(_str(props.description, 512));
  return parts.length > 0 ? parts.join(' · ') : null;
}

// ── Affected regions ──────────────────────────────────────────────────────────────

function _buildAffectedRegions(props) {
  var out = [];
  if (props.country) out.push(_str(props.country, 100));
  if (props.iso3 && out.indexOf(props.iso3) === -1) out.push(_str(props.iso3, 8));
  return out.filter(Boolean);
}

// ── Tags ─────────────────────────────────────────────────────────────────────────
// Lightweight searchable tags — event type code, alert level, ISO3 country code, glide.

function _buildTags(props) {
  var tags = [];
  if (props.eventtype)  tags.push(String(props.eventtype).toUpperCase());
  if (props.alertlevel) tags.push(props.alertlevel);
  if (props.iso3)       tags.push(String(props.iso3).toUpperCase());
  if (props.glide)      tags.push('GLIDE');
  return tags;
}

// ── Source URL ───────────────────────────────────────────────────────────────────

function _buildSourceUrl(props) {
  if (props.url) {
    if (typeof props.url === 'string') return _str(props.url, 512);
    if (props.url.report)  return _str(props.url.report, 512);
    if (props.url.details) return _str(props.url.details, 512);
  }
  return null;
}

// ── Primary normalization function ────────────────────────────────────────────────

/**
 * Normalize a validated GDACS GeoJSON feature into the canonical ARGUS event schema.
 *
 * @param  {object} feature — a single validated GeoJSON Feature from GDACS
 * @param  {object} adapter — the GDACS adapter (for category/severity lookups)
 * @returns {object|null}   — normalized ARGUS event, or null if normalization fails
 */
function normalizeFeature(feature, adapter) {
  try {
    var props  = feature.properties || {};
    var coords = _extractCoordinates(feature.geometry);

    // Coordinates are required — cannot place event without them
    if (!coords) return null;

    var eventType  = _str(props.eventtype, 4) || '';
    var alertLevel = props.alertlevel || null;

    return {
      // ── Identity ─────────────────────────────────────────────────────────────
      eventId:         _buildEventId(props),
      source:          'GDACS',
      sourceEventId:   _str(props.eventid,   32),
      sourceEpisodeId: _str(props.episodeid, 32),

      // ── Human-readable content ───────────────────────────────────────────────
      title:       _buildTitle(props, adapter),
      description: _buildDescription(props),

      // ── Classification ───────────────────────────────────────────────────────
      category:   adapter.canonicalCategory(eventType),
      severity:   adapter.canonicalSeverity(alertLevel),
      alertScore: _num(props.alertscore),

      // ── Spatial ──────────────────────────────────────────────────────────────
      // lat/lon flattened for direct consumption by rendering modules (matches
      // the existing ACLED/NOAA pattern: ev.lat, ev.lon)
      lat:        coords.lat,
      lon:        coords.lon,
      coordinates: coords,
      geometry:    feature.geometry,

      // ── Temporal ─────────────────────────────────────────────────────────────
      startTime:   _date(props.fromdate)     || _date(props.countryonsetdate),
      updatedTime: _date(props.datemodified),
      expiresTime: _date(props.todate),

      // ── Confidence ───────────────────────────────────────────────────────────
      // GDACS events are confirmed by EU JRC and UN OCHA — always 'confirmed'
      confidence: 'confirmed',

      // ── Geographic context ───────────────────────────────────────────────────
      affectedRegions: _buildAffectedRegions(props),
      tags:            _buildTags(props),

      // ── Type-specific operational metrics ────────────────────────────────────
      typeMetrics: _extractTypeMetrics(eventType, props),

      // ── Cross-reference identifiers ───────────────────────────────────────────
      glide:     _str(props.glide, 64) || null,
      sourceUrl: _buildSourceUrl(props),

      // ── Provenance ────────────────────────────────────────────────────────────
      // rawSourceMetadata: full GDACS properties object preserved for traceability.
      // Downstream systems must NOT depend on rawSourceMetadata fields — use
      // normalized schema fields above instead.
      rawSourceMetadata:  props,
      ingestionTimestamp: new Date().toISOString(),
      schemaVersion:      SCHEMA_VERSION,
    };
  } catch (err) {
    // Normalization must never throw — return null to skip this feature
    var evid = (feature && feature.properties && feature.properties.eventid) || 'unknown';
    console.warn('[gdacs-normalizer] normalization error for eventid=' + evid + ':', err.message);
    return null;
  }
}

module.exports = {
  normalizeFeature: normalizeFeature,
  SCHEMA_VERSION:   SCHEMA_VERSION,
};
