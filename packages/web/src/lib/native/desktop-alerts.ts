// OS banners for the Windows desktop shell (apps/desktop-win, Tauri v2).
//
// Parity with the Mac app (founder decision, 2026-10-15): PUSH-lane mail and
// meetings starting soon arrive as OS notification banners; nothing else
// does. WebView2 has no dependable Web Push, so inside the shell the banner is
// driven by the real-time `notification` frame the bell already receives.
//
// This module does NOT classify. The server tags a frame with
// `alert: "push" | "meeting"` only for PUSH mail / a meeting starting soon, and
// only when the user's notification preferences and quiet hours allow it
// (packages/api notify/desktop-alert.ts — the same gate Web Push uses). Here we
// validate that tag, shape the banner text, and dedupe by notification id.
// A normal browser tab reuses parseDesktopAlert for its own OS notification
// (../in-page-alerts.ts).
//
// Pure functions over plain inputs, so the rules are unit-tested without a
// browser (packages/api/src/__tests__/web-desktop-alerts.test.ts).

import type { DesktopAlertKind } from "@klorn/contract";

export type { DesktopAlertKind };

export interface DesktopAlert {
  id: string;
  kind: DesktopAlertKind;
  title: string;
  body: string;
  /** In-app path a click on the toast opens (openPathIsSafe), or null to
   *  just bring the window back. */
  open: string | null;
}

/** Longest title / body handed to the OS toast. Windows truncates long toast
 *  text anyway; capping here bounds what an attacker-chosen subject can push
 *  through the IPC bridge. */
export const TITLE_MAX = 120;
export const BODY_MAX = 240;
/** Notification ids remembered (per account, across restarts — see
 *  ./desktop-catchup.ts). Far above the bell's 30-row window and any realistic
 *  number of PUSH/meeting interrupts a day; trimming only drops the oldest. */
export const SEEN_CAP = 500;
const ID_MAX = 200;
const FALLBACK_TITLE = "Klorn";

const KINDS: readonly DesktopAlertKind[] = ["push", "meeting"];

function isKind(value: unknown): value is DesktopAlertKind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

/** Longest message read before shaping, so the marker strip below never
 *  scans an unbounded string. */
export const MESSAGE_SCAN_MAX = 1000;

/** Meeting frames end in a ` [eventId]` dedupe marker (background.ts). It is
 *  bookkeeping, not copy. PUSH frames carry none, so a subject that really
 *  ends in "[URGENT]" is left alone. (Stored PUSH bell rows DO end in a
 *  `[gmailId,…]` marker — desktop-catchup.ts strips it with this too.) */
export function stripTrailingMarker(text: string): string {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith("]")) return trimmed;
  const open = trimmed.lastIndexOf("[");
  return open === -1 ? trimmed : trimmed.slice(0, open).trimEnd();
}

/** Mail ids are uuids / cuids. Anything else is not routed: the path ends up
 *  in a navigation the shell performs (apps/desktop-win banner.rs checks the
 *  same shape). */
const MAIL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Where the catch-up summary toast leads (decision N6). */
export const TODAY_PATH = "/today";

/** The reader for one mail, or null for an id that is not safe to route. */
export function mailOpenPath(emailId: unknown): string | null {
  return typeof emailId === "string" && MAIL_ID_PATTERN.test(emailId) ? `/email/${emailId}` : null;
}

/** Whether a toast may navigate the app to `path`: Today or one mail. */
export function openPathIsSafe(path: unknown): path is string {
  if (path === TODAY_PATH) return true;
  if (typeof path !== "string" || !path.startsWith("/email/")) return false;
  return mailOpenPath(path.slice("/email/".length)) === path;
}

/** The N1 toast a frame carries for one mail (`mail`, decision N1), or null. */
export function parseMailToast(
  value: unknown,
): { title: string; body: string; open: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { emailId, title, body } = value as Record<string, unknown>;
  const open = mailOpenPath(emailId);
  if (!open || typeof title !== "string" || typeof body !== "string") return null;
  const cleanTitle = title.trim();
  if (!cleanTitle) return null;
  return {
    title: cleanTitle.slice(0, TITLE_MAX),
    body: body.slice(0, MESSAGE_SCAN_MAX).trim().slice(0, BODY_MAX),
    open,
  };
}

/** The banner for one real-time frame, or null when it is not an interrupt
 *  the server tagged for an OS banner. A frame about one mail carries its N1
 *  toast (`mail`): sender as the title, subject + reason as the body, a click
 *  opens the mail. Never throws on malformed input. */
export function parseDesktopAlert(payload: unknown): DesktopAlert | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const frame = payload as Record<string, unknown>;
  if (!isKind(frame.alert)) return null;
  const { id, title, message } = frame;
  if (typeof id !== "string" || id.length === 0 || id.length > ID_MAX) return null;
  if (title !== undefined && typeof title !== "string") return null;
  const mail = frame.alert === "push" ? parseMailToast(frame.mail) : null;
  if (mail) return { id, kind: frame.alert, ...mail };
  const cleanTitle = (title ?? "").trim() || FALLBACK_TITLE;
  const raw = typeof message === "string" ? message.slice(0, MESSAGE_SCAN_MAX) : "";
  const body = frame.alert === "meeting" ? stripTrailingMarker(raw) : raw.trim();
  return {
    id,
    kind: frame.alert,
    title: cleanTitle.slice(0, TITLE_MAX),
    body: body.slice(0, BODY_MAX),
    open: null,
  };
}

export interface DesktopAlertPlan {
  alert: DesktopAlert | null;
  seen: string[];
}

const MAIL_KEY_PREFIX = "mail:";

/** The ledger entry for one mail, beside its bell row ids. The server can
 *  write a second row for a mail already announced (the urgent sweep rings it
 *  again once "Clear all" deleted the rows its dedupe reads); the Mac keys its
 *  PushLedger on the mail's attention item, so one mail gets one banner. Row
 *  ids never contain ":", so the two never collide. */
export function mailLedgerKey(emailId: string): string {
  return `${MAIL_KEY_PREFIX}${emailId}`;
}

/** The mail a PUSH toast opens, as a ledger key; null for anything else
 *  (meetings, the catch-up summary that opens Today). */
export function mailKeyOf(alert: DesktopAlert): string | null {
  if (alert.kind !== "push" || !alert.open?.startsWith("/email/")) return null;
  return mailLedgerKey(alert.open.slice("/email/".length));
}

/** Decide whether this frame banners, given the ids already bannered (the
 *  persisted ledger, ./desktop-catchup.ts). A frame for a mail already
 *  bannered under another row is recorded without a banner. Returns a new
 *  seen list; the input is never mutated. */
export function planDesktopAlert(seen: readonly string[], payload: unknown): DesktopAlertPlan {
  const alert = parseDesktopAlert(payload);
  if (!alert || seen.includes(alert.id)) return { alert: null, seen: [...seen] };
  const mailKey = mailKeyOf(alert);
  if (mailKey && seen.includes(mailKey)) {
    return { alert: null, seen: [...seen, alert.id].slice(-SEEN_CAP) };
  }
  const recorded = mailKey ? [alert.id, mailKey] : [alert.id];
  return { alert, seen: [...seen, ...recorded].slice(-SEEN_CAP) };
}
