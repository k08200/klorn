// Catch-up banners for the Windows desktop shell (apps/desktop-win, Tauri v2).
//
// Live banners come from real-time frames the server tags `alert` (see
// ./desktop-alerts.ts). A frame sent while the app was quit, the machine
// slept, or the socket was down is simply lost — the API keeps no replay
// (packages/api/src/websocket.ts broadcastToUser).
//
// This module holds the per-account ledger both paths share and the meeting
// catch-up. Urgent mail is caught up by ./desktop-push-catchup.ts (decision
// N6: one toast for one missed mail, one summary for several, only PUSH mail
// from the last 72h that is still open, held during quiet hours), which asks
// the server about the bell's PUSH rows.
//
// Rules, mirroring the Mac app's PushLedger
// (apps/desktop-mac/Sources/KlornMac/Notifications.swift):
// - the first pass for an account is a silent baseline;
// - an id is bannered at most once, and the record survives restarts (the
//   ledger lives in localStorage, shared with the live path);
// - a mail is bannered at most once, however many bell rows name it (its
//   `mail:<emailId>` entry, ./desktop-alerts.ts mailLedgerKey);
// - at most CATCHUP_MAX meeting banners per pass, newest first; the rest are
//   recorded;
// plus a freshness cutoff: meeting reminders older than 2 minutes, and rows
// the user already read elsewhere, are recorded without a banner.
//
// Source: the bell's own notification rows (GET /api/notifications). A
// meeting bell row's id is the id its live frame carries, so live and
// catch-up share one ledger and never banner the same reminder twice.
//
// Preference gate: rows do not record whether the server's gate (category
// opt-out + quiet hours, notify/notification-prefs.ts) allowed a banner. So
// (a) an untagged meeting frame, or one naming no single mail, is recorded
// as it arrives, so the refetch never banners what the gate held back;
// (b) an untagged frame about one mail is HELD instead (`held`): its row is
// left for ./desktop-push-catchup.ts, whose server question applies the same
// gate again — quiet hours answer `held` until they end, then the mail toasts
// once (alone, or in one summary), unless it was read, cleared, handled or
// already toasted meanwhile; an opt-out answers nothing and the row is
// recorded. An untagged Slack PUSH frame (api slack/notify.ts sends one when
// the push will not ring) is held the same way and answered by the same
// question. As on the Mac (HeldBanners.swift), meetings are not held;
// (c) rows younger than SETTLE_MS are left to their live frame, and (d) the
// category opt-outs are honoured (allowedKindsFromConfig).
//
// Pure functions over plain inputs, unit-tested without a browser
// (packages/api/src/__tests__/web-desktop-catchup.test.ts).

import type { DesktopAlertKind } from "@klorn/contract";
import {
  type DesktopAlert,
  MESSAGE_SCAN_MAX,
  mailKeyOf,
  parseDesktopAlert,
  parseMailToast,
  planDesktopAlert,
  SEEN_CAP,
  stripTrailingMarker,
} from "./desktop-alerts";

/** English title of the PUSH bell row, shared by the firewall push and the
 *  urgent sweep (api judge/firewall-push.ts). Live frames since decision N1
 *  also carry `mail`, which identifies them in every language. */
export const PUSH_BELL_TITLE = "Urgent email";
/** Meeting banners one pass may post (Mac: PushLedger.maxBannersPerSync). */
export const CATCHUP_MAX = 5;
/** A meeting reminder ("Meeting in N min") is written 1-5 minutes before the
 *  start (api background.ts). Only a short delay keeps that text roughly true;
 *  later, the meeting may already be under way and the banner is noise. */
export const MEETING_CATCHUP_WINDOW_MS = 2 * 60 * 1000;
/** Rows younger than this belong to their live frame: the server writes the
 *  row, then evaluates the gate, then sends the (tagged or untagged) frame. */
