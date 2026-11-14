/**
 * Notification center (NC1 A, "grouped by what to do"): pure decisions for the
 * bell panel. Free of React and Next imports so packages/api can test it
 * (api/src/__tests__/web-notification-center.test.ts).
 *
 * The row and list shapes are the wire contract (@klorn/contract
 * notification-center.ts, built by api background.ts getNotifications +
 * notify/notification-center.ts). Its lane / reason / held / group and the
 * list-level budget are OPTIONAL, and every one degrades to "show nothing"
 * when absent. Nothing here guesses a lane or a reason.
 */

import type {
  LiveTier,
  NotificationBudget,
  NotificationGroup,
  NotificationReason,
  NotificationRow,
} from "@klorn/contract";
import { CORE_TIERS, toLiveTier } from "./tiers";

export const CENTER_GROUP_ORDER = [
  "now",
  "today",
  "reply",
  "later",
  "done",
] as const satisfies readonly NotificationGroup[];
export type CenterGroupKey = NotificationGroup;

/** One bell row: exactly the contract row of `GET /api/notifications`. */
export type CenterNotification = NotificationRow;

function isGroupKey(value: unknown): value is CenterGroupKey {
  return typeof value === "string" && (CENTER_GROUP_ORDER as readonly string[]).includes(value);
}

// ── Client grouping fallback ──
// Used ONLY when a row carries no server `group` (enrichment failed or an
// older API). Mirrors api notify/notification-group.ts notificationGroup,
// whose first matching rule wins, as far as a bell row's fields allow:
//
//   server rule                                   here
//   1. done   read / item RESOLVED|DISMISSED /    read, or pendingActionStatus
//             approval no longer PENDING           set and not PENDING (the item
//                                                  status is not on the row)
//   2. later  item SNOOZED                         — (not on the row)
//   3. now    PUSH lane, received in the last 72h  lane PUSH and createdAt in the
//             (judge/today-push-window.ts)         last 72h (receivedAt is not on
//                                                  the row; the server also falls
//                                                  back to createdAt)
//   4. reply  needsReply and not replied           — (not on the row)
//   5. today  approval PENDING; or, in the user's  the same, with the browser's
//             local day, a MEETING-lane row or a   local day standing in for the
//             meeting / calendar / reminder row    user's AutomationConfig zone
//             written today, or a v3 ask due today (v3Due is not on the row)
//   6. later  everything else                      the same
//
// A row missing data for a rule simply does not match it, so the fallback
// never puts a row in "now" or "today" the server would not.

/** Today's PUSH window, hours (api judge/today-push-window.ts TODAY_PUSH_WINDOW_HOURS, LOCKED 2026-10-23). */
const PUSH_WINDOW_HOURS = 72;
const HOUR_MS = 3_600_000;
const PENDING = "PENDING";
/** Rows about a moment (api notification-group.ts DAY_TYPES). */
const DAY_TYPES: ReadonlySet<string> = new Set(["meeting", "calendar", "reminder"]);

/** Same calendar day in the browser's zone. */
function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export interface GroupFallbackOptions {
  /** How "the same day" is decided; the browser's local day by default. */
  sameDay?: (a: Date, b: Date) => boolean;
}

function fallbackGroup(
  n: CenterNotification,
  now: Date,
  opts: GroupFallbackOptions,
): CenterGroupKey {
  if (n.isRead) return "done";
  if (n.pendingActionStatus != null && n.pendingActionStatus !== PENDING) return "done";
  const lane = rowLane(n.lane);
  const at = new Date(n.createdAt);
  const dated = Number.isFinite(at.getTime());
  if (lane === "PUSH" && dated && at.getTime() >= now.getTime() - PUSH_WINDOW_HOURS * HOUR_MS) {
    return "now";
  }
  if (n.pendingActionStatus === PENDING) return "today";
  const sameDay = opts.sameDay ?? sameLocalDay;
  if (dated && (lane === "MEETING" || DAY_TYPES.has(n.type)) && sameDay(at, now)) return "today";
  return "later";
}

/** The server's group when it sent a known one; otherwise the local fallback above. */
export function centerGroupOf(
  n: CenterNotification,
  now: Date = new Date(),
  opts: GroupFallbackOptions = {},
): CenterGroupKey {
  return isGroupKey(n.group) ? n.group : fallbackGroup(n, now, opts);
}

export interface CenterGroup<T extends CenterNotification> {
  key: CenterGroupKey;
  items: T[];
}

