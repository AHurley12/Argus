'use strict';
// modules/argusSupplyRoute.js
// ARGUS Supply Chain Route Analysis
//
// Lets users search two locations (export origin + import destination),
// draws a great-circle route line on the globe, and provides:
//   - Hover tooltips on the marker pins (live vessel/aircraft counts, regional trade stats)
//   - Route risk score from CHOKEPOINTS_DATA, COUNTRIES_DATA, and live ArgusGIS ACLED index
//   - Live traffic count refreshed every 60s
//
// Public API: window.ArgusSupplyRoute
//   .open()            — show panel
//   .close()           — hide panel + clear globe objects
//   .toggle()          — open/close
//   .isOpen()          — bool
//   .search(type)      — geocode and plot ('export' | 'import')
//   .clear()           — remove both pins + line from globe
//   .buildPinTooltip(d)— returns HTML string for hover tooltip (called by buildTooltipRow)

window.ArgusSupplyRoute = (function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────────────────
  var _exportLoc   = null;   // { lat, lon, name }
  var _importLoc   = null;   // { lat, lon, name }
  var _exportPin   = null;   // THREE.Mesh
  var _importPin   = null;   // THREE.Mesh
  var _routeLine   = null;   // THREE.Line
  var _pinGroup    = null;   // THREE.Group → ArgusGlobe.dataGroup
  var _riskCache   = null;   // { score, tier, chokepoints[], flags[] }
  var _panelOpen   = false;
  var _trafficTimer = null;

  // ── Risk tier colours (mirrors RISK_CSS in index.html) ────────────────────────
  var _RISK_CSS = { CRITICAL: '#ff0044', WARNING: '#ff9933', WATCH: '#ffcc00', LOW: '#00ff88' };

  // ── Nominatim geocoder ────────────────────────────────────────────────────────
  // Same pattern as ArgusEvents.geocode (index.html L6796).
  function _geocode(query) {
    var url = 'https://nominatim.openstreetmap.org/search?q=' +
      encodeURIComponent(query) + '&format=json&limit=1';
    return fetch(url, { headers: { 'Accept-Language': 'en', 'User-Agent': 'ArgusIntel/1.0' } })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res || !res.length) throw new Error('Location not found: ' + query);
        return { lat: parseFloat(res[0].lat), lon: parseFloat(res[0].lon), name: res[0].display_name };
      });
  }

  // ── Vector slerp (great-circle interpolation between two unit vectors) ────────
  // Identical to slerpVec3 in index.html L1627.
  function _slerp3(v0, v1, t) {
    var dot = Math.min(1, Math.max(-1, v0.dot(v1)));
    var omega = Math.acos(dot);
    if (Math.abs(omega) < 0.0001) {
      return new THREE.Vector3().lerpVectors(v0, v1, t);
    }
    var sinOmega = Math.sin(omega);
    var a = Math.sin((1 - t) * omega) / sinOmega;
    var b = Math.sin(t * omega)       / sinOmega;
    return new THREE.Vector3(
      a * v0.x + b * v1.x,
      a * v0.y + b * v1.y,
      a * v0.z + b * v1.z
    );
  }

  // ── Nearest COUNTRIES_DATA entry by haversine ─────────────────────────────────
  function _nearestCountry(lat, lon) {
    var countries = window.COUNTRIES_DATA || [];
    var best = null, bestDist = Infinity;
    var hav = window.ArgusGIS ? window.ArgusGIS.haversineKm : _haversineKm;
    countries.forEach(function (c) {
      var d = hav(lat, lon, c.rawLat, c.rawLon);
      if (d < bestDist) { bestDist = d; best = c; }
    });
    return best;
  }

  // Fallback haversine when ArgusGIS not yet available
  function _haversineKm(lat1, lon1, lat2, lon2) {
    var R = 6371, toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ── Remove existing pins + line from _pinGroup ────────────────────────────────
  function _clearGlobe() {
    if (_pinGroup) {
      // Remove from group
      if (_exportPin) { _pinGroup.remove(_exportPin); _exportPin = null; }
      if (_importPin) { _pinGroup.remove(_importPin); _importPin = null; }
      if (_routeLine) { _pinGroup.remove(_routeLine); _routeLine = null; }
    }
    // Clear the global raycaster array
    if (window._supplyRoutePins) window._supplyRoutePins.length = 0;
  }

  // ── Build a single cone mesh at the given lat/lon ─────────────────────────────
  function _buildPin(lat, lon, colorHex, pinType, locObj) {
    var AG  = window.ArgusGlobe;
    if (!AG) return null;
    var altR = ((AG.R && AG.R.MARKER) || 101) + 1.5;
    var pos  = AG.latLonToVector(lat, lon, altR);

    // ConeGeometry: tip points +Y by default.
    // Rotate so tip points away from globe centre (outward normal).
    var geo  = new THREE.ConeGeometry(1.0, 3.2, 8);
    var mat  = new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.92, depthWrite: false });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos);
    var outward = pos.clone().normalize();
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), outward);
    mesh.userData = {
      _supplyRoute: true,
      _pinType:     pinType,   // 'export' | 'import'
      _loc:         locObj,
    };
    return mesh;
  }

  // ── Build the great-circle route line ─────────────────────────────────────────
  // Pure surface great circle (no arc lift) — 80 segments.
  // Change _buildLine() internals later to add arc, waypoints, etc.
  function _buildLine(exportLoc, importLoc) {
    var AG  = window.ArgusGlobe;
    if (!AG) return null;
    var altR = ((AG.R && AG.R.MARKER) || 101) + 0.8;
    var r0   = AG.latLonToVector(exportLoc.lat, exportLoc.lon, altR);
    var r1   = AG.latLonToVector(importLoc.lat, importLoc.lon, altR);
    var u0   = r0.clone().normalize();
    var u1   = r1.clone().normalize();
    var SEGS = 80;
    var pts  = [];
    for (var i = 0; i <= SEGS; i++) {
      pts.push(_slerp3(u0, u1, i / SEGS).multiplyScalar(altR));
    }
    var geo  = new THREE.BufferGeometry().setFromPoints(pts);
    var mat  = new THREE.LineBasicMaterial({ color: 0x44aaff, transparent: true, opacity: 0.55, depthWrite: false });
    var line = new THREE.Line(geo, mat);
    line.userData = { _supplyRouteLine: true };
    return line;
  }

  // ── Place / refresh globe objects ─────────────────────────────────────────────
  function _buildGlobe() {
    var AG = window.ArgusGlobe;
    if (!AG || !AG.dataGroup) return;

    _clearGlobe();

    // Create persistent group on first use
    if (!_pinGroup) {
      _pinGroup = new THREE.Group();
      _pinGroup.name = 'ArgusSupplyRoute';
      AG.dataGroup.add(_pinGroup);
    }

    if (_exportLoc) {
      _exportPin = _buildPin(_exportLoc.lat, _exportLoc.lon, 0xffcc00, 'export', _exportLoc);
      if (_exportPin) {
        _pinGroup.add(_exportPin);
        window._supplyRoutePins.push(_exportPin);
      }
    }

    if (_importLoc) {
      _importPin = _buildPin(_importLoc.lat, _importLoc.lon, 0x00ff88, 'import', _importLoc);
      if (_importPin) {
        _pinGroup.add(_importPin);
        window._supplyRoutePins.push(_importPin);
      }
    }

    if (_exportLoc && _importLoc) {
      _routeLine = _buildLine(_exportLoc, _importLoc);
      if (_routeLine) _pinGroup.add(_routeLine);
    }
  }

  // ── Route risk assessment ─────────────────────────────────────────────────────
  // Samples 10 lat/lon points along the route (linear interpolation is sufficient
  // for risk—no need for exact great-circle at this coarseness).
  function _assessRisk() {
    if (!_exportLoc || !_importLoc) return;
    var hav  = window.ArgusGIS ? window.ArgusGIS.haversineKm : _haversineKm;
    var score = 0;
    var chokepointsSeen = {};
    var chokepointList  = [];
    var flagsSeen  = {};
    var flagList   = [];
    var countryContrib = 0;

    for (var i = 0; i <= 9; i++) {
      var t   = i / 9;
      var lat = _exportLoc.lat + (_importLoc.lat - _exportLoc.lat) * t;
      var lon = _exportLoc.lon + (_importLoc.lon - _exportLoc.lon) * t;

      // 1. Chokepoints
      var cps = window.CHOKEPOINTS_DATA || [];
      cps.forEach(function (cp) {
        if (chokepointsSeen[cp.id || cp.label]) return;
        var d = hav(lat, lon, cp.rawLat, cp.rawLon);
        if (d < 400) {
          chokepointsSeen[cp.id || cp.label] = true;
          chokepointList.push(cp.label);
          if (cp.risk === 'CRITICAL') score += 25;
          else if (cp.risk === 'WARNING') score += 15;
          else score += 8;
        }
      });

      // 2. High-risk country proximity (score > 70)
      if (countryContrib < 2) {
        var countries = window.COUNTRIES_DATA || [];
        countries.forEach(function (c) {
          if (flagsSeen[c.code]) return;
          if (c.score <= 70) return;
          var d = hav(lat, lon, c.rawLat, c.rawLon);
          if (d < 500) {
            flagsSeen[c.code] = true;
            flagList.push(c.label);
            score += c.score * 0.3;
            countryContrib++;
          }
        });
      }

      // 3. Live ACLED conflict events
      if (window.ArgusGIS) {
        var hits = window.ArgusGIS.within('acled', lat, lon, 250) || [];
        if (hits.length > 0) score += Math.min(hits.length * 8, 20);
      }
    }

    score = Math.min(100, Math.round(score));
    var tier = score >= 75 ? 'CRITICAL' : score >= 50 ? 'WARNING' : score >= 25 ? 'WATCH' : 'LOW';

    _riskCache = {
      score:       score,
      tier:        tier,
      chokepoints: chokepointList.slice(0, 4),
      flags:       flagList.slice(0, 3),
    };

    _renderRisk();
    _renderChokepoints();
  }

  // ── Live traffic count ────────────────────────────────────────────────────────
  function _updateTraffic() {
    if (!_exportLoc || !_importLoc || !window.ArgusGIS) return;
    var vessels  = 0;
    var aircraft = 0;
    var seenV    = {};
    var seenA    = {};
    var tVals    = [0.25, 0.5, 0.75];

    tVals.forEach(function (t) {
      var lat = _exportLoc.lat + (_importLoc.lat - _exportLoc.lat) * t;
      var lon = _exportLoc.lon + (_importLoc.lon - _exportLoc.lon) * t;

      var ships = window.ArgusGIS.within('ship',       lat, lon, 200) || [];
      var ais   = window.ArgusGIS.within('ais_vessel', lat, lon, 200) || [];
      ships.concat(ais).forEach(function (v) {
        var key = (v && v.mmsi) ? String(v.mmsi) : (lat + ',' + lon + '_v' + vessels);
        if (!seenV[key]) { seenV[key] = true; vessels++; }
      });

      var planes = window.ArgusGIS.within('aircraft', lat, lon, 200) || [];
      planes.forEach(function (p) {
        var key = (p && p.icao24) ? String(p.icao24) : (lat + ',' + lon + '_a' + aircraft);
        if (!seenA[key]) { seenA[key] = true; aircraft++; }
      });
    });

    _renderTraffic(vessels, aircraft);
  }

  // ── Panel DOM renderers ───────────────────────────────────────────────────────
  function _renderRisk() {
    var el = document.getElementById('srl-risk-display');
    if (!el || !_riskCache) return;
    var col = _RISK_CSS[_riskCache.tier] || '#aaa';
    el.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">' +
        '<span style="color:' + col + ';font-weight:700;font-size:13px">' + _riskCache.score + '</span>' +
        '<span style="color:#4a7da8;font-size:8px">/ 100</span>' +
        '<span style="color:' + col + ';font-size:8px;letter-spacing:1px;border:1px solid ' + col + ';padding:1px 5px;border-radius:2px">' + _riskCache.tier + '</span>' +
      '</div>' +
      (_riskCache.flags.length
        ? '<div style="color:#4a7da8;font-size:8px">HIGH-RISK PROXIMATE: <span style="color:#c5d7e8">' + _riskCache.flags.join(', ') + '</span></div>'
        : '');
  }

  function _renderChokepoints() {
    var el = document.getElementById('srl-chokepoints-display');
    if (!el) return;
    if (!_riskCache || !_riskCache.chokepoints.length) {
      el.innerHTML = '<div style="color:#4a6080;font-size:8px">None within 400 km</div>';
      return;
    }
    el.innerHTML = _riskCache.chokepoints.map(function (label) {
      return '<div style="color:#c5d7e8;font-size:8px;margin-bottom:2px">◆ ' + label + '</div>';
    }).join('');
  }

  function _renderTraffic(vessels, aircraft) {
    var el = document.getElementById('srl-traffic-display');
    if (!el) return;
    el.innerHTML =
      '<div style="display:flex;gap:14px">' +
        '<div><div style="color:#4a7da8;font-size:7px;letter-spacing:1px">VESSELS</div>' +
             '<div style="color:#c5d7e8;font-size:13px;font-weight:700">' + vessels + '</div></div>' +
        '<div><div style="color:#4a7da8;font-size:7px;letter-spacing:1px">AIRCRAFT</div>' +
             '<div style="color:#c5d7e8;font-size:13px;font-weight:700">' + aircraft + '</div></div>' +
      '</div>' +
      '<div style="color:#4a6080;font-size:7px;margin-top:3px">Sampled within 200 km of route midpoints</div>';
  }

  function _showRouteBody() {
    var el = document.getElementById('srl-route-body');
    if (el) el.style.display = '';
  }

  // ── Panel open / close ────────────────────────────────────────────────────────
  function open() {
    var panel = document.getElementById('panel-supply-route');
    if (!panel) return;
    panel.style.display = '';
    _panelOpen = true;
  }

  function close() {
    var panel = document.getElementById('panel-supply-route');
    if (panel) panel.style.display = 'none';
    _panelOpen = false;
    // Clear globe objects when panel closes
    _clearGlobe();
    _exportLoc = null;
    _importLoc = null;
    _riskCache = null;
    if (_trafficTimer) { clearInterval(_trafficTimer); _trafficTimer = null; }
    // Reset inputs and status
    var expIn = document.getElementById('srl-export-input');
    var impIn = document.getElementById('srl-import-input');
    var expSt = document.getElementById('srl-export-status');
    var impSt = document.getElementById('srl-import-status');
    var body  = document.getElementById('srl-route-body');
    if (expIn) expIn.value = '';
    if (impIn) impIn.value = '';
    if (expSt) expSt.textContent = '';
    if (impSt) impSt.textContent = '';
    if (body)  body.style.display = 'none';
  }

  function toggle() {
    if (_panelOpen) close(); else open();
  }

  // ── Search (geocode + plot) ───────────────────────────────────────────────────
  function search(type) {
    var inputId  = type === 'export' ? 'srl-export-input'  : 'srl-import-input';
    var statusId = type === 'export' ? 'srl-export-status' : 'srl-import-status';
    var inputEl  = document.getElementById(inputId);
    var statusEl = document.getElementById(statusId);
    if (!inputEl || !statusEl) return;
    var query = inputEl.value.trim();
    if (!query) return;

    statusEl.textContent = 'SEARCHING…';
    statusEl.style.color = '#4a7da8';

    _geocode(query)
      .then(function (loc) {
        // Truncate display name to first two comma-segments
        var shortName = loc.name.split(',').slice(0, 2).join(',').trim();
        statusEl.textContent = shortName;
        statusEl.style.color = type === 'export' ? '#ffcc00' : '#00ff88';

        if (type === 'export') _exportLoc = loc;
        else                   _importLoc = loc;

        _buildGlobe();

        if (_exportLoc && _importLoc) {
          _showRouteBody();
          _assessRisk();
          _updateTraffic();
          if (_trafficTimer) clearInterval(_trafficTimer);
          _trafficTimer = setInterval(_updateTraffic, 60 * 1000);
        }
      })
      .catch(function () {
        statusEl.textContent = 'NOT FOUND';
        statusEl.style.color = '#ff4400';
      });
  }

  // ── Clear route ───────────────────────────────────────────────────────────────
  function clear() {
    _clearGlobe();
    _exportLoc = null;
    _importLoc = null;
    _riskCache = null;
    if (_trafficTimer) { clearInterval(_trafficTimer); _trafficTimer = null; }

    var expIn = document.getElementById('srl-export-input');
    var impIn = document.getElementById('srl-import-input');
    var expSt = document.getElementById('srl-export-status');
    var impSt = document.getElementById('srl-import-status');
    var body  = document.getElementById('srl-route-body');
    if (expIn) expIn.value = '';
    if (impIn) impIn.value = '';
    if (expSt) { expSt.textContent = ''; expSt.style.color = ''; }
    if (impSt) { impSt.textContent = ''; impSt.style.color = ''; }
    if (body)  body.style.display = 'none';
  }

  // ── Hover tooltip HTML ────────────────────────────────────────────────────────
  // Called from buildTooltipRow in index.html when d._supplyRoute === true.
  function buildPinTooltip(d) {
    var loc    = d._loc;
    var type   = d._pinType;
    var color  = type === 'export' ? '#ffcc00' : '#00ff88';
    var label  = type === 'export' ? '⬆ EXPORT ORIGIN' : '⬇ IMPORT DESTINATION';

    var hav       = window.ArgusGIS ? window.ArgusGIS.haversineKm : _haversineKm;
    var nearest   = _nearestCountry(loc.lat, loc.lon);
    var riskColor = nearest ? (_RISK_CSS[nearest.risk] || '#aaa') : '#aaa';

    // Live vessel/aircraft counts within 150 km of this specific pin
    var nearVessels = 0, nearAir = 0;
    if (window.ArgusGIS) {
      var ships = window.ArgusGIS.within('ship',       loc.lat, loc.lon, 150) || [];
      var ais   = window.ArgusGIS.within('ais_vessel', loc.lat, loc.lon, 150) || [];
      nearVessels = ships.length + ais.length;
      nearAir = (window.ArgusGIS.within('aircraft', loc.lat, loc.lon, 150) || []).length;
    }

    var shortName = loc.name.split(',').slice(0, 2).join(',').trim();

    var html = '<div style="padding:4px 0">';
    html += '<div style="color:' + color + ';font-weight:700;font-size:10px;margin-bottom:3px">' + label + '</div>';
    html += '<div style="color:#c5d7e8;font-size:9px;margin-bottom:5px">' + shortName + '</div>';

    if (nearest) {
      html += '<div style="color:#4a7da8;font-size:8px;margin-bottom:2px">NEAREST COUNTRY: <span style="color:#c5d7e8">' + nearest.label + '</span></div>';
      if (nearest.topE && nearest.topE[0]) {
        html += '<div style="color:#4a7da8;font-size:8px;margin-bottom:2px">TOP EXPORT: <span style="color:#c5d7e8">' + nearest.topE[0] + '</span></div>';
      }
      html += '<div style="color:#4a7da8;font-size:8px;margin-bottom:4px">REGION RISK: <span style="color:' + riskColor + '">' + nearest.risk + ' (' + nearest.score + '/100)</span></div>';
    }

    html += '<div style="display:flex;gap:12px;border-top:1px solid rgba(255,255,255,0.06);padding-top:4px">';
    html += '<div style="color:#4a7da8;font-size:8px">VESSELS <span style="color:#c5d7e8;font-weight:700">' + nearVessels + '</span></div>';
    html += '<div style="color:#4a7da8;font-size:8px">AIRCRAFT <span style="color:#c5d7e8;font-weight:700">' + nearAir + '</span></div>';
    html += '</div>';
    html += '</div>';
    return html;
  }

  // ── Init ──────────────────────────────────────────────────────────────────────
  console.log('[ArgusSupplyRoute] ready');
  if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusSupplyRoute');

  // ── Public API ────────────────────────────────────────────────────────────────
  return {
    open:            open,
    close:           close,
    toggle:          toggle,
    isOpen:          function () { return _panelOpen; },
    search:          search,
    clear:           clear,
    buildPinTooltip: buildPinTooltip,
  };

}());
