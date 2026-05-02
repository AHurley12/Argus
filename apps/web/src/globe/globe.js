export function initGlobe(containerId) {
  console.log("INIT GLOBE CALLED");

  const container = document.getElementById(containerId);
  console.log("CONTAINER:", container);

  if (!container) {
    console.error("NO CONTAINER for id:", containerId);
    return;
  }

  const canvas = document.createElement("canvas");
  canvas.id = "argus-test-canvas";
  canvas.style.cssText = "position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:999999;background:red;";

  container.appendChild(canvas);

  console.log("CANVAS APPENDED");
  console.log("VERIFY:", document.querySelector("#argus-test-canvas"));
}
