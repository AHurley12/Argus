window.ArgusRW = (function() {
'use strict';

var CACHE_KEY = 'argus_rw_v3';
var CACHE_TS  = 'argus_rw_ts_v3';
var TTL       = 2 * 60 * 60 * 1000; // 2 hours

window._rwData = {};

// ── Severity from GDACS alert level ──────────────────────────────────────────
// GDACS uses Green / Orange / Red alert levels
function gdacsSev(alertlevel) {
  var l = (alertlevel || '').toLowerCase();
  if (l === 'red')    return 'CRITICAL';
  if (l === 'orange') return 'WARNING';
  return 'WATCH';
}

// ── ISO3 from GDACS country codes (ISO2 → ISO3) ───────────────────────────────
var ISO2_TO_ISO3 = {
  AF:'AFG',AL:'ALB',DZ:'DZA',AO:'AGO',AR:'ARG',AM:'ARM',AU:'AUS',AT:'AUT',AZ:'AZE',
  BD:'BGD',BY:'BLR',BE:'BEL',BJ:'BEN',BO:'BOL',BA:'BIH',BW:'BWA',BR:'BRA',BG:'BGR',
  BF:'BFA',BI:'BDI',KH:'KHM',CM:'CMR',CA:'CAN',CF:'CAF',TD:'TCD',CL:'CHL',CN:'CHN',
  CO:'COL',CD:'COD',CG:'COG',CR:'CRI',CI:'CIV',HR:'HRV',CU:'CUB',CZ:'CZE',DK:'DNK',
  DJ:'DJI',DO:'DOM',EC:'ECU',EG:'EGY',SV:'SLV',ER:'ERI',EE:'EST',ET:'ETH',FI:'FIN',
  FR:'FRA',GA:'GAB',GE:'GEO',DE:'DEU',GH:'GHA',GR:'GRC',GT:'GTM',GN:'GIN',HT:'HTI',
  HN:'HND',HU:'HUN',IN:'IND',ID:'IDN',IR:'IRN',IQ:'IRQ',IL:'ISR',IT:'ITA',JP:'JPN',
  JO:'JOR',KZ:'KAZ',KE:'KEN',KW:'KWT',KG:'KGZ',LA:'LAO',LV:'LVA',LB:'LBN',LS:'LSO',
  LR:'LBR',LY:'LBY',LT:'LTU',MG:'MDG',MW:'MWI',MY:'MYS',ML:'MLI',MR:'MRT',MX:'MEX',
  MD:'MDA',MN:'MNG',MA:'MAR',MZ:'MOZ',MM:'MMR',NA:'NAM',NP:'NPL',NL:'NLD',NZ:'NZL',
  NI:'NIC',NE:'NER',NG:'NGA',KP:'PRK',NO:'NOR',OM:'OMN',PK:'PAK',PA:'PAN',PY:'PRY',
  PE:'PER',PH:'PHL',PL:'POL',PT:'PRT',PS:'PSE',QA:'QAT',RO:'ROM',RU:'RUS',RW:'RWA',
  SA:'SAU',SN:'SEN',RS:'SRB',SL:'SLE',SG:'SGP',SK:'SVK',SI:'SVN',SO:'SOM',ZA:'ZAF',
  KR:'KOR',SS:'SSD',ES:'ESP',LK:'LKA',SD:'SDN',SE:'SWE',CH:'CHE',SY:'SYR',TW:'TWN',
  TJ:'TJK',TZ:'TZA',TH:'THA',TG:'TGO',TN:'TUN',TR:'TUR',TM:'TKM',UG:'UGA',UA:'UKR',
  AE:'ARE',GB:'GBR',US:'USA',UY:'URY',UZ:'UZB',VE:'VEN',VN:'VNM',YE:'YEM',ZM:'ZMB',ZW:'ZWE',
  SZ:'SWZ',MK:'MKD',AL:'ALB',ME:'MNE',XK:'XKX',
};

function iso2to3(code) {
  return ISO2_TO_ISO3[(code || '').toUpperCase()] || null;
}

// ── 1. GDACS — active disasters GeoJSON ───────────────────────────────────────
// api.gdacs.org blocks GitHub Pages. On Netlify: use fetch-gdacs.js function.
// Fallback: corsproxy.io then allorigins.
var GDACS_URL = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP?eventtypes=EQ,TC,FL,VO,DR,WF&alertlevel=Green,Orange,Red&limit=50';
function fetchGDACS() {
  function parseGDACS(json) {
    // Accept both {data:[...features]} from fetch-gdacs.js and raw GeoJSON
    var features = (json && json.data) || (json && json.features) || [];
    var count = 0;
    features.forEach(function(f) {
      var p   = f.properties || {};
      var geo = f.geometry;
      var iso = iso2to3(p.iso3 || p.country) ||
                (p.countryname ? lookupByName(p.countryname) : null);
      if (!iso) return;

      var sev  = gdacsSev(p.alertlevel);
      var lat  = geo && geo.coordinates ? geo.coordinates[1] : null;
      var lon  = geo && geo.coordinates ? geo.coordinates[0] : null;
      var date = (p.fromdate || '').slice(0, 10);
      var name = p.eventname || (p.eventtype + ' — ' + p.countryname);

      if (!window._rwData[iso]) window._rwData[iso] = { disasters:[], sitreps:[], displaced:null, refugees:null };
      window._rwData[iso].disasters.push({
        name:    name.slice(0, 80),
        types:   [p.eventtype || 'DISASTER'],
        sev:     sev,
        date:    date,
        lat:     lat,
        lon:     lon,
        url:     p.url ? 'https://www.gdacs.org' + p.url : '',
        source:  'GDACS',
      });
      count++;
    });
    console.log('GDACS: ' + count + ' active disasters indexed across ' + Object.keys(window._rwData).length + ' countries');
  }

  var canUseBackend = window.location.protocol !== 'file:';

  if (canUseBackend) {
    // Use Netlify function — server-side, no CORS issues
    return fetch('/.netlify/functions/fetch-gdacs')
      .then(function(r) {
        if (!r.ok) throw new Error('fetch-gdacs HTTP ' + r.status);
        return r.json();
      })
      .then(parseGDACS)
      .catch(function(e) {
        console.warn('GDACS Netlify fetch failed, trying corsproxy:', e.message);
        return fetch('https://corsproxy.io/?url=' + encodeURIComponent(GDACS_URL))
          .then(function(r) { if (!r.ok) throw new Error('corsproxy HTTP ' + r.status); return r.json(); })
          .then(function(json) { if (json) parseGDACS(json); })
          .catch(function(e2) {
            console.warn('GDACS corsproxy failed, trying allorigins:', e2.message);
            return fetch('https://api.allorigins.win/raw?url=' + encodeURIComponent(GDACS_URL))
              .then(function(r) { return r.ok ? r.json() : null; })
              .then(function(json) { if (json) parseGDACS(json); });
          });
      });
  }

  // Fallback for non-Netlify environments: corsproxy.io then allorigins
  return fetch('https://corsproxy.io/?url=' + encodeURIComponent(GDACS_URL))
    .then(function(r) {
      if (!r.ok) throw new Error('GDACS corsproxy HTTP ' + r.status);
      return r.json();
    })
    .then(parseGDACS)
    .catch(function() {
      return fetch('https://api.allorigins.win/raw?url=' + encodeURIComponent(GDACS_URL))
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(json) { if (json) parseGDACS(json); });
    });
}

// Simple name lookup fallback for GDACS countryname field
function lookupByName(name) {
  var map = {
    'United States':'USA','China':'CHN','Russia':'RUS','India':'IND','Brazil':'BRA',
    'Indonesia':'IDN','Pakistan':'PAK','Bangladesh':'BGD','Nigeria':'NGA','Ethiopia':'ETH',
    'Philippines':'PHL','Mexico':'MEX','Egypt':'EGY','Vietnam':'VNM','Iran':'IRN',
    'Turkey':'TUR','Germany':'DEU','Thailand':'THA','United Kingdom':'GBR','France':'FRA',
    'Tanzania':'TZA','South Africa':'ZAF','Myanmar':'MMR','Kenya':'KEN','Colombia':'COL',
    'Spain':'ESP','Ukraine':'UKR','Iraq':'IRQ','Afghanistan':'AFG','Sudan':'SDN',
    'Yemen':'YEM','Somalia':'SOM','Syria':'SYR','Venezuela':'VEN','Mozambique':'MOZ',
    'Papua New Guinea':'PNG','Haiti':'HTI','Peru':'PER','Ecuador':'ECU','Bolivia':'BOL',
    'Chile':'CHL','Argentina':'ARG','Australia':'AUS','Japan':'JPN','South Korea':'KOR',
    'Nepal':'NPL','Sri Lanka':'LKA','Cambodia':'KHM','Laos':'LAO','Mongolia':'MNG',
    'Malawi':'MWI','Zambia':'ZMB','Zimbabwe':'ZWE','Uganda':'UGA','Rwanda':'RWA',
    'Madagascar':'MDG','Ghana':'GHA','Cameroon':'CMR','Ivory Coast':'CIV','Niger':'NER',
    'Mali':'MLI','Burkina Faso':'BFA','Chad':'TCD','Central African Republic':'CAF',
    'DR Congo':'COD','Libya':'LBY','Morocco':'MAR','Algeria':'DZA','Tunisia':'TUN',
    'Jordan':'JOR','Lebanon':'LBN','Palestine':'PSE','Saudi Arabia':'SAU','Qatar':'QAT',
    'UAE':'ARE','Kuwait':'KWT','Oman':'OMN','Kazakhstan':'KAZ','Uzbekistan':'UZB',
  };
  return map[name] || null;
}

// ── 2. UNHCR — displacement figures (unchanged, still works) ─────────────────
function fetchUnhcr() {
  return fetch('https://api.unhcr.org/population/v1/population/?limit=300&dataset=population' +
    '&displayType=totals&columns[]=refugees&columns[]=idps&yearFrom=2023&yearTo=2023&coa_all=true')
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(json) {
      if (!json || !json.items) return;
      json.items.forEach(function(row) {
        var iso  = (row.coa_iso || '').toUpperCase();
        if (!iso) return;
        if (!window._rwData[iso]) window._rwData[iso] = { disasters:[], sitreps:[], displaced:null, refugees:null };
        var refs = parseInt(row.refugees) || 0;
        var idps = parseInt(row.idps)     || 0;
        if (refs > 0) window._rwData[iso].refugees  = refs;
        if (idps > 0) window._rwData[iso].displaced = idps;
      });
      console.log('UNHCR: displacement indexed for ' + json.items.length + ' countries');
    })
    .catch(function(e) { console.warn('UNHCR fetch failed:', e.message); });
}

