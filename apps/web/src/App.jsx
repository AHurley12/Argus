import { useEffect } from "react";
import { initGlobe } from "./globe/globe";
function App() {
  useEffect(() => {
    initGlobe("globe-container");
  }, []);

  return (
    <div
      id="globe-container"
      style={{
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
      }}
    />
  );
}

export default App;