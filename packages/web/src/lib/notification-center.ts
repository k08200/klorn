/**
 * Notification center (NC1 A, "grouped by what to do"): pure decisions for the
 * bell panel. Free of React and Next imports so packages/api can test it
 * (api/src/__tests__/web-notification-center.test.ts).
 *
 * The contract fields lane / reason / held / group / deliveredTo are OPTIONAL:
 * the server adds them over time, and every one degrades to "show nothing"
 * when absent. Nothing here guesses a lane or a reason.
 */

import type { LiveTier } from "@klorn/contract";
import { CORE_TIERS, toLiveTier } from "./tiers";

export const CENTER_GROUP_ORDER = ["now", "today", "reply", "later", "done"] as const;
export type CenterGroupKey = (typeof CENTER_GROUP_ORDER)[number];

/** Why a row rang. `quote` is the source sentence, set only when `verified`. */
export interface NotificationReason {
  text?: string | null;
  verified?: boolean | null;
  quote?: string | null;
  quoteIn?: string | null;
}

export interface CenterNotification {
  id: string;
  type: string;
  title: string;
  message: string;
  isRead: boolean;
  createdAt: string;
  conversationId?: string | null;
  sourceEmailId?: string | null;
  pendingActionId?: string | null;
  pendingActionStatus?: string | null;
  link?: string | null;
  // Optional contract fields (server side, rolling out).
  lane?: string | null;
  reason?: NotificationReason | null;
  held?: boolean | null;
  group?: CenterGroupKey | null;
  deliveredTo?: unknown;
}

function isGroupKey(value: unknown): value is CenterGroupKey {
  return typeof value === "string" && (CENTER_GROUP_ORDER as readonly string[]).includes(value);
}

/** The server's group when it sent a known one; otherwise the local fallback. */
export function centerGroupOf(n: CenterNotification): CenterGroupKey {
  if (isGroupKey(n.group)) return n.group;
  if (n.isRead) return "done";
  if (n.type === "reminder") return "later";
  if (n.type === "meeting") return "today";
  // Unread email, a PENDING agent proposal and every other unread row.
  return "now";
}

export interface CenterGroup<T extends CenterNotification> {
  key: CenterGroupKey;
  items: T[];
}

/** Groups in CENTER_GROUP_ORDER, empty ones dropped, incoming order kept. */
export function groupForCenter<T extends CenterNotification>(list: readonly T[]): CenterGroup<T>[] {
  return CENTER_GROUP_ORDER.map((key) => ({
    key,
    items: list.filter((n) => centerGroupOf(n) === key),
  })).filter((g) => g.items.length > 0);
}

const BADGE_GROUPS: readonly CenterGroupKey[] = ["now", "today"];

/**
 * The bell badge: unread rows in "now" + "today" once the server groups rows.
 * Until any row carries a server group, every unread row counts (the local
 * fallback would otherwise hide unread reminders from the badge).
 */
export function bellBadgeCount(list: readonly CenterNotification[]): number {
  const serverGrouped = list.some((n) => isGroupKey(n.group));
  return list.filter(
    (n) => !n.isRead && (!serverGrouped || BADGE_GROUPS.includes(centerGroupOf(n))),
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
export function reasonLine(reason: NotificationReason | null | undefined): ReasonLine {
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

const RETIRED_TIERS = ["CALL", "AUTO"];

/** A recorded lane folded to a live one; null when absent or unrecognised. */
export function rowLane(lane: string | null | undefined): LiveTier | null {
  if (typeof lane !== "string") return null;
  if (!(CORE_TIERS as readonly string[]).includes(lane) && !RETIRED_TIERS.includes(lane)) {
    return null;
  }
  return toLiveTier(lane);
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

/** "Mac · Chrome" from n.deliveredTo; null when absent or unreadable. */
export function deliveredToLabel(value: unknown): string | null {
  const entries = Array.isArray(value) ? value : [value];
  const labels = [...new Set(entries.map(channelLabel).filter(Boolean))];
  return labels.length > 0 ? labels.join(" · ") : null;
}

export interface NotifBudget {
  used: number;
  limit: number;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** The daily interrupt budget, only when the list response already carries one. */
export function parseNotifBudget(response: unknown): NotifBudget | null {
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

/** A 404 means the route is not deployed yet: stop asking for this session. */
export function isMissingRoute(err: unknown): boolean {
  return err instanceof Error && /^API 404\b/.test(err.message);
}
