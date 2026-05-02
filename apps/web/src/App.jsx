import { useEffect, useRef } from "react";
import { initGlobe } from "./globe/globe";

function App() {
  const cleanupRef = useRef(null);

  useEffect(() => {
    console.log("CALLING INIT GLOBE");
    const cleanup = initGlobe("globe-container");
    if (cleanup) cleanupRef.current = cleanup;

    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
    };
  }, []);

  return (
    <div
      id="globe-container"
      style={{ width: "100vw", height: "100vh", overflow: "hidden" }}
    />
  );
}

export default App;
