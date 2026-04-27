import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import "./index.css";
import App from "./App";

// Dev-only: expose invoke on window so we can run one-off commands from
// devtools (e.g. saving auxiliary API keys that don't have a Settings UI yet).
// Example:
//   await invoke("save_api_key", { providerId: "tavily", apiKey: "tvly-..." })
if (import.meta.env.DEV) {
  (window as unknown as { invoke: typeof invoke }).invoke = invoke;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
