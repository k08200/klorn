// Posts the Windows desktop shell's OS banners. Which frames and bell rows
// banner, and the once-per-id ledger, are decided by the pure rules in
// ./desktop-alerts.ts and ./desktop-catchup.ts; this file is only the
// side-effecting edge: local storage, the preference fetch and the IPC call.
//
// The shell exposes exactly one command for this, `show_banner` (title + body,
// clamped and posted from Rust, permission handled there) — none of the
// notification plugin's commands are granted to app.klorn.ai. See
// apps/desktop-win/src-tauri/src/banner.rs and capabilities/default.json.

import type { DesktopAlertKind } from "@klorn/contract";
import { apiFetch } from "../api";
import { captureClientError } from "../sentry";
import type { DesktopAlert } from "./desktop-alerts";
import {
  ALL_ALERT_KINDS,
  type AlertLedger,
  allowedKindsFromConfig,
  parseLedger,
  planCatchUp,
  planLiveAlert,
  resolveLedger,
} from "./desktop-catchup";
import { shellKind, tauriInvoke } from "./shell";

/** localStorage, not sessionStorage: the ledger must survive a restart so a
 *  relaunch neither repeats banners nor swallows mail missed while quit. One
 *  entry per account (A → B → A keeps A's record). It holds the user id and
 *  opaque notification ids — no mail content. */
const LEDGER_KEY_PREFIX = "klorn.desktopAlerts.ledger:";

/** The session's source of truth; localStorage is only persistence. A failing
 *  write (quota, blocked storage) therefore cannot make the next pass re-read
 *  an old ledger and banner the same rows again, and both bells (rail +
 *  sidebar) see each other's records even with storage blocked. */
let memory: AlertLedger | null = null;

function readLedger(owner: string): AlertLedger {
  if (memory?.owner === owner) return memory;
  let stored: AlertLedger | null = null;
  try {
    stored = parseLedger(window.localStorage.getItem(LEDGER_KEY_PREFIX + owner));
  } catch {
    // Storage blocked: no memory across restarts. Live frames still banner;
    // the first catch-up pass of each launch stays a silent baseline, so it
    // can never dump old mail.
  }
  memory = resolveLedger(stored, owner);
  return memory;
}

function writeLedger(ledger: AlertLedger): void {
  memory = ledger;
  try {
    window.localStorage.setItem(LEDGER_KEY_PREFIX + ledger.owner, JSON.stringify(ledger));
  } catch (err) {
    console.warn("[DESKTOP-ALERT] could not persist the banner ledger:", err);
  }
}

async function postBanner(alert: DesktopAlert, context: string): Promise<void> {
  try {
    await tauriInvoke("show_banner", { title: alert.title, body: alert.body });
  } catch (err) {
    console.error("[DESKTOP-ALERT] banner failed:", err);
    captureClientError(err, { context, kind: alert.kind });
  }
}

/** Banner one real-time notification frame if it is a server-tagged PUSH /
 *  meeting interrupt not yet bannered for this account. An untagged interrupt
 *  frame is recorded silently. No-op outside Tauri. */
export async function deliverDesktopAlert(owner: string, payload: unknown): Promise<void> {
  if (shellKind() !== "tauri") return;
  const ledger = readLedger(owner);
  const plan = planLiveAlert(ledger, payload);
  // Record before posting: a slow or failed IPC call must not repeat the banner.
  if (plan.next !== ledger) writeLedger(plan.next);
  if (plan.alert) await postBanner(plan.alert, "tauri-notify.deliverDesktopAlert");
}

/** The kinds the user's category preferences allow, or null when they could
 *  not be read (the pass is then skipped and retried on the next refetch). */
async function fetchAllowedKinds(): Promise<Set<DesktopAlertKind> | null> {
  try {
    return allowedKindsFromConfig(await apiFetch<unknown>("/api/automations"));
  } catch (err) {
    console.warn("[DESKTOP-ALERT] could not read notification preferences:", err);
    return null;
  }
}

/** Banner the PUSH / meeting bell rows that arrived while the app was quit,
 *  asleep or disconnected. Call with every fresh bell list. No-op outside
 *  Tauri. Each read-plan-write runs synchronously, so two bells (rail +
 *  sidebar) refetching at once cannot banner the same id twice. */
export async function catchUpDesktopAlerts(owner: string, rows: readonly unknown[]): Promise<void> {
  if (shellKind() !== "tauri") return;
  // Most refetches find nothing new: settle those without a preference fetch.
  // The recorded ids do not depend on `allowed`, and a subset of kinds can
  // only banner fewer rows, so an empty plan here is the final answer.
  const peek = planCatchUp({
    ledger: readLedger(owner),
    rows,
    nowMs: Date.now(),
    allowed: ALL_ALERT_KINDS,
  });
  if (peek.toBanner.length === 0) {
    writeLedger(peek.next);
    return;
  }
  const allowed = await fetchAllowedKinds();
  if (!allowed) return;
  const plan = planCatchUp({ ledger: readLedger(owner), rows, nowMs: Date.now(), allowed });
  writeLedger(plan.next);
  for (const alert of plan.toBanner) {
    await postBanner(alert, "tauri-notify.catchUpDesktopAlerts");
  }
}