export const SETTLE_MS = 30 * 1000;
export const ALL_ALERT_KINDS: ReadonlySet<DesktopAlertKind> = new Set(["push", "meeting"]);
/** The bell row type of a Slack PUSH (api slack/notify.ts SLACK_NOTIFICATION_TYPE). */
export const SLACK_ROW_TYPE = "slack";
/** Bell row ids are uuids; anything else is never held or asked about. */
const ROW_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Held ids kept at most, newest kept (the Mac's HeldBanners.maxHeld). Far
 *  above the bell's 30-row page, the only rows a catch-up can ask about; the
 *  cap only bounds the stored record (an id is dropped once recorded). */
export const HELD_CAP = 200;

const OWNER_MAX = 200;

/** What has been announced, for one account, across launches. */
export interface AlertLedger {
  /** The account (user id) the ids belong to. */
  owner: string;
  /** False until the first catch-up pass recorded the bell silently. */
  baselineEstablished: boolean;
  /** Announced (or silently recorded) notification ids, plus `mail:<emailId>`
   *  for each mail toasted, oldest first. */
  notified: string[];
  /** Bell row ids whose live frame came untagged (quiet hours) for one mail
   *  not toasted yet, oldest first: not recorded, so the urgent-mail catch-up
   *  still asks about them. Read only to title the summary "during quiet
   *  hours" when every mail in it waited live (else "while Klorn was
   *  closed", as the Mac) and to keep them out of a first-run baseline.
   *  Absent on a ledger saved before holds. */
  held?: string[];
}

export function freshLedger(owner: string): AlertLedger {
  return { owner, baselineEstablished: false, notified: [] };
}

/** The stored ledger if it belongs to `owner`, else a new baseline. */
export function resolveLedger(stored: AlertLedger | null, owner: string): AlertLedger {
  return stored && stored.owner === owner ? stored : freshLedger(owner);
}

/** Read the stored ledger. Storage is untrusted: anything malformed is null. */
export function parseLedger(raw: string | null): AlertLedger | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { owner, baselineEstablished, notified, held } = parsed as Record<string, unknown>;
  if (typeof owner !== "string" || owner.length === 0 || owner.length > OWNER_MAX) return null;
  if (typeof baselineEstablished !== "boolean" || !Array.isArray(notified)) return null;
  return {
    owner,
    baselineEstablished,
    notified: stringItems(notified).slice(-SEEN_CAP),
    // A malformed held list costs only the summary's wording: drop it, keep
    // the ledger (losing that would make the next pass a silent baseline).
    ...(Array.isArray(held) ? { held: stringItems(held).slice(-HELD_CAP) } : {}),
  };
}

function stringItems(values: readonly unknown[]): string[] {
  return values.filter((v): v is string => typeof v === "string");
}

/** The ledger with `ids` recorded; a recorded id is no longer held. */
export function recording(ledger: AlertLedger, ids: readonly string[]): AlertLedger {
  const next = { ...ledger, notified: [...ledger.notified, ...ids].slice(-SEEN_CAP) };
  if (!ledger.held) return next;
  const done = new Set(ids);
  return { ...next, held: ledger.held.filter((id) => !done.has(id)) };
}

/** The ledger with `id` held (once, at most HELD_CAP, newest kept). */
function holding(ledger: AlertLedger, id: string): AlertLedger {
  const held = ledger.held ?? [];
  if (held.includes(id)) return ledger;
  return { ...ledger, held: [...held, id].slice(-HELD_CAP) };
}

export interface InterruptRow {
  alert: DesktopAlert;
  /** NaN when the timestamp is unreadable — never fresh. */
  createdAtMs: number;
  /** Already read on another device or in the web app. */
  isRead: boolean;
}

function interruptKind(row: Record<string, unknown>): DesktopAlertKind | null {
  if (row.type === "meeting") return "meeting";
  if (row.type === "email" && (row.title === PUSH_BELL_TITLE || parseMailToast(row.mail))) {
    return "push";
  }
  return null;
}

/** The interrupt a bell row (or an untagged live frame) stands for, or null
 *  for every other row. Never throws on malformed input. */
export function interruptFromRow(row: unknown): InterruptRow | null {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  const kind = interruptKind(record);
  if (!kind) return null;
  const message =
    typeof record.message === "string"
      ? stripTrailingMarker(record.message.slice(0, MESSAGE_SCAN_MAX))
      : "";
  const alert = parseDesktopAlert({
    id: record.id,
    title: record.title,
    message,
    mail: record.mail,
    alert: kind,
  });
  if (!alert) return null;
  const createdAtMs = typeof record.createdAt === "string" ? Date.parse(record.createdAt) : NaN;
  return { alert, createdAtMs, isRead: record.isRead === true };
}

