// Catch-up banners for the Windows desktop shell (apps/desktop-win, Tauri v2).
//
// Live banners come from real-time frames the server tags `alert` (see
// ./desktop-alerts.ts). A frame sent while the app was quit, the machine
// slept, or the socket was down is simply lost — the API keeps no replay
// (packages/api/src/websocket.ts broadcastToUser) — and the bell's refetch
// used to record those ids as seen without a banner. So a PUSH mail that
// arrived while the user was away never became an OS notification.
//
// Rules, mirroring the Mac app's PushLedger
// (apps/desktop-mac/Sources/KlornMac/Notifications.swift):
// - the first pass for an account is a silent baseline;
// - an id is bannered at most once, and the record survives restarts (the
//   ledger lives in localStorage, shared with the live path);
// - at most CATCHUP_MAX banners per pass, newest first; the rest are recorded;
// plus a freshness cutoff the Mac does not need (its lane only holds live
// mail): PUSH rows older than 24h, meeting reminders older than 2 minutes, and
// rows the user already read elsewhere are recorded without a banner.
//
// Source: the bell's own notification rows (GET /api/notifications), not the
// PUSH/MEETING lanes. A PUSH bell row ("Urgent email") is written only when the
// server decided to interrupt for that mail — PUSH-lane or MEETING-lane, after
// its recency, dedupe and interrupt-budget gates (api judge/firewall-push.ts,
// automation-scheduler.ts urgent sweep) — and its id is the id the live frame
// carries, so live and catch-up share one ledger and can never banner the same
// mail twice. A lane also holds mail the server deliberately never pushed.
//
// Preference gate: rows do not record whether the server's gate (category
// opt-out + quiet hours + focus window, notify/notification-prefs.ts) allowed
// a banner. Until the API exposes that, catch-up (a) records every interrupt
// frame that arrived live — tagged or not — so a frame the gate held back is
// never bannered later from the refetch, (b) leaves rows younger than
// SETTLE_MS to their live frame, and (c) honours the category opt-outs
// (allowedKindsFromConfig). Quiet hours and focus windows are NOT re-evaluated
// here: a row missed while away can banner on return even if it arrived
// inside quiet hours, or banner during them if Klorn starts then. Documented
// in apps/desktop-win/README.md.
//
// Pure functions over plain inputs, unit-tested without a browser
// (packages/api/src/__tests__/web-desktop-catchup.test.ts).

import type { DesktopAlertKind } from "@klorn/contract";
import {
  type DesktopAlert,
  MESSAGE_SCAN_MAX,
  parseDesktopAlert,
  planDesktopAlert,
  SEEN_CAP,
  stripTrailingMarker,
} from "./desktop-alerts";

/** Title of the PUSH bell row, shared by the firewall push and the urgent
 *  sweep so they dedupe against each other (api judge/firewall-push.ts). */
export const PUSH_BELL_TITLE = "Urgent email";
/** Banners one pass may post (Mac: PushLedger.maxBannersPerSync). */
export const CATCHUP_MAX = 5;
/** PUSH mail older than this is recorded, not bannered. */
export const PUSH_CATCHUP_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A meeting reminder ("Meeting in N min") is written 1-5 minutes before the
 *  start (api background.ts). Only a short delay keeps that text roughly true;
 *  later, the meeting may already be under way and the banner is noise. */
export const MEETING_CATCHUP_WINDOW_MS = 2 * 60 * 1000;
/** Rows younger than this belong to their live frame: the server writes the
 *  row, then evaluates the gate, then sends the (tagged or untagged) frame. */
export const SETTLE_MS = 30 * 1000;
export const ALL_ALERT_KINDS: ReadonlySet<DesktopAlertKind> = new Set(["push", "meeting"]);

const OWNER_MAX = 200;

const WINDOW_MS: Record<DesktopAlertKind, number> = {
  push: PUSH_CATCHUP_WINDOW_MS,
  meeting: MEETING_CATCHUP_WINDOW_MS,
};

/** What has been announced, for one account, across launches. */
export interface AlertLedger {
  /** The account (user id) the ids belong to. */
  owner: string;
  /** False until the first catch-up pass recorded the bell silently. */
  baselineEstablished: boolean;
  /** Announced (or silently recorded) notification ids, oldest first. */
  notified: string[];
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
  const { owner, baselineEstablished, notified } = parsed as Record<string, unknown>;
  if (typeof owner !== "string" || owner.length === 0 || owner.length > OWNER_MAX) return null;
  if (typeof baselineEstablished !== "boolean" || !Array.isArray(notified)) return null;
  return {
    owner,
    baselineEstablished,
    notified: notified.filter((v): v is string => typeof v === "string").slice(-SEEN_CAP),
  };
}

function recording(ledger: AlertLedger, ids: readonly string[]): AlertLedger {
  return { ...ledger, notified: [...ledger.notified, ...ids].slice(-SEEN_CAP) };
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
  if (row.type === "email" && row.title === PUSH_BELL_TITLE) return "push";
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
  const alert = parseDesktopAlert({ id: record.id, title: record.title, message, alert: kind });
  if (!alert) return null;
  const createdAtMs = typeof record.createdAt === "string" ? Date.parse(record.createdAt) : NaN;
  return { alert, createdAtMs, isRead: record.isRead === true };
}

export interface LiveAlertPlan {
  alert: DesktopAlert | null;
  next: AlertLedger;
}

/** One real-time frame. A tagged frame banners once; an untagged interrupt
 *  frame (the server's gate said no) is recorded silently so catch-up never
 *  banners it later. Never establishes the baseline. */
export function planLiveAlert(ledger: AlertLedger, payload: unknown): LiveAlertPlan {
  const tagged = planDesktopAlert(ledger.notified, payload);
  if (tagged.alert) return { alert: tagged.alert, next: { ...ledger, notified: tagged.seen } };
  const interrupt = interruptFromRow(payload);
  if (!interrupt || ledger.notified.includes(interrupt.alert.id)) {
    return { alert: null, next: ledger };
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
  return Number.isFinite(age) && age <= WINDOW_MS[row.alert.kind];
}

/** Plan the banners for the bell as it is now. Pure; the input is never
 *  mutated. */
export function planCatchUp({ ledger, rows, nowMs, allowed }: CatchUpInput): CatchUpPlan {
  const known = new Set(ledger.notified);
  const unseen: InterruptRow[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const interrupt = interruptFromRow(row);
    if (!interrupt || known.has(interrupt.alert.id)) continue;
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
