// Posts the Windows desktop shell's OS banners. Which frames banner, and the
// once-per-id dedupe, are decided by the pure rules in ./desktop-alerts.ts;
// this file is only the side-effecting edge: session storage and the IPC call.
//
// The shell exposes exactly one command for this, `show_banner` (title + body,
// clamped and posted from Rust, permission handled there) — none of the
// notification plugin's commands are granted to app.klorn.ai. See
// apps/desktop-win/src-tauri/src/banner.rs and capabilities/default.json.

import { captureClientError } from "../sentry";
import { parseSeenIds, planDesktopAlert } from "./desktop-alerts";
import { shellKind, tauriInvoke } from "./shell";

const SEEN_KEY = "klorn.desktopAlerts.seen";

function readSeen(): string[] {
  try {
    return parseSeenIds(window.sessionStorage.getItem(SEEN_KEY));
  } catch {
    return []; // storage blocked: fall back to no memory, never to no banner
  }
}

function writeSeen(seen: readonly string[]): void {
  try {
    window.sessionStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch (err) {
    console.warn("[DESKTOP-ALERT] could not persist seen ids:", err);
  }
}

/** Banner one real-time notification frame if it is a server-tagged PUSH /
 *  meeting interrupt not yet bannered this session. No-op outside Tauri. */
export async function deliverDesktopAlert(payload: unknown): Promise<void> {
  if (shellKind() !== "tauri") return;
  const plan = planDesktopAlert(readSeen(), payload);
  if (!plan.alert) return;
  // Record before posting: a slow or failed IPC call must not repeat the banner.
  writeSeen(plan.seen);
  try {
    await tauriInvoke("show_banner", { title: plan.alert.title, body: plan.alert.body });
  } catch (err) {
    console.error("[DESKTOP-ALERT] banner failed:", err);
    captureClientError(err, { context: "tauri-notify.deliverDesktopAlert", kind: plan.alert.kind });
  }
}
