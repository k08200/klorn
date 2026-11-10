/**
 * Today — the pure half: which attention items make the "Needs you now"
 * brief, the summary counts, the day's range in the user's zone and the next
 * event. No React, no DOM (model.test.ts pins it).
 */
import type { FirewallItem, FirewallResponse, LiveTier } from "@klorn/contract";
import type { CalendarEventWire, PendingActionWire } from "../../api/wire";

export const BRIEF_LIMIT = 3;
export const BRIEF_LANES = ["PUSH", "MEETING"] as const satisfies readonly LiveTier[];

export interface BriefItem {
  id: string;
  lane: (typeof BRIEF_LANES)[number];
  title: string;
  why: string | null;
  emailId: string | null;
}

function byPriority(a: FirewallItem, b: FirewallItem): number {
  return b.priority - a.priority || Date.parse(b.surfacedAt) - Date.parse(a.surfacedAt);
}

/** PUSH first, then MEETING, each by priority; at most `limit`. */
export function briefItems(firewall: FirewallResponse, limit = BRIEF_LIMIT): BriefItem[] {
  const out: BriefItem[] = [];
  for (const lane of BRIEF_LANES) {
    for (const item of [...(firewall.tiers[lane] ?? [])].sort(byPriority)) {
      out.push({
        id: item.id,
        lane,
        title: item.title || item.email?.subject || "",
        why: item.tierReason,
        emailId: item.email?.emailDbId ?? null,
      });
    }
  }
  return out.slice(0, limit);
}

/** Open items whose mail is judged to owe a reply (recorded fact, never a guess). */
export function repliesOwed(firewall: FirewallResponse): number {
  let n = 0;
  for (const items of Object.values(firewall.tiers)) {
    for (const item of items) if (item.email?.replyState === "needsReply") n++;
  }
  return n;
}

// ── Calendar ────────────────────────────────────────────────────────────────

interface ZoneClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zoneClock(date: Date, timeZone: string): ZoneClock {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function zoneOffsetMs(date: Date, timeZone: string): number {
  const c = zoneClock(date, timeZone);
  const asUtc = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

function zoneMidnight(year: number, month: number, day: number, timeZone: string): Date {
  const wall = Date.UTC(year, month - 1, day);
  const first = wall - zoneOffsetMs(new Date(wall), timeZone);
  return new Date(wall - zoneOffsetMs(new Date(first), timeZone));
}

export function isKnownZone(timeZone: string | undefined): timeZone is string {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Local midnight to the next local midnight in the zone (same rule as the web Today). */
export function dayRangeInZone(now: Date, timeZone: string): { start: Date; end: Date } {
  const zone = isKnownZone(timeZone) ? timeZone : "UTC";
  const { year, month, day } = zoneClock(now, zone);
  return {
    start: zoneMidnight(year, month, day, zone),
    end: zoneMidnight(year, month, day + 1, zone),
  };
}

/** Timed events that have not ended yet, by start. */
export function remainingEvents(
  events: readonly CalendarEventWire[],
  now: Date,
): CalendarEventWire[] {
  const at = now.getTime();
  return events
    .filter(
      (e) => !e.allDay && Date.parse(e.endTime) > at && !Number.isNaN(Date.parse(e.startTime)),
    )
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
}

export function nextEvent(
  events: readonly CalendarEventWire[],
  now: Date,
): CalendarEventWire | null {
  return remainingEvents(events, now)[0] ?? null;
}

export function isOngoing(event: CalendarEventWire, now: Date): boolean {
  return Date.parse(event.startTime) <= now.getTime() && Date.parse(event.endTime) > now.getTime();
}

/** The video service a meeting link points at, for the event's subtitle. */
export function meetingService(link: string | null | undefined): string | null {
  if (!link) return null;
  let host: string;
  try {
    host = new URL(link).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === "meet.google.com") return "Google Meet";
  if (host.endsWith("zoom.us")) return "Zoom";
  if (host.endsWith("teams.microsoft.com") || host.endsWith("teams.live.com"))
    return "Microsoft Teams";
  if (host.endsWith("webex.com")) return "Webex";
  return null;
}

// ── Approvals ───────────────────────────────────────────────────────────────

export type ApprovalKind = "email" | "calendar" | "other";

export function approvalKind(toolName: string): ApprovalKind {
  const name = toolName.toLowerCase();
  if (/(email|mail|reply|draft)/.test(name)) return "email";
  if (/(calendar|event|meeting|schedule)/.test(name)) return "calendar";
  return "other";
}

export function approvalSubtitle(action: PendingActionWire): string | null {
  return action.reasoning ?? action.conversationTitle ?? null;
}

// ── Avatar ──────────────────────────────────────────────────────────────────

export function initialsOf(
  name: string | null | undefined,
  email: string | null | undefined,
): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    const first = words[0]?.[0] ?? "";
    const last = words[words.length - 1]?.[0] ?? "";
    return `${first}${last}`.toUpperCase();
  }
  const one = words[0];
  if (one) {
    // A one-word CJK name (신지수) shows its given name — the last two characters; a Latin one its initial.
    return /^[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(one)
      ? [...one].slice(-2).join("")
      : (one[0] ?? "").toUpperCase();
  }
  return (email?.[0] ?? "?").toUpperCase();
}
