'use strict';
// netlify/lib/gdacs-validator.js
// Validation layer for raw GDACS GeoJSON feature payloads.
//
// Contract:
//   validateResponse(json)   → { valid, errors, featureCount }
//   validateFeature(feature) → { valid, errors, warnings }
//
// Design principles:
//   - Non-throwing — all functions return result objects, never throw
//   - Per-field diagnostics — every failure has a named, actionable error message
//   - Errors vs warnings — errors block normalization; warnings are logged and pass through
//   - Individual event rejection — validation failure on one feature never collapses the cycle
//   - Schema-agnostic failure signaling — callers decide how to handle each result
//
// Validation scopes:
//   Response-level:  structural validity of the GeoJSON FeatureCollection wrapper
//   Feature-level:   coordinates, timestamps, identity, severity, event type, alert level

var VALID_EVENT_TYPES  = { EQ: 1, TC: 1, FL: 1, VO: 1, DR: 1, WF: 1, TS: 1 };
var VALID_ALERT_LEVELS = { Red: 1, Orange: 1, Green: 1 };

var COORD_BOUNDS = { minLon: -180, maxLon: 180, minLat: -90, maxLat: 90 };

// Plausible year range for GDACS events (GDACS launched in 2004)
var MIN_YEAR = 2004;
var MAX_YEAR = 2100;

// ── Coordinate validation ─────────────────────────────────────────────────────────

function _validatePointCoordinates(coords) {
  if (!Array.isArray(coords) || coords.length < 2) {
    return 'geometry.coordinates: must be [lon, lat] array with at least 2 elements';
  }
  var lon = coords[0];
  var lat = coords[1];
  if (typeof lon !== 'number' || isNaN(lon)) {
    return 'geometry.coordinates[0] (lon): must be a finite number, got ' + typeof lon;
  }
  if (typeof lat !== 'number' || isNaN(lat)) {
    return 'geometry.coordinates[1] (lat): must be a finite number, got ' + typeof lat;
  }
  if (!isFinite(lon)) return 'geometry.coordinates[0] (lon): non-finite value';
  if (!isFinite(lat)) return 'geometry.coordinates[1] (lat): non-finite value';
  if (lon < COORD_BOUNDS.minLon || lon > COORD_BOUNDS.maxLon) {
    return 'geometry.coordinates[0] (lon): out of range [' + lon + '] — must be -180..180';
  }
  if (lat < COORD_BOUNDS.minLat || lat > COORD_BOUNDS.maxLat) {
    return 'geometry.coordinates[1] (lat): out of range [' + lat + '] — must be -90..90';
  }
  return null;  // valid
}

// ── Timestamp validation ──────────────────────────────────────────────────────────

function _validateTimestamp(value, fieldName, required) {
  if (value == null || value === '') {
    return required ? (fieldName + ': required field is missing or empty') : null;
  }
  var d = new Date(value);
  if (isNaN(d.getTime())) {
    return fieldName + ': unparseable date string "' + String(value).slice(0, 64) + '"';
  }
  var yr = d.getFullYear();
  if (yr < MIN_YEAR || yr > MAX_YEAR) {
    return fieldName + ': implausible year ' + yr + ' (expected ' + MIN_YEAR + '–' + MAX_YEAR + ')';
  }
  return null;
}

// ── Event identity validation ─────────────────────────────────────────────────────

function _validateEventId(props) {
  var id = props.eventid;
  if (id == null) return 'properties.eventid: missing or null';
  if (typeof id !== 'number' && typeof id !== 'string') {
    return 'properties.eventid: invalid type "' + typeof id + '" (expected number or string)';
  }
  var str = String(id).trim();
  if (str.length === 0) return 'properties.eventid: empty string';
  return null;
}

function _validateEventType(props) {
  var t = props.eventtype;
  if (!t) return 'properties.eventtype: missing or empty';
  var upper = String(t).toUpperCase();
  if (!VALID_EVENT_TYPES[upper]) {
    return 'properties.eventtype: unrecognized code "' + t + '" — known: ' +
      Object.keys(VALID_EVENT_TYPES).join(',');
  }
  return null;
}

// ── Severity / metric object validation ───────────────────────────────────────────

function _validateMetricObject(obj, fieldName) {
  if (obj == null) return null;  // optional field — absence is fine
  if (typeof obj !== 'object' || Array.isArray(obj)) {
    return fieldName + ': expected object, got ' + (Array.isArray(obj) ? 'array' : typeof obj);
  }
  if (obj.value !== undefined && typeof obj.value !== 'number') {
    return fieldName + '.value: expected number, got ' + typeof obj.value;
  }
  return null;
}

