import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { IS_MAC } from "./utils";
import { invoke } from "@tauri-apps/api/core";

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

// The browser's own right-click menu is kept where it is useful, which is
// anywhere words can be typed or selected: there it offers cut, copy, paste and
// select all. Everywhere else it only offered Reload and the like, so it is
// blocked. `tauri dev` keeps it everywhere, for Inspect. The app's own menus
// (Deck files, finder results) block it themselves.
let devBuild = false;
invoke<boolean>("dev_build").then((v) => { devBuild = v === true; }).catch(() => {});
document.addEventListener("contextmenu", (e) => {
  if (devBuild) return;
  if ((e.target as Element | null)?.closest?.("input, textarea, [contenteditable='true']")) return;
  if (String(window.getSelection())) return;
  e.preventDefault();
});
