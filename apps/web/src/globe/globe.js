import * as THREE from "three";
import Globe from "three-globe";

export function initGlobe(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const W = container.clientWidth  || window.innerWidth;
  const H = container.clientHeight || window.innerHeight;

  const scene    = new THREE.Scene();
  const camera   = new THREE.PerspectiveCamera(60, W / H, 0.1, 10000);
  camera.position.z = 300;   // three-globe earth radius is ~100

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(W, H);
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);

  // Globe
  const globe = new Globe()
    .globeImageUrl('//unpkg.com/three-globe/example/img/earth-blue-marble.jpg');
  scene.add(globe);

  // Basic lighting so the globe texture is visible
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 0.8);
  sun.position.set(5, 3, 5);
  scene.add(sun);

  // Resize handler
  window.addEventListener('resize', () => {
    const w = container.clientWidth  || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });

  function animate() {
    requestAnimationFrame(animate);
    globe.rotation.y += 0.001;   // slow auto-spin
    renderer.render(scene, camera);
  }

  animate();
}
