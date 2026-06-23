/**
 * Klorn desktop shell — Electron main process.
 *
 * v0 is deliberately a thin frame: it renders the Klorn web app in a native
 * window and routes external links to the system browser. The point of the
 * shell is not chrome — it is the seam where the personal command center grows:
 * one local window that holds the firewall now, and Ripple / AutoView later,
 * all reading the same shared ontology (see preload.ts → window.klorn).
 *
 * Electron is the chosen runtime over Tauri to keep the repo's locked
 * "TypeScript only" stack — no Rust toolchain (CLAUDE.md).
 */

import { fileURLToPath } from "node:url";
import { app, BrowserWindow, shell } from "electron";
import { isInternalUrl, isSafeExternalUrl, KLORN_API_URL, KLORN_WEB_URL } from "./config.js";

/** Hand a link to the OS browser only if it's a safe http(s) URL. */
function openExternalSafely(url: string): void {
  if (isSafeExternalUrl(url)) void shell.openExternal(url);
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    title: "Klorn",
    backgroundColor: "#0b0b0f",
    webPreferences: {
      preload: fileURLToPath(new URL("preload.js", import.meta.url)),
      contextIsolation: true,
      // OS-level renderer sandbox ON. The preload uses only contextBridge +
      // fetch (no Node API), so it is fully sandbox-compatible. The API base is
      // passed in via additionalArguments because process.env is unavailable in
      // a sandboxed preload.
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: [`--klorn-api-url=${KLORN_API_URL}`],
    },
  });

  void win.loadURL(KLORN_WEB_URL);

  // The shell renders exactly one web app: deny every window-open, and only the
  // safe-external ones get handed to the OS browser (file:/javascript:/data:
  // are dropped by isSafeExternalUrl).
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isInternalUrl(url)) openExternalSafely(url);
    return { action: "deny" };
  });

  // Keep top-level navigation inside the app's own origin; send safe links out.
  win.webContents.on("will-navigate", (event, url) => {
    if (!isInternalUrl(url)) {
      event.preventDefault();
      openExternalSafely(url);
    }
  });
}

void app.whenReady().then(() => {
  createWindow();
  // macOS: re-open a window when the dock icon is clicked and none are open.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit when all windows are closed, except on macOS where apps stay live.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
