'use strict';
// core/providers/maritime/normalizeVessel.js
// Unified vessel schema normalization for the Argus maritime ingestion layer.
//
// Every upstream provider routes through a provider-specific adapter that emits
// the canonical ArgusVessel shape. The renderer and cache never touch raw
// provider payloads directly.
//
// Canonical schema (window.ArgusNormalizeVessel.SCHEMA):
//   id           — composite key: '{source}:{mmsi}' — used for Map keying + dedup
//   mmsi         — 9-digit string, zero-padded
//   imo          — string | null
//   name         — trimmed string ('VESSEL' if absent)
//   callsign     — string | null
//   lat          — number, 4dp, validated [-90, 90]
//   lon          — number, 4dp, validated [-180, 180]
//   sog          — knots, 2dp, null if unknown/invalid
//   cog          — degrees 0-360, 1dp, null if unknown
//   heading      — integer 0-359, null if 511 (N/A) or absent
//   navStatus    — ITU-R M.1371-5 numeric code, null if unknown
//   vesselType   — ITU-R M.1371-5 numeric code, null if unknown
//   typeCategory — cargo | tanker | military | passenger | fishing | tug |
//                  port_service | recreational | other | unknown
//   destination  — string | null
//   eta          — ISO string | null
//   length       — metres, null if unknown
//   width        — metres, null if unknown
//   flag         — ISO 3166-1 alpha-2, null if unknown
//   source       — provider identifier string
//   lastUpdate   — ms epoch
//   raw          — original upstream payload (never mutated)
//
// toShipBufferEntry(v) — converts ArgusVessel to argusTracking.shipBuffer shape
// for direct consumption by placeShip() in argusTracking.js.

