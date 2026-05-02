import * as THREE from "three";
import Globe from "three-globe";

export function initGlobe(containerId) {
  console.log("INIT GLOBE FIRED");

  const container = document.getElementById(containerId);
  console.log("Container:", container);

  if (!container) {
    console.error("No container found for id:", containerId);
    return null;
  }

  console.log("WIDTH/HEIGHT:", container.clientWidth, container.clientHeight);

  const W = container.clientWidth  || window.innerWidth;
  const H = container.clientHeight || window.innerHeight;

  const scene  = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 10000);
  camera.position.z = 300;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(W, H);
  renderer.setPixelRatio(window.devicePixelRatio);

  console.log("Appending renderer canvas");
  container.appendChild(renderer.domElement);

  const globe = new Globe()
    .globeImageUrl("//unpkg.com/three-globe/example/img/earth-blue-marble.jpg");
  scene.add(globe);

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 0.8);
  sun.position.set(5, 3, 5);
  scene.add(sun);

  const onResize = () => {
    const w = container.clientWidth  || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
  window.addEventListener("resize", onResize);

  let animId;
  function animate() {
    animId = requestAnimationFrame(animate);
    globe.rotation.y += 0.001;
    renderer.render(scene, camera);
  }
  animate();

  // Return cleanup so React can destroy on unmount / StrictMode re-run
  return function cleanup() {
    cancelAnimationFrame(animId);
    window.removeEventListener("resize", onResize);
    renderer.dispose();
    if (container.contains(renderer.domElement)) {
      container.removeChild(renderer.domElement);
    }
  };
}
