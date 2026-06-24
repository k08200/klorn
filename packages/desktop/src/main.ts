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
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  shell,
} from "electron";
import {
  isGoogleLoginStart,
  isInternalUrl,
  isSafeExternalUrl,
  KLORN_API_URL,
  KLORN_AUTH_TOKEN_KEY,
  KLORN_WEB_URL,
} from "./config.js";
import { type DesktopLoginFailureReason, runDesktopGoogleLogin } from "./desktop-login.js";

let mainWindow: BrowserWindow | null = null;
let inspectorWindow: BrowserWindow | null = null;
/** One sign-in flow at a time — the browser-bounce poll runs for minutes. */
let googleLoginInFlight = false;

/** Hand a link to the OS browser only if it's a safe http(s) URL. */
function openExternalSafely(url: string): void {
  if (isSafeExternalUrl(url)) void shell.openExternal(url);
}

/** Inject the freshly minted JWT into the web app and reload so it boots signed in. */
async function applyDesktopToken(win: BrowserWindow, token: string): Promise<void> {
  // JSON.stringify both args so the token (server-signed, but still untrusted as
  // a string) can never break out of the localStorage.setItem call.
  await win.webContents.executeJavaScript(
    `window.localStorage.setItem(${JSON.stringify(KLORN_AUTH_TOKEN_KEY)}, ${JSON.stringify(token)})`,
  );
  win.reload();
}

const LOGIN_FAILURE_DETAIL: Record<DesktopLoginFailureReason, string> = {
  nonce_failed:
    "Could not reach Klorn to start sign-in. Check that the API is running, then try again.",
  invalid_nonce: "The sign-in session was not recognized. Please try again.",
  expired: "Sign-in took too long and expired. Please try again.",
  timeout: "Timed out waiting for the browser. Finish sign-in there, then try again.",
  // Present only to satisfy the exhaustive Record — reportLoginFailure returns
  // early for "cancelled" (user-initiated) and never shows this string.
  cancelled: "Sign-in was cancelled.",
};

/** Surface a terminal sign-in failure. Cancellation is user-initiated, so it stays silent. */
function reportLoginFailure(reason: DesktopLoginFailureReason, detail: string): void {
  console.warn(`[desktop] sign-in failed (${reason}): ${detail}`);
  if (reason === "cancelled") return;
  void dialog.showMessageBox({
    type: "warning",
    title: "Klorn sign-in",
    message: "Google sign-in did not complete",
    detail: LOGIN_FAILURE_DETAIL[reason],
    buttons: ["OK"],
  });
}

/**
 * Native Google sign-in: open the system browser for consent, poll the server
 * for the parked JWT, then sign the web window in and reload. One consent also
 * grants Gmail/Calendar, so the account lands already connected. Single-flight.
 */
async function startDesktopGoogleLogin(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (googleLoginInFlight) {
    mainWindow.focus();
    return;
  }
  googleLoginInFlight = true;
  const win = mainWindow;
  try {
    const result = await runDesktopGoogleLogin({
      apiBase: KLORN_API_URL,
      fetchFn: fetch,
      openExternal: openExternalSafely,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      log: (message) => console.log(message),
      isCancelled: () => win.isDestroyed(),
    });
    if (result.ok) {
      if (!win.isDestroyed()) await applyDesktopToken(win, result.token);
      return;
    }
    reportLoginFailure(result.reason, result.detail);
  } catch (err) {
    // Defensive: runDesktopGoogleLogin never throws, but token injection might.
    console.error("[desktop] sign-in crashed:", err);
  } finally {
    googleLoginInFlight = false;
  }
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
      label: "Account",
      submenu: [
        {
          label: "Sign in with Google",
          click: () => void startDesktopGoogleLogin(),
        },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Brain Inspector", accelerator: "CmdOrCtrl+B", click: () => openInspector() },
        { type: "separator" },
        { role: "reload" },
        // DevTools only in dev: a packaged build must not expose the renderer's
        // localStorage (which holds the klorn-token JWT) to an end user.
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools" as const }]),
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

  // Default landing path is overridable (KLORN_DESKTOP_PATH) so the shell can
  // open straight on a surface — e.g. /admin/ontology to inspect the brain —
  // without depending on in-window navigation.
  void mainWindow.loadURL(`${KLORN_WEB_URL}${process.env.KLORN_DESKTOP_PATH || ""}`);

  // The shell renders exactly one web app: deny every window-open, and only the
  // safe-external ones get handed to the OS browser (file:/javascript:/data:
  // are dropped by isSafeExternalUrl).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isInternalUrl(url)) openExternalSafely(url);
    return { action: "deny" };
  });

  // Keep top-level navigation inside the app's own origin; send safe links out.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    // The web "Sign in with Google" button navigates to the API's login start
    // (cross-origin to the shell). Intercept it and run the native flow instead
    // of bouncing a half-flow to the OS browser where the JWT would never return.
    if (isGoogleLoginStart(url)) {
      event.preventDefault();
      void startDesktopGoogleLogin();
      return;
    }
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
  // Web app → native Google sign-in. Only the main window may trigger it; the
  // flow itself opens the OS browser and reloads this window on success, so the
  // renderer needs nothing back (fire-and-forget).
  ipcMain.handle("klorn:google-login", (event): void => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    void startDesktopGoogleLogin();
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
