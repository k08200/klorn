/**
 * The day's receipt as one timeline (productization plan P7, Activity).
 *
 * GET /api/inbox/receipt/today answers four lists — what Klorn handled, what
 * it notified about, what it queued and what it silenced. Activity shows them
 * as one list, newest first, grouped by the part of the day in the reader's
 * zone. Pure, so the api vitest suite can pin it.
 */

import type { DailyReceipt, ReceiptItem } from "@klorn/contract";
import { KNOWN_TOOL_IDS, toolLabelKey } from "../../../lib/tool-labels";

export type ActivityKind = "handled" | "notified" | "queued" | "silenced";

export const ACTIVITY_KINDS: readonly ActivityKind[] = [
  "handled",
  "notified",
  "queued",
  "silenced",
];

export interface ActivityEntry {
  /** Unique across the four lists (an id may repeat between them). */
  key: string;
  kind: ActivityKind;
  item: ReceiptItem;
}

const time = (iso: string): number => {
  const value = new Date(iso).getTime();
  return Number.isFinite(value) ? value : 0;
};

export function activityEntries(receipt: DailyReceipt): ActivityEntry[] {
  const tag = (kind: ActivityKind, items: readonly ReceiptItem[]): ActivityEntry[] =>
    (Array.isArray(items) ? items : []).map((item) => ({ key: `${kind}:${item.id}`, kind, item }));
  return [
    ...tag("handled", receipt.auto),
    ...tag("notified", receipt.pushed),
    ...tag("queued", receipt.queued),
    ...tag("silenced", receipt.silenced),
  ].sort((a, b) => time(b.item.surfacedAt) - time(a.item.surfacedAt));
}

export type DayPart = "night" | "morning" | "afternoon" | "evening";

const MORNING_FROM = 5;
const AFTERNOON_FROM = 12;
const EVENING_FROM = 18;

function hourInZone(iso: string, timeZone: string): number | null {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    const hour = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone,
    }).format(date);
    const parsed = Number.parseInt(hour, 10);
    return Number.isInteger(parsed) ? parsed : null;
  } catch {
    // An unknown zone name: no bucket can be worked out.
    return null;
  }
}

/** An unreadable time or zone lands in the morning rather than vanishing. */
export function dayPartOf(iso: string, timeZone: string): DayPart {
  const hour = hourInZone(iso, timeZone);
  if (hour === null) return "morning";
  if (hour < MORNING_FROM) return "night";
  if (hour < AFTERNOON_FROM) return "morning";
  if (hour < EVENING_FROM) return "afternoon";
  return "evening";
}

export interface ActivityGroup {
  part: DayPart;
  entries: ActivityEntry[];
}

/** Consecutive entries of the same part of the day; input order is kept. */
export function groupByDayPart(
  entries: readonly ActivityEntry[],
  timeZone: string,
): ActivityGroup[] {
  const parts = entries.map((entry) => dayPartOf(entry.item.surfacedAt, timeZone));
  const starts = parts.flatMap((part, index) =>
    index === 0 || parts[index - 1] !== part ? [index] : [],
  );
  return starts.map((start, group) => ({
    part: parts[start],
    entries: entries.slice(start, starts[group + 1] ?? entries.length),
  }));
}

export type ActivityText = { labelKey: string } | { text: string };

const KNOWN_TOOLS: ReadonlySet<string> = new Set(KNOWN_TOOL_IDS);
const OBSERVED_TITLE = /^Email signal \(.*\)$/;

/**
 * The row's title. The receipt titles an executed action with its reasoning,
 * or — when it has none — with the tool id spelled with spaces; that one is
 * swapped for the tool's label. A mail only observed has a fixed server title.
 */
export function activityTitle(item: ReceiptItem): ActivityText {
  const title = item.title?.trim() ?? "";
  if (item.source === "PENDING_ACTION") {
    const tool = title.replace(/ /g, "_");
    if (KNOWN_TOOLS.has(tool)) return { labelKey: toolLabelKey(tool) };
  }
  if (OBSERVED_TITLE.test(title)) return { labelKey: "assistantHub.activity.observedTitle" };
  return { text: title };
}

/** The two reasons the server writes itself, in English. Everything else is the judge's own. */
const FIXED_REASONS: ReadonlyMap<string, string> = new Map([
  ["Auto-executed — low risk, pre-approved", "assistantHub.activity.reason.executed"],
  ["Observed in SHADOW mode — not surfaced yet", "assistantHub.activity.reason.observed"],
]);

export function activityReasonKey(reason: string | null): string | null {
  return reason ? (FIXED_REASONS.get(reason) ?? null) : null;
}

/** What kind of thing the row is about: its type when known, else its source. */
const TYPE_KEYS: ReadonlyMap<string, string> = new Map([
  ["COMMITMENT_DUE", "receipt.type.commitmentDue"],
  ["COMMITMENT_OVERDUE", "receipt.type.commitmentOverdue"],
  ["COMMITMENT_UNCONFIRMED", "receipt.type.commitmentUnconfirmed"],
  ["REPLY_NEEDED", "receipt.type.replyNeeded"],
  ["DEADLINE", "receipt.type.deadline"],
  ["AGENT_PROPOSAL", "receipt.type.agentProposal"],
  ["DECISION", "receipt.type.decision"],
]);

const SOURCE_KEYS: ReadonlyMap<string, string> = new Map([
  ["PENDING_ACTION", "receipt.source.pendingAction"],
  ["TASK", "receipt.source.task"],
  ["CALENDAR_EVENT", "receipt.source.calendarEvent"],
  ["NOTIFICATION", "receipt.source.notification"],
  ["COMMITMENT", "receipt.source.commitment"],
  ["EMAIL", "receipt.source.email"],
]);

/** i18n key of the row's subject label, or null when neither field is known. */
export function activitySubjectKey(item: ReceiptItem): string | null {
  return TYPE_KEYS.get(item.type) ?? SOURCE_KEYS.get(item.source) ?? null;
}
