// Posts the Windows desktop shell's OS banners. Which frames and bell rows
// banner, and the once-per-id ledger, are decided by the pure rules in
// ./desktop-alerts.ts, ./desktop-catchup.ts and ./desktop-push-catchup.ts;
// this file is only the side-effecting edge: local storage, the API reads and
// the IPC call.
//
// The shell exposes exactly one command for this, `show_banner` (title + body
// + the page a click opens, all checked and posted from Rust) — none of the
// notification plugin's commands are granted to app.klorn.ai. See
// apps/desktop-win/src-tauri/src/banner.rs and capabilities/default.json.

import type { DesktopAlertKind, DesktopCatchUpResponse } from "@klorn/contract";
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
import {
  parseCatchUpResponse,
  planPushCatchUp,
  pushCatchUpCandidates,
} from "./desktop-push-catchup";
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
    await tauriInvoke("show_banner", { title: alert.title, body: alert.body, open: alert.open });
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

/** After the server says "quiet hours", wait this long before asking again
 *  (the bell refetches every minute, from two places). */
const HELD_RETRY_MS = 5 * 60 * 1000;
let askAgainAtMs = 0;

interface MissedMailAnswer {
  response: DesktopCatchUpResponse | null;
  /** The ids the question named (empty when not asked). */
  sent: string[];
}

const NOT_ASKED: MissedMailAnswer = { response: null, sent: [] };

/** Ask the server which unseen PUSH rows still deserve a toast. No response
 *  when there is nothing to ask, the first run's baseline is still pending,
 *  quiet hours were reported recently, or the request failed. */
async function fetchMissedMail(owner: string, rows: readonly unknown[]): Promise<MissedMailAnswer> {
  const ledger = readLedger(owner);
  if (!ledger.baselineEstablished || Date.now() < askAgainAtMs) return NOT_ASKED;
  const { ask } = pushCatchUpCandidates(ledger, rows, Date.now());
  if (ask.length === 0) return NOT_ASKED;
  try {
    const raw = await apiFetch<unknown>(
      `/api/notifications/desktop-catchup?ids=${ask.map(encodeURIComponent).join(",")}`,
    );
    const response = parseCatchUpResponse(raw);
    if (!response) {
      console.warn("[DESKTOP-ALERT] malformed catch-up response");
      return NOT_ASKED;
    }
    if (response.held) askAgainAtMs = Date.now() + HELD_RETRY_MS;
    return { response, sent: ask };
  } catch (err) {
    console.warn("[DESKTOP-ALERT] could not read missed urgent mail:", err);
    return NOT_ASKED;
  }
}

/** Urgent mail missed while the app was away: one toast, or one summary
 *  (decision N6, ./desktop-push-catchup.ts). */
async function catchUpUrgentMail(owner: string, rows: readonly unknown[]): Promise<void> {
  const { response, sent } = await fetchMissedMail(owner, rows);
  // Plan on the ledger as it is after the await: the other bell may have
  // recorded these ids meanwhile.
  const plan = planPushCatchUp({
    ledger: readLedger(owner),
    rows,
    nowMs: Date.now(),
    response,
    sent,
  });
  writeLedger(plan.next);
  if (plan.toast) await postBanner(plan.toast, "tauri-notify.catchUpUrgentMail");
}

/** Meeting reminders missed while the app was away. Establishes the baseline. */
async function catchUpMeetings(owner: string, rows: readonly unknown[]): Promise<void> {
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

/** Banner what arrived while the app was quit, asleep or disconnected. Call
 *  with every fresh bell list. No-op outside Tauri. Each read-plan-write runs
 *  synchronously, so two bells (rail + sidebar) refetching at once cannot
 *  banner the same id twice. Urgent mail first: on the first run it records
 *  the bell silently before the meeting pass establishes the baseline. */
export async function catchUpDesktopAlerts(owner: string, rows: readonly unknown[]): Promise<void> {
  if (shellKind() !== "tauri") return;
  await catchUpUrgentMail(owner, rows);
  await catchUpMeetings(owner, rows);
}
