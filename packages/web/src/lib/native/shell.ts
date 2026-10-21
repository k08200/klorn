// Shell detection for the web app running inside a native wrapper.
//
// Two shells exist: the Capacitor mobile app (window.Capacitor) and the Tauri
// desktop wrapper (window.__TAURI_INTERNALS__, injected by Tauri v2's IPC
// bootstrap). Google blocks OAuth inside embedded webviews (RFC 8252
// disallowed_useragent), so anything auth-shaped must ask "am I in a shell?"
// through here rather than testing window.Capacitor directly — that test
// silently answers "no" inside Tauri and lets the login proceed into the
// webview, where Google rejects it.
//
// Detection is a pure function over an injected globals bag so the logic is
// verifiable without a browser; runtime callers use the zero-argument wrappers.

export type ShellKind = "capacitor" | "tauri" | null;

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
}

interface TauriInternals {
  invoke?: (cmd: string, args?: unknown) => Promise<unknown>;
}

export interface ShellGlobals {
  Capacitor?: CapacitorGlobal;
  __TAURI_INTERNALS__?: TauriInternals;
}

function globalsBag(): ShellGlobals | undefined {
  if (typeof window === "undefined") return undefined;
  return window as unknown as ShellGlobals;
}

/** Pure detector. Capacitor wins when both are present: it means the page is
 *  inside the mobile shell and some script also injected a Tauri stub. */
export function detectShell(g: ShellGlobals | undefined): ShellKind {
  if (!g) return null;
  if (g.Capacitor?.isNativePlatform?.()) return "capacitor";
  if (g.__TAURI_INTERNALS__) return "tauri";
  return null;
}

export function shellKind(): ShellKind {
  return detectShell(globalsBag());
}

/** True inside any native wrapper — mobile shell or desktop wrapper. */
export function isNativeShell(): boolean {
  return shellKind() !== null;
}

/** Open a URL in the SYSTEM browser, whatever the shell. On the plain web this
 *  is a normal new-tab open; the popup-blocker caveat there is acceptable
 *  because the web login flow never calls this. */
export async function openExternal(url: string): Promise<void> {
  const kind = shellKind();
  if (kind === "capacitor") {
    const { Browser } = await import("@capacitor/browser");
    await Browser.open({ url });
    return;
  }
  if (kind === "tauri") {
    // The web bundle cannot import @tauri-apps/* (not a dependency, and only
    // meaningful inside the wrapper), so this goes through the IPC global the
    // wrapper injects. Command shape is the opener plugin's stable v2 surface.
    await globalsBag()?.__TAURI_INTERNALS__?.invoke?.("plugin:opener|open_url", {
      url,
    });
    return;
  }
  window.open(url, "_blank", "noopener");
}

/** Call a Tauri command through the IPC global the desktop wrapper injects.
 *  The web bundle cannot import @tauri-apps/* (see openExternal), so plugin
 *  commands go through here. Rejects outside the Tauri shell. What a command
 *  may do is bounded by the wrapper's capability file
 *  (apps/desktop-win/src-tauri/capabilities/default.json), not by this call. */
export async function tauriInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const invoke = globalsBag()?.__TAURI_INTERNALS__?.invoke;
  if (shellKind() !== "tauri" || !invoke) throw new Error("not inside the Tauri shell");
  return invoke(cmd, args);
}

/** Close the in-app browser sheet where one exists. Capacitor's Browser.open
 *  presents a sheet that must be dismissed after auth; Tauri's opener hands
 *  off to the real default browser, which is not ours to close. */
export async function closeExternal(): Promise<void> {
  if (shellKind() !== "capacitor") return;
  const { Browser } = await import("@capacitor/browser");
  await Browser.close();
}