(function () {
  'use strict';

  // ── Vessel type classification (mirrors fetch-vessels.js classifyVessel) ───────
  // Accepts ITU-R M.1371-5 numeric code or string descriptor or vessel name.
  function classifyType(rawType, name) {
    var num = parseInt(rawType, 10);
    if (!isNaN(num) && num > 0) {
      if (num === 35)                              return 'military';
      if (num === 30)                              return 'fishing';
      if (num === 31 || num === 32 || num === 52)  return 'tug';
      if (num === 36 || num === 37)                return 'recreational';
      if (num >= 50 && num <= 59)                  return 'port_service';
      if (num >= 60 && num <= 69)                  return 'passenger';
      if (num >= 70 && num <= 79)                  return 'cargo';
      if (num >= 80 && num <= 89)                  return 'tanker';
      return 'unknown';
    }
    var src = ((rawType || '') + ' ' + (name || '')).toLowerCase();
    if (!src.trim()) return 'unknown';
    if (/military|naval|navy|warship|coast.?guard/.test(src))       return 'military';
    if (/tug|salvage|offshore.?supply/.test(src))                   return 'tug';
    if (/pilot|patrol|law.?enfor|search.?rescue/.test(src))         return 'port_service';
    if (/sail|pleasure|yacht|recreation/.test(src))                 return 'recreational';
    if (/tanker/.test(src))                                         return 'tanker';
    if (/cargo|container|bulk|carrier/.test(src))                   return 'cargo';
    if (/passenger|cruise|ferry/.test(src))                         return 'passenger';
    if (/fishing/.test(src))                                        return 'fishing';
    return 'other';
  }

  // ── Field sanitisers ──────────────────────────────────────────────────────────
  function _lat(v)  { var n = parseFloat(v); return (!isNaN(n) && n >= -90  && n <= 90)  ? +n.toFixed(4) : null; }
  function _lon(v)  { var n = parseFloat(v); return (!isNaN(n) && n >= -180 && n <= 180) ? +n.toFixed(4) : null; }
  function _sog(v)  { var n = parseFloat(v); return (!isNaN(n) && n >= 0 && n <= 102.2)  ? +n.toFixed(2) : null; }
  function _cog(v)  { var n = parseFloat(v); return (!isNaN(n) && n >= 0 && n <= 360)    ? +n.toFixed(1) : null; }
  function _head(v) { var n = parseInt(v, 10); return (!isNaN(n) && n !== 511 && n >= 0 && n <= 359) ? n : null; }
  function _mmsi(v) { var s = v != null ? String(v).replace(/\D/g, '') : ''; return s.length ? s.padStart(9, '0') : null; }
  function _str(v)  { return v != null ? String(v).trim() || null : null; }
  function _now()   { return Date.now(); }

  // ── Provider adapters ─────────────────────────────────────────────────────────
  // Each adapter accepts raw upstream records and returns a canonical ArgusVessel.

  // Digitraffic.fi — Finnish Transport Infrastructure Agency (Väylävirasto).
  //   pos:  {mmsi, geometry:{coordinates:[lon,lat]}, properties:{sog,cog,heading,navStat,shipType,updateTime}}
  //   meta: {mmsi, name, callSign, imo, destination, eta}  (optional, may be null)
  function fromDigitraffic(pos, meta) {
    var m    = meta || {};
    var p    = pos.properties || pos;
    var coords = (pos.geometry && pos.geometry.coordinates) || [];
    var mmsiStr = _mmsi(pos.mmsi || p.mmsi);
    var lat     = _lat(coords.length >= 2 ? coords[1] : pos.lat);
    var lon     = _lon(coords.length >= 2 ? coords[0] : pos.lon);
    if (!mmsiStr || lat === null || lon === null) return null;
    var vType = parseInt(p.shipType || p.type, 10) || null;
    return {
      id:           'digitraffic:' + mmsiStr,
      mmsi:         mmsiStr,
      imo:          _str(m.imo),
      name:         _str(m.name || p.name) || 'VESSEL',
      callsign:     _str(m.callSign || m.callsign),
      lat:          lat,
      lon:          lon,
      sog:          _sog(p.sog || p.speed),
      cog:          _cog(p.cog || p.course),
      heading:      _head(p.heading),
      navStatus:    p.navStat != null ? parseInt(p.navStat, 10) : null,
      vesselType:   vType,
      typeCategory: classifyType(vType, m.name || p.name),
      destination:  _str(m.destination || p.destination),
      eta:          _str(m.eta),
      length:       null,
      width:        null,
      flag:         null,
      source:       'digitraffic',
      lastUpdate:   p.updateTime ? new Date(p.updateTime).getTime() : _now(),
      raw:          pos,
    };
  }

  // AISHub — already-normalized objects from ais-vessels.js Netlify function.
  function fromAISHub(raw) {
    var mmsiStr = _mmsi(raw.mmsi);
    var lat     = _lat(raw.lat);
    var lon     = _lon(raw.lon);
    if (!mmsiStr || lat === null || lon === null) return null;
    return {
      id:           'aishub:' + mmsiStr,
      mmsi:         mmsiStr,
      imo:          null,
      name:         _str(raw.name) || 'VESSEL',
      callsign:     null,
      lat:          lat,
      lon:          lon,
      sog:          _sog(raw.velocity != null ? raw.velocity : raw.sog),
      cog:          _cog(raw.cog),
      heading:      _head(raw.heading),
      navStatus:    raw.navStatus != null ? parseInt(raw.navStatus, 10) : null,
      vesselType:   null,
      typeCategory: classifyType(raw.shipType, raw.name),
      destination:  null,
      eta:          null,
      length:       null,
      width:        null,
      flag:         null,
      source:       'aishub',
      lastUpdate:   raw.timestamp || _now(),
      raw:          raw,
    };
  }

  // VesselFinder Vessels API — raw AIS object extracted from the outer [[{AIS:{}}]] nesting
  // by the Netlify proxy. Field names are all-caps per VesselFinder spec.
  //
  // AIS layer fields:    LATITUDE, LONGITUDE, SPEED, COURSE, HEADING, NAVSTAT
  // Identity fields:     MMSI, IMO, NAME, CALLSIGN, TYPE
  // Dimension fields:    A+B = length (bow+stern halves), C+D = width (port+starboard)
  // Voyage fields:       DEST, ETA, TIMESTAMP (UTC string "YYYY-MM-DD HH:mm UTC")
  function fromVesselFinder(raw) {
    var mmsiStr = _mmsi(raw.MMSI);
    var lat     = _lat(raw.LATITUDE);
    var lon     = _lon(raw.LONGITUDE);
    if (!mmsiStr || lat === null || lon === null) return null;

    var vType  = parseInt(raw.TYPE, 10) || null;
    var dimA   = parseFloat(raw.A) || 0;
    var dimB   = parseFloat(raw.B) || 0;
    var dimC   = parseFloat(raw.C) || 0;
    var dimD   = parseFloat(raw.D) || 0;

    var lastUpdate;
    if (raw.TIMESTAMP) {
      var ts = new Date(String(raw.TIMESTAMP).replace(' UTC', 'Z').replace(' ', 'T'));
      lastUpdate = isNaN(ts.getTime()) ? _now() : ts.getTime();
    } else {
      lastUpdate = _now();
    }

    return {
      id:           'vesselfinder:' + mmsiStr,
      mmsi:         mmsiStr,
      imo:          _str(raw.IMO),
      name:         _str(raw.NAME) || 'VESSEL',
      callsign:     _str(raw.CALLSIGN),
      lat:          lat,
      lon:          lon,
      sog:          _sog(raw.SPEED),
      cog:          _cog(raw.COURSE),
      heading:      _head(raw.HEADING),
      navStatus:    raw.NAVSTAT != null ? parseInt(raw.NAVSTAT, 10) : null,
      vesselType:   vType,
      typeCategory: classifyType(vType, raw.NAME),
      destination:  _str(raw.DEST),
      eta:          _str(raw.ETA),
      length:       (dimA + dimB) > 0 ? (dimA + dimB) : null,
      width:        (dimC + dimD) > 0 ? (dimC + dimD) : null,
      flag:         null,
      source:       'vesselfinder',
      lastUpdate:   lastUpdate,
      raw:          raw,
    };
  }

  // Generic adapter — maps common field name variants defensively.
  // Use for any future provider until a dedicated adapter is written.
  function fromGeneric(raw, sourceId) {
    var mmsiStr = _mmsi(raw.mmsi || raw.MMSI);
    var lat     = _lat(raw.lat  || raw.latitude  || raw.LAT);
    var lon     = _lon(raw.lon  || raw.longitude || raw.LON || raw.lng);
    if (!mmsiStr || lat === null || lon === null) return null;
    var rawType = raw.vesselType || raw.shipType || raw.ship_type || raw.type;
    return {
      id:           (sourceId || 'generic') + ':' + mmsiStr,
      mmsi:         mmsiStr,
      imo:          _str(raw.imo || raw.IMO),
      name:         _str(raw.name || raw.shipName || raw.vessel_name || raw.NAME) || 'VESSEL',
      callsign:     _str(raw.callsign || raw.callSign || raw.CALLSIGN),
      lat:          lat,
      lon:          lon,
      sog:          _sog(raw.sog || raw.speed || raw.SOG || raw.speedOverGround),
      cog:          _cog(raw.cog || raw.course || raw.COG || raw.courseOverGround),
      heading:      _head(raw.heading || raw.trueHeading || raw.HEADING),
      navStatus:    raw.navStatus != null ? parseInt(raw.navStatus, 10) : null,
      vesselType:   parseInt(rawType, 10) || null,
      typeCategory: classifyType(rawType, raw.name),
      destination:  _str(raw.destination || raw.DESTINATION),
      eta:          _str(raw.eta || raw.ETA),
      length:       parseFloat(raw.length || raw.LENGTH) || null,
      width:        parseFloat(raw.width  || raw.WIDTH  || raw.beam) || null,
      flag:         _str(raw.flag || raw.FLAG || raw.country),
      source:       sourceId || 'generic',
      lastUpdate:   raw.lastUpdate || raw.timestamp || _now(),
      raw:          raw,
    };
  }

  // ── toShipBufferEntry ─────────────────────────────────────────────────────────
  // Maps a canonical ArgusVessel to the shape expected by placeShip() in
  // argusTracking.js. This is the only coupling point between the normalization
  // layer and the renderer — change placeShip() signature here, nowhere else.
  function toShipBufferEntry(v) {
    return {
      lat:          v.lat,
      lon:          v.lon,
      name:         v.name,
      sog:          v.sog,
      cog:          v.cog,
      typeCategory: v.typeCategory,
      mmsi:         v.mmsi,
      region:       'supp:' + v.source,
      navStatus:    v.navStatus,
      destination:  v.destination,
    };
  }

  window.ArgusNormalizeVessel = {
    classifyType:      classifyType,
    fromDigitraffic:   fromDigitraffic,
    fromAISHub:        fromAISHub,
    fromVesselFinder:  fromVesselFinder,
    fromGeneric:       fromGeneric,
    toShipBufferEntry: toShipBufferEntry,
  };

  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusNormalizeVessel');
}());