// ── 3. Plot GDACS disaster markers on globe ───────────────────────────────────
function plotDisasters() {
  var AG = window.ArgusGlobe;
  if (!AG || !AG.eventMarkerGroup || !AG.latLonToVector) return;

  var toRemove = [];
  AG.eventMarkerGroup.children.forEach(function(o) {
    if (o.userData && o.userData._unMarker) toRemove.push(o);
  });
  toRemove.forEach(function(o) { AG.eventMarkerGroup.remove(o); });
  window.eventMarkers = window.eventMarkers.filter(function(m) { return !m.userData._unMarker; });

  var SEV_COL  = { CRITICAL: 0xff0044, WARNING: 0xff9933, WATCH: 0xffcc00 };
  var PLOT_SEV = { CRITICAL: true, WARNING: true };
  var RANK     = { WATCH: 0, WARNING: 1, CRITICAL: 2 };
  var placed   = 0;

  Object.keys(window._rwData).forEach(function(iso) {
    var entry = window._rwData[iso];
    if (!entry.disasters || !entry.disasters.length) return;

    var worst = entry.disasters.reduce(function(a, b) {
      return RANK[b.sev] > RANK[a.sev] ? b : a;
    });
    if (!PLOT_SEV[worst.sev]) return;

    // Prefer exact GDACS lat/lon, fall back to country centroid
    var lat, lon;
    if (worst.lat != null && worst.lon != null) {
      lat = worst.lat; lon = worst.lon;
    } else {
      var cd = window.COUNTRIES_DATA && window.COUNTRIES_DATA.find(function(c) { return c.code === iso; });
      if (!cd) return;
      lat = cd.rawLat; lon = cd.rawLon;
    }

    var pos = AG.latLonToVector(lat, lon, R.DISASTER);
    var col = SEV_COL[worst.sev] || 0xff9933;

    // Octahedron — visually distinct from GDELT spheres
    var mesh = new THREE.Mesh(
      new THREE.OctahedronGeometry(2.1, 0),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.82 })
    );
    mesh.position.copy(pos);
    mesh.rotation.y = Math.PI / 4;
    mesh.userData = {
      _unMarker:    true,
      isUNDisaster: true,
      isCountry:    false,
      type:         worst.types[0] || 'DISASTER',
      severity:     worst.sev,
      title:        (window.COUNTRIES_DATA && window.COUNTRIES_DATA.find(function(c){return c.code===iso;}) || {}).label + ': ' + worst.name,
      impact:       'GDACS active disaster. Alert: ' + worst.sev + '. ' + entry.disasters.length + ' event(s) tracked.' +
                    (entry.displaced ? ' IDPs: ' + Number(entry.displaced).toLocaleString() + '.' : ''),
      source:       'UN GDACS · UNHCR',
      countryCode:  iso,
    };
    AG.eventMarkerGroup.add(mesh);
    window.eventMarkers.push(mesh);

    var outline = new THREE.Mesh(
      new THREE.OctahedronGeometry(2.6, 0),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.22, wireframe: true })
    );
    outline.position.copy(pos);
    outline.rotation.y = Math.PI / 4;
    outline.userData = { _unMarker: true };
    AG.eventMarkerGroup.add(outline);

    var ring = new THREE.Mesh(
      new THREE.RingGeometry(2.4, 3.6, 32),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.32, side: THREE.DoubleSide })
    );
    ring.position.copy(pos);
    ring.lookAt(pos.clone().normalize().multiplyScalar(200));
    ring.userData = { isPulseRing: true, phase: Math.random() * Math.PI * 2, _unMarker: true };
    AG.eventMarkerGroup.add(ring);
    if (window._pulseRings) window._pulseRings.push(ring);

    placed++;
  });

  if (typeof window.updateNodeCounts === 'function') window.updateNodeCounts();
  console.log('GDACS: placed', placed, 'disaster markers on globe');
}

// ── 4. Init ───────────────────────────────────────────────────────────────────
function init() {
  try {
    var cached = localStorage.getItem(CACHE_KEY);
    var ts     = parseInt(localStorage.getItem(CACHE_TS) || '0');
    if (cached && Date.now() - ts < TTL) {
      window._rwData = JSON.parse(cached);
      // 'GDACS/UNHCR: from cache —', Object.keys(window._rwData).length, 'countries');
      setTimeout(plotDisasters, 2000);
      return;
    }
  } catch(e) {}

  var delay = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };

  delay(5000)
    .then(function() { return fetchGDACS(); })
    .then(function() { return delay(1500); })
    .then(function() { return fetchUnhcr(); })
    .then(function() {
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(window._rwData));
        localStorage.setItem(CACHE_TS,  String(Date.now()));
      } catch(e) {}
      plotDisasters();
      console.log('GDACS/UNHCR: complete —', Object.keys(window._rwData).length, 'countries');
    })
    .catch(function(e) { console.warn('GDACS init error:', e.message); });
}

function getCountryData(iso3) { return window._rwData[iso3] || null; }
function getDisasters()       { return window._rwData; }

init();

return { getCountryData: getCountryData, getDisasters: getDisasters };

})(); // end ArgusRW
