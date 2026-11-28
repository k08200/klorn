// Android hardware/gesture back in the Capacitor shell, as a pure decision
// (parity with apps/mobile/src/router/back.ts): close the open sheet or
// dialog → go back in history → go home when a deep link opened a page with
// no history → at a root page, leave the app (minimize, Android convention).
// Import-free so packages/api can test it.

export type BackAction =
  | { kind: "closeDialog" }
  | { kind: "historyBack" }
  | { kind: "home" }
  | { kind: "exit" };

export interface BackState {
  /** A modal sheet or dialog is open (it closes on Escape). */
  dialogOpen: boolean;
  pathname: string;
  /** The WebView has an entry to go back to (Capacitor's backButton event). */
  canGoBack: boolean;
}

/** Pages back leaves the app from: the homes and the signed-out entry. */
const ROOT_PATHS: ReadonlySet<string> = new Set(["/", "/today", "/email", "/inbox", "/login"]);

export function isRootPath(pathname: string): boolean {
  const clean = pathname.replace(/\/+$/, "") || "/";
  return ROOT_PATHS.has(clean);
}

export function decideBack(state: BackState): BackAction {
  if (state.dialogOpen) return { kind: "closeDialog" };
  if (isRootPath(state.pathname)) return { kind: "exit" };
  return state.canGoBack ? { kind: "historyBack" } : { kind: "home" };
}