/** Groups in CENTER_GROUP_ORDER, empty ones dropped, incoming order kept. */
export function groupForCenter<T extends CenterNotification>(
  list: readonly T[],
  now: Date = new Date(),
): CenterGroup<T>[] {
  return CENTER_GROUP_ORDER.map((key) => ({
    key,
    items: list.filter((n) => centerGroupOf(n, now) === key),
  })).filter((g) => g.items.length > 0);
}

const BADGE_GROUPS: readonly CenterGroupKey[] = ["now", "today"];

/**
 * The bell badge: unread rows in "now" + "today" once the server groups rows.
 * Until any row carries a server group, every unread row counts (the local
 * fallback would otherwise hide unread reminders from the badge).
 */
export function bellBadgeCount(
  list: readonly CenterNotification[],
  now: Date = new Date(),
): number {
  const serverGrouped = list.some((n) => isGroupKey(n.group));
  return list.filter(
    (n) => !n.isRead && (!serverGrouped || BADGE_GROUPS.includes(centerGroupOf(n, now))),
  ).length;
}

export type ReasonLine =
  | { kind: "quote"; text: string }
  | { kind: "judgment"; text: string }
  | null;

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

const QUOTE_MARKS = /^["“”'‘’]+|["“”'‘’]+$/g;

/**
 * Line 3, "why it rang". A verified quote shows in curly quotes; otherwise the
 * judge's text (the caller prefixes "Klorn's call · "); otherwise nothing.
 * The result is plain text: the caller renders it as a text node, never as
 * HTML or markdown (the reason may be model output).
 */
export function reasonLine(reason: Partial<NotificationReason> | null | undefined): ReasonLine {
  if (!reason || typeof reason !== "object") return null;
  const quote = cleanText(reason.quote).replace(QUOTE_MARKS, "").trim();
  if (reason.verified === true && quote) return { kind: "quote", text: `“${quote}”` };
  const text = cleanText(reason.text);
  return text ? { kind: "judgment", text } : null;
}

const AGENT_PREFIXES = ["[Klorn]", "[Eve]", "[EV" + "E]"];

export function isAgentTitle(title: string): boolean {
  return AGENT_PREFIXES.some((p) => title.startsWith(p));
}

export function stripAgentPrefix(title: string): string {
  const prefix = AGENT_PREFIXES.find((p) => title.startsWith(p));
  return prefix ? title.slice(prefix.length).trim() : title;
}

// Urgent-mail rows are written as "Sender: Subject [gmailId]"
// (api judge/firewall-push.ts firewallBellRow).
const MAIL_MESSAGE = /^(.+?):\s+(.+?)(?:\s+\[[^\]\s]+\])?$/;

export interface RowParts {
  /** Line 1: the sender, or the event / row title. */
  who: string;
  /** Line 2: the subject or message. */
  subject: string;
  /** True when `who` is a mail sender — the row gets a monogram. */
  person: boolean;
}

export function mailRowParts(n: CenterNotification): RowParts {
  if (n.sourceEmailId) {
    const match = MAIL_MESSAGE.exec(n.message.trim());
    if (match) return { who: match[1].trim(), subject: match[2].trim(), person: true };
  }
  return { who: stripAgentPrefix(n.title), subject: n.message, person: false };
}

export interface Monogram {
  initials: string;
  hue: number;
}

const HUE_RANGE = 360;

/** Up to two initials and a stable hue hashed from the name. */
export function monogram(name: string): Monogram {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  let initials = "?";
  if (parts.length > 1) {
    initials = `${Array.from(parts[0])[0]}${Array.from(parts[parts.length - 1])[0]}`;
  } else if (parts.length === 1) {
    const chars = Array.from(parts[0]);
    // A Latin single word reads best as two letters ("OP"); a CJK name as one.
    initials = /^[A-Za-z]/.test(chars[0]) ? chars.slice(0, 2).join("") : chars[0];
  }
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) | 0;
  return { initials: initials.toUpperCase(), hue: Math.abs(hash) % HUE_RANGE };
}

/**
 * A recorded live lane; null when absent or not a live lane. Retired v1
 * values are folded server-side (normalizeTier) before they reach the bell,
 * so anything else renders no lane rather than a guessed one.
 */
export function rowLane(lane: string | null | undefined): LiveTier | null {
  if (typeof lane !== "string") return null;
  return (CORE_TIERS as readonly string[]).includes(lane) ? toLiveTier(lane) : null;
}

