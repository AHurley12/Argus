import * as THREE from "three";
import Globe from "three-globe";

const POLL_MS = 15000;

// 5 centers at ~249nm radius cover global high-traffic airspace with minimal overlap
var CENTERS = [
  { lat: 40,  lon: -75  },  // US East
  { lat: 37,  lon: -100 },  // US Central/West
  { lat: 50,  lon:  10  },  // Europe
  { lat: 25,  lon:  55  },  // Middle East / South Asia
  { lat: 35,  lon: 125  },  // East Asia / Pacific
];

function fetchRegion(center) {
  return fetch('/adsb/api/v2/lat/' + center.lat + '/lon/' + center.lon + '/dist/249', {
    headers: { Accept: 'application/json' },
  })
    .then(function(resp) {
      if (!resp.ok) return [];
      return resp.json().then(function(d) {
        return Array.isArray(d.aircraft) ? d.aircraft : [];
      });
    })
    .catch(function() { return []; });
}

function fetchAllAircraft() {
  return Promise.allSettled(CENTERS.map(fetchRegion)).then(function(results) {
    var seen    = {};
    var merged  = [];
    results.forEach(function(r) {
      if (r.status !== 'fulfilled') return;
      r.value.forEach(function(ac) {
        if (!ac.hex || ac.lat == null || ac.lon == null) return;
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
      console.log('[globe] aircraft rendered:', aircraft.length);
    });
  }

  poll();
  var pollTimer = setInterval(poll, POLL_MS);

  var animId;
  function animate() {
    animId = requestAnimationFrame(animate);
    globe.rotation.y += 0.001;
    renderer.render(scene, camera);
  }
  animate();

  return function cleanup() {
    cancelAnimationFrame(animId);
    clearInterval(pollTimer);
    window.removeEventListener('resize', onResize);
    renderer.dispose();
    if (container.contains(renderer.domElement)) {
      container.removeChild(renderer.domElement);
    }
  };
}
