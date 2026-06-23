/**
 * Klorn desktop shell — Electron main process.
 *
 * v0.1 is a thin frame plus the first real native surface: it renders the Klorn
 * web app in one window and opens a read-only Brain Inspector (Cmd/Ctrl+B) that
 * shows the shared ontology the firewall classifies on. The shell is the seam
 * where the personal command center grows: the firewall now, Ripple / AutoView
 * later, all reading the same deterministic core.
 *
 * Electron is the chosen runtime over Tauri to keep the repo's locked
 * "TypeScript only" stack — no Rust toolchain (CLAUDE.md).
 */

import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  shell,
} from "electron";
import {
  isInternalUrl,
  isSafeExternalUrl,
  KLORN_API_URL,
  KLORN_AUTH_TOKEN_KEY,
  KLORN_WEB_URL,
} from "./config.js";

let mainWindow: BrowserWindow | null = null;
let inspectorWindow: BrowserWindow | null = null;

/** Hand a link to the OS browser only if it's a safe http(s) URL. */
function openExternalSafely(url: string): void {
  if (isSafeExternalUrl(url)) void shell.openExternal(url);
}

/**
 * Read the web app's JWT out of the main window's localStorage. The token lives
 * only in the renderer, so we ask the page for it; the value never leaves the
 * main process except as an Authorization header on the ontology request.
 */
async function readAuthToken(win: BrowserWindow): Promise<string | null> {
  try {
    const token = await win.webContents.executeJavaScript(
      `window.localStorage.getItem(${JSON.stringify(KLORN_AUTH_TOKEN_KEY)})`,
    );
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

type OntologyResult = { ok: true; data: unknown } | { ok: false; error: string };

/** Fetch the ontology snapshot with the main window's Bearer token. */
async function fetchOntology(): Promise<OntologyResult> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, error: "The Klorn window is not open." };
  }
  const token = await readAuthToken(mainWindow);
  try {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${KLORN_API_URL}/api/admin/ontology`, { headers });
    if (!res.ok) {
      const hint = token
        ? `${res.status} ${res.statusText}`
        : `not signed in (${res.status}). Log in to the Klorn window first.`;
      return { ok: false, error: hint };
    }
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function openInspector(): void {
  if (inspectorWindow && !inspectorWindow.isDestroyed()) {
    inspectorWindow.focus();
    return;
  }
  inspectorWindow = new BrowserWindow({
    width: 560,
    height: 720,
    title: "Klorn — Brain Inspector",
    backgroundColor: "#0b0b0f",
    webPreferences: {
      preload: fileURLToPath(new URL("inspector-preload.js", import.meta.url)),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  void inspectorWindow.loadFile(fileURLToPath(new URL("inspector.html", import.meta.url)));

  // The inspector is a fixed local page. Deny every window-open (route safe
  // links to the OS browser) and block all top-level navigation away from it,
  // matching the main window's hardening.
  inspectorWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: "deny" };
  });
  inspectorWindow.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });

  inspectorWindow.on("closed", () => {
    inspectorWindow = null;
  });
}

function buildMenu(): void {
  const isMac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Brain Inspector", accelerator: "CmdOrCtrl+B", click: () => openInspector() },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
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
      // fetch + localStorage (no Node API), so it is fully sandbox-compatible.
      // The API base is passed in via additionalArguments because process.env is
      // unavailable in a sandboxed preload.
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: [`--klorn-api-url=${KLORN_API_URL}`],
    },
  });

  void mainWindow.loadURL(KLORN_WEB_URL);

  // The shell renders exactly one web app: deny every window-open, and only the
  // safe-external ones get handed to the OS browser (file:/javascript:/data:
  // are dropped by isSafeExternalUrl).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isInternalUrl(url)) openExternalSafely(url);
    return { action: "deny" };
  });

  // Keep top-level navigation inside the app's own origin; send safe links out.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isInternalUrl(url)) {
      event.preventDefault();
      openExternalSafely(url);
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

void app.whenReady().then(() => {
  ipcMain.handle("klorn:ontology", (event): OntologyResult | Promise<OntologyResult> => {
    // Only the inspector window may request the ontology: the request triggers a
    // Bearer-authenticated fetch, so it must not be reachable from the web-app
    // renderer (defense-in-depth alongside contextIsolation + sandbox).
    if (!inspectorWindow || event.sender !== inspectorWindow.webContents) {
      return { ok: false, error: "Unauthorized." };
    }
    return fetchOntology();
  });
  buildMenu();
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