// ── Response-level validation ─────────────────────────────────────────────────────

/**
 * Validate the root GDACS API response.
 * Rejects if: null, not an object, wrong type, or missing features array.
 *
 * @param  {*} json — parsed JSON from GDACS API
 * @returns {{ valid: boolean, errors: string[], featureCount: number }}
 */
function validateResponse(json) {
  var errors = [];

  if (json == null || typeof json !== 'object' || Array.isArray(json)) {
    return { valid: false, errors: ['response: null, non-object, or array'], featureCount: 0 };
  }
  if (json.type !== 'FeatureCollection') {
    errors.push('response.type: expected "FeatureCollection", got "' + json.type + '"');
  }
  if (!Array.isArray(json.features)) {
    errors.push('response.features: missing or not an array');
    return { valid: false, errors: errors, featureCount: 0 };
  }

  return {
    valid:        errors.length === 0,
    errors:       errors,
    featureCount: json.features.length,
  };
}

// ── Feature-level validation ──────────────────────────────────────────────────────

/**
 * Validate a single GDACS GeoJSON feature.
 * Errors block normalization. Warnings are advisory — feature still proceeds.
 *
 * @param  {*} feature — single element from features array
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validateFeature(feature) {
  var errors   = [];
  var warnings = [];

  // ── Null / type guard ───────────────────────────────────────────────────────
  if (feature == null || typeof feature !== 'object') {
    return { valid: false, errors: ['feature: null or non-object'], warnings: [] };
  }

  // ── GeoJSON type ────────────────────────────────────────────────────────────
  if (feature.type !== 'Feature') {
    errors.push('feature.type: expected "Feature", got "' + feature.type + '"');
  }

  // ── Geometry ────────────────────────────────────────────────────────────────
  var geo = feature.geometry;
  if (!geo) {
    errors.push('feature.geometry: missing or null — cannot place on globe');
  } else if (geo.type === 'Point') {
    var coordErr = _validatePointCoordinates(geo.coordinates);
    if (coordErr) errors.push(coordErr);
  } else if (geo.type === 'Polygon' || geo.type === 'MultiPoint') {
    // Non-point geometries — normalizer will compute centroid; flag as warning
    warnings.push('feature.geometry.type: "' + geo.type + '" — normalizer will compute centroid');
    if (!Array.isArray(geo.coordinates) || geo.coordinates.length === 0) {
      errors.push('feature.geometry.coordinates: empty for geometry type "' + geo.type + '"');
    }
  } else {
    warnings.push('feature.geometry.type: unexpected "' + geo.type + '" — coordinate extraction may fail');
  }

  // ── Properties ──────────────────────────────────────────────────────────────
  var props = feature.properties;
  if (!props || typeof props !== 'object') {
    errors.push('feature.properties: missing or null');
    // Cannot validate any properties — fail fast
    return { valid: false, errors: errors, warnings: warnings };
  }

  // Event identity — both are required
  var idErr   = _validateEventId(props);
  var typeErr = _validateEventType(props);
  if (idErr)   errors.push(idErr);
  if (typeErr) errors.push(typeErr);

  // Timestamps — fromdate is required; others are advisory
  var fromErr  = _validateTimestamp(props.fromdate,      'properties.fromdate',      true);
  var toWarn   = _validateTimestamp(props.todate,        'properties.todate',        false);
  var modWarn  = _validateTimestamp(props.datemodified,  'properties.datemodified',  false);
  if (fromErr) errors.push(fromErr);
  if (toWarn)  warnings.push(toWarn + ' (todate — warning only, event may be ongoing)');
  if (modWarn) warnings.push(modWarn + ' (datemodified — warning only)');

  // Alert level — present in most events; advisory if absent or unrecognized
  if (props.alertlevel && !VALID_ALERT_LEVELS[props.alertlevel]) {
    warnings.push('properties.alertlevel: unrecognized value "' + props.alertlevel +
      '" — known: Red,Orange,Green — will map to "unknown"');
  }

  // Severity and population metric objects — structural only
  var sevWarn = _validateMetricObject(props.severity,   'properties.severity');
  var popWarn = _validateMetricObject(props.population, 'properties.population');
  if (sevWarn) warnings.push(sevWarn);
  if (popWarn) warnings.push(popWarn);

  // Episode ID — advisory if missing (some GDACS events omit it)
  if (props.episodeid == null) {
    warnings.push('properties.episodeid: missing — eventId will use episode 0');
  }

  return {
    valid:    errors.length === 0,
    errors:   errors,
    warnings: warnings,
  };
}

module.exports = {
  validateResponse: validateResponse,
  validateFeature:  validateFeature,
};