export interface LiveAlertPlan {
  alert: DesktopAlert | null;
  next: AlertLedger;
}

/** The row id of a Slack PUSH frame, or null for any other payload. */
function slackFrameId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const { type, id } = payload as Record<string, unknown>;
  return type === SLACK_ROW_TYPE && typeof id === "string" && ROW_ID_PATTERN.test(id) ? id : null;
}

/** One real-time frame. A tagged frame banners once. An untagged interrupt
 *  frame (the server's gate said no) about one mail not toasted yet, or an
 *  untagged Slack PUSH frame, is held for the urgent catch-up, which asks the
 *  gate again and toasts it once quiet hours end; any other untagged
 *  interrupt frame is recorded silently so catch-up never banners it later.
 *  Never establishes the baseline. */
export function planLiveAlert(ledger: AlertLedger, payload: unknown): LiveAlertPlan {
  const tagged = planDesktopAlert(ledger.notified, payload);
  if (tagged.alert) return { alert: tagged.alert, next: { ...ledger, notified: tagged.seen } };
  const slackId = slackFrameId(payload);
  if (slackId) {
    if (ledger.notified.includes(slackId)) return { alert: null, next: ledger };
    return { alert: null, next: holding(ledger, slackId) };
  }
  const interrupt = interruptFromRow(payload);
  if (!interrupt || ledger.notified.includes(interrupt.alert.id)) {
    return { alert: null, next: ledger };
  }
  const mailKey = mailKeyOf(interrupt.alert);
  if (mailKey && !ledger.notified.includes(mailKey)) {
    return { alert: null, next: holding(ledger, interrupt.alert.id) };
  }
  return { alert: null, next: recording(ledger, [interrupt.alert.id]) };
}

export interface CatchUpInput {
  ledger: AlertLedger;
  /** Bell rows as returned by GET /api/notifications. */
  rows: readonly unknown[];
  nowMs: number;
  /** Kinds the user's category preferences allow. */
  allowed: ReadonlySet<DesktopAlertKind>;
}

export interface CatchUpPlan {
  toBanner: DesktopAlert[];
  next: AlertLedger;
}

function isFresh(row: InterruptRow, nowMs: number): boolean {
  const age = nowMs - row.createdAtMs;
  return Number.isFinite(age) && age <= MEETING_CATCHUP_WINDOW_MS;
}

/** Plan the meeting banners for the bell as it is now. PUSH rows are left to
 *  ./desktop-push-catchup.ts (never recorded here). Establishes the baseline.
 *  Pure; the input is never mutated. */
export function planCatchUp({ ledger, rows, nowMs, allowed }: CatchUpInput): CatchUpPlan {
  const known = new Set(ledger.notified);
  const unseen: InterruptRow[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const interrupt = interruptFromRow(row);
    if (!interrupt || interrupt.alert.kind !== "meeting" || known.has(interrupt.alert.id)) {
      continue;
    }
    // Too new to judge: its live frame (or the next pass) decides.
    if (nowMs - interrupt.createdAtMs < SETTLE_MS) continue;
    known.add(interrupt.alert.id);
    unseen.push(interrupt);
  }
  const next: AlertLedger = {
    ...recording(
      ledger,
      unseen.map((r) => r.alert.id),
    ),
    baselineEstablished: true,
  };
  if (!ledger.baselineEstablished) return { toBanner: [], next };
  const toBanner = unseen
    .filter((r) => !r.isRead && allowed.has(r.alert.kind) && isFresh(r, nowMs))
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, CATCHUP_MAX)
    .map((r) => r.alert);
  return { toBanner, next };
}

/** The kinds the user's category preferences allow, from GET
 *  /api/automations (`notifyEmailUrgent`, `notifyMeeting`; the server treats
 *  a missing flag as on). Null for a malformed response. */
export function allowedKindsFromConfig(config: unknown): Set<DesktopAlertKind> | null {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return null;
  const { notifyEmailUrgent, notifyMeeting } = config as Record<string, unknown>;
  const kinds = new Set<DesktopAlertKind>();
  if (notifyEmailUrgent !== false) kinds.add("push");
  if (notifyMeeting !== false) kinds.add("meeting");
  return kinds;
}
