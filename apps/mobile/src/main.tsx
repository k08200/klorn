import { onlineManager } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createQueryClient } from "./api/query-client";
import { App } from "./app/App";
import { initServices } from "./app/services";
import { MOCK_API } from "./config";
import { prepareI18n } from "./i18n/I18nProvider";
import { platformName } from "./platform/native";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/shared.css";

const root = document.documentElement;
root.classList.add(`platform-${platformName()}`);

/** Flag large OS text (≥125%) so single-line rows may wrap (Dynamic Type up to 200%). */
function flagLargeText() {
  const base = Number.parseFloat(getComputedStyle(root).fontSize) || 16;
  const reference = root.classList.contains("platform-ios") ? 17 : 16;
  root.toggleAttribute("data-large-text", base / reference >= 1.25);
}
flagLargeText();

/**
 * Mock/dev only: `?insets=top,right,bottom,left` fakes the device's safe-area
 * insets (status bar, home indicator) so browser screenshots match a phone.
 */
function simulateInsets() {
  if (!(MOCK_API || import.meta.env.DEV)) return;
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("insets");
    if (fromUrl) window.sessionStorage.setItem("klorn-sim-insets", fromUrl);
    const spec = window.sessionStorage.getItem("klorn-sim-insets");
    const values = spec?.split(",").map(Number) ?? [];
    if (values.length !== 4 || values.some((v) => !Number.isFinite(v) || v < 0)) return;
    ["top", "right", "bottom", "left"].forEach((side, i) => {
      root.style.setProperty(`--safe-area-inset-${side}`, `${values[i]}px`);
    });
  } catch {
    // sessionStorage unavailable — no simulation.
  }
}
simulateInsets();
window.addEventListener("resize", flagLargeText);

// TanStack starts "online" and only learns from online/offline events; a cold
// start in airplane mode fires none, so seed it from the OS once.
if (typeof navigator !== "undefined" && navigator.onLine === false) onlineManager.setOnline(false);

const container = document.getElementById("root");
if (!container) throw new Error("#root missing");
const reactRoot = createRoot(container);
// The boot surface (under the native splash) while the session and the active
// language's catalog load — the first real frame is already translated.
reactRoot.render(<div className="boot" aria-busy="true" />);

void Promise.all([initServices(), prepareI18n()]).then(([, i18n]) => {
  reactRoot.render(
    <StrictMode>
      <App queryClient={createQueryClient()} initialLocale={i18n.override} />
    </StrictMode>,
  );
});
