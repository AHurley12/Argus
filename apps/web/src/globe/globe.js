import * as THREE from "three";
import Globe from "three-globe";

// 20 centers × 500ms stagger = 10s spread per cycle.
// 150s poll interval = 8 req/min — same rate as prior 16-center/120s config, safely under adsb.fi's ~10-12/min limit.
// First poll delayed 8s to avoid colliding with the diagnostic harness on load.
var POLL_MS          = 150000;
var INITIAL_DELAY_MS = 8000;
var STAGGER_MS       = 500;

var CENTERS = [
  { label: 'US East',        lat:  40, lon:  -75 },
  { label: 'US Central',     lat:  37, lon: -100 },
  { label: 'Europe',         lat:  50, lon:   10 },
  { label: 'Middle East',    lat:  25, lon:   55 },
  { label: 'East Asia',      lat:  35, lon:  125 },
  { label: 'Japan East',     lat:  40, lon:  142 },
  { label: 'South US',       lat:  30, lon:  -85 },
  { label: 'Northwest US',   lat:  47, lon: -122 },
  { label: 'SE Asia',        lat:  15, lon:  100 },
  { label: 'India',          lat:  20, lon:   80 },
  { label: 'Australia SE',   lat: -34, lon:  151 },  // Sydney
  { label: 'Brazil',         lat: -23, lon:  -46 },  // Sao Paulo
  { label: 'Moscow',         lat:  55, lon:   37 },
  { label: 'Caribbean',      lat:  20, lon:  -72 },
  { label: 'Southern Africa',lat: -26, lon:   28 },  // Johannesburg
  { label: 'East Africa',    lat:   0, lon:   37 },  // Nairobi
  { label: 'North Africa',   lat:  28, lon:   18 },  // Algiers — covers Maghreb + Sahara air routes, gap between Europe and sub-Saharan centers
  { label: 'Central Asia',   lat:  42, lon:   62 },  // Kazakhstan — Silk Road corridor, gap between Moscow and India centers
  { label: 'Argentina',      lat: -35, lon:  -65 },  // Buenos Aires — Southern Cone, no prior coverage
  { label: 'Indonesia East', lat:  -3, lon:  130 },  // Papua / Banda Sea — eastern archipelago, gap beyond SE Asia center
];

function wait(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function fetchRegion(center) {
  var url = '/adsb/api/v2/lat/' + center.lat + '/lon/' + center.lon + '/dist/249';
  console.log('[ADSB FETCH]', center.label, '->', url);

  return fetch(url, { headers: { Accept: 'application/json' } })
    .then(function(resp) {
      console.log('[ADSB STATUS]', center.label, resp.status);

      var ct = resp.headers.get('content-type') || '';

      if (!ct.includes('application/json')) {
        return resp.text().then(function(text) {
          console.error('[ADSB INVALID RESPONSE]', center.label, text.slice(0, 300));
          return [];
        });
      }

      if (!resp.ok) return [];

      return resp.json()
        .then(function(d) {
          console.log('[ADSB JSON OK]', center.label);
          if (!d || !Array.isArray(d.aircraft)) return [];
          console.log('[ADSB AIRCRAFT COUNT]', center.label, d.aircraft.length);
          return d.aircraft;
        })
        .catch(function(err) {
          console.error('[ADSB JSON PARSE ERROR]', center.label, err.message);
          return [];
        });
    })
    .catch(function(err) {
      console.error('[ADSB FETCH ERROR]', center.label, err.message);
      return [];
    });
}

function fetchAllAircraft() {
  // Stagger each region by STAGGER_MS to avoid simultaneous burst to adsb.fi
  var staggered = CENTERS.map(function(center, i) {
    return wait(i * STAGGER_MS).then(function() { return fetchRegion(center); });
  });

  return Promise.allSettled(staggered).then(function(results) {
    var seen   = {};
    var merged = [];
    results.forEach(function(r) {
      if (r.status !== 'fulfilled') return;
      r.value.forEach(function(ac) {
        if (!ac || !ac.hex || ac.lat == null || ac.lon == null) return;
        if (seen[ac.hex]) return;
        seen[ac.hex] = true;
        merged.push(ac);
      });
    });
    return merged;
  });
}

export function initGlobe(containerId) {
  var container = document.getElementById(containerId);
  if (!container) return null;

  var W = container.clientWidth  || window.innerWidth;
  var H = container.clientHeight || window.innerHeight;

  var scene  = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 10000);
  camera.position.z = 300;

  var renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(W, H);
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);

  var globe = new Globe()
    .globeImageUrl('//unpkg.com/three-globe/example/img/earth-blue-marble.jpg')
    .pointsData([])
    .pointLat(function(d) { return d.lat; })
    .pointLng(function(d) { return d.lon; })
    .pointColor(function() { return '#00ff88'; })
    .pointAltitude(0.005)
    .pointRadius(0.25);

  scene.add(globe);
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));

  var sun = new THREE.DirectionalLight(0xffffff, 0.8);
  sun.position.set(5, 3, 5);
  scene.add(sun);

  function onResize() {
    var w = container.clientWidth  || window.innerWidth;
    var h = container.clientHeight || window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  window.addEventListener('resize', onResize);

  function poll() {
    fetchAllAircraft().then(function(aircraft) {
      globe.pointsData(aircraft);
      console.log('[ADSB TOTAL UNIQUE]', aircraft.length, 'aircraft rendered');
    });
  }

  // Delay first poll so it does not collide with the diagnostic harness on load
  var pollTimer = null;
  setTimeout(function() {
    poll();
    pollTimer = setInterval(poll, POLL_MS);
  }, INITIAL_DELAY_MS);

  var animId;
  function animate() {
    animId = requestAnimationFrame(animate);
    globe.rotation.y += 0.001;
    renderer.render(scene, camera);
  }
  animate();

  return function cleanup() {
    cancelAnimationFrame(animId);
    if (pollTimer) clearInterval(pollTimer);
    window.removeEventListener('resize', onResize);
    renderer.dispose();
    if (container.contains(renderer.domElement)) {
      container.removeChild(renderer.domElement);
    }
  };
}