// Product and platform names are proper nouns: the same in every locale.
const CHANNEL_NAMES: Record<string, string> = {
  mac: "Mac",
  macos: "Mac",
  windows: "Windows",
  chrome: "Chrome",
  edge: "Edge",
  firefox: "Firefox",
  safari: "Safari",
  telegram: "Telegram",
  android: "Android",
  ios: "iPhone",
  iphone: "iPhone",
};

function channelLabel(entry: unknown): string {
  if (typeof entry === "string") {
    const trimmed = entry.trim();
    return CHANNEL_NAMES[trimmed.toLowerCase()] ?? trimmed;
  }
  if (entry && typeof entry === "object") {
    const record = entry as Record<string, unknown>;
    for (const field of ["label", "name", "channel"]) {
      if (typeof record[field] === "string") return channelLabel(record[field]);
    }
  }
  return "";
}

/** "Mac · Chrome" from a delivery read's deliveredTo; null when absent or unreadable. */
export function deliveredToLabel(value: unknown): string | null {
  const entries = Array.isArray(value) ? value : [value];
  const labels = [...new Set(entries.map(channelLabel).filter(Boolean))];
  return labels.length > 0 ? labels.join(" · ") : null;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * The list-level daily interrupt budget (contract NotificationListResponse
 * `budget`, sent only for v3 users with a finite limit); null when absent or
 * not sane.
 */
export function parseNotifBudget(response: unknown): NotificationBudget | null {
  if (!response || typeof response !== "object") return null;
  const budget = (response as { budget?: unknown }).budget;
  if (!budget || typeof budget !== "object") return null;
  const { used, limit } = budget as Record<string, unknown>;
  return isCount(used) && isCount(limit) && limit > 0 ? { used, limit } : null;
}

// ── Lazy "delivered to" (GET /api/notifications/:id/delivery) ──

export function deliveryPath(id: string): string {
  return `/api/notifications/${encodeURIComponent(id)}/delivery`;
}

/** "Mac · Chrome" from the delivery response; null when it names nothing. */
export function parseDeliveryResponse(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as { deliveredTo?: unknown }).deliveredTo;
  return value === undefined ? null : deliveredToLabel(value);
}

// ── Delivery 404s ──
// The route answers 404 for a row that is not the caller's AND for a row
// deleted after the list loaded (api routes/notifications.ts, body
// {"error":"Notification not found"}). Neither says the route is missing, so a
// 404 disables only that row. Only Fastify's own unmatched-route body
// ({"message":"Route GET:<url> not found", …}; the API registers no custom
// not-found handler) proves the route is not deployed. apiFetch exposes the
// body, not the headers, as `API <status>: <body>`.

const FASTIFY_ROUTE_MISSING = /^Route [A-Z]+:\S+ not found$/;

export type DeliveryFailureKind = "route-missing" | "row-unavailable" | "other";

function errorBody(message: string): unknown {
  try {
    return JSON.parse(message.replace(/^API 404:\s*/, ""));
  } catch {
    return null;
  }
}

export function deliveryFailureKind(err: unknown): DeliveryFailureKind {
  if (!(err instanceof Error) || !/^API 404\b/.test(err.message)) return "other";
  const body = errorBody(err.message);
  const message =
    body && typeof body === "object" ? (body as { message?: unknown }).message : undefined;
  return typeof message === "string" && FASTIFY_ROUTE_MISSING.test(message)
    ? "route-missing"
    : "row-unavailable";
}

/** True only for a 404 whose body proves the route itself is missing. */
export function isMissingRoute(err: unknown): boolean {
  return deliveryFailureKind(err) === "route-missing";
}

export interface DeliveryLookupMemo {
  shouldLookup(id: string): boolean;
  recordFailure(id: string, err: unknown): DeliveryFailureKind;
  routeMissing(): boolean;
}

/** Which rows not to ask again: a row 404 disables that row; a proven missing route, all. */
export function createDeliveryLookupMemo(): DeliveryLookupMemo {
  const disabled = new Set<string>();
  let missing = false;
  return {
    shouldLookup: (id) => !missing && !disabled.has(id),
    recordFailure(id, err) {
      const kind = deliveryFailureKind(err);
      if (kind === "route-missing") missing = true;
      else if (kind === "row-unavailable") disabled.add(id);
      return kind;
    },
    routeMissing: () => missing,
  };
}
