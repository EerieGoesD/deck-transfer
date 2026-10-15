import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { IS_MAC } from "./utils";

document.addEventListener("contextmenu", (e) => e.preventDefault());

// Mac: entering full screen can leave the newly exposed area unpainted (white)
// until something forces a redraw. Force that redraw whenever the window size
// changes.
if (IS_MAC) {
  let repaintQueued = false;
  window.addEventListener("resize", () => {
    if (repaintQueued) return;
    repaintQueued = true;
    requestAnimationFrame(() => {
      const root = document.getElementById("root");
      if (root) {
        root.style.display = "none";
        void root.offsetHeight;
        root.style.display = "";
      }
      repaintQueued = false;
    });
  });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
