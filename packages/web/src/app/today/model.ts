/**
 * Today home model (productization plan §1, P6, UNIFIED_HOME) — the pure half:
 * how a lane block is cut, the day's range in the user's zone, and the merged
 * calendar's order, conflicts and "now" marker. No React and no DOM, so the api vitest suite pins
 * it (packages/api/src/__tests__/web-today-model.test.ts).
 */

import type { InboxProvider } from "@klorn/contract";

/** Rows shown in an expanded lane (PUSH, MEETING) before "N more in Mail". */
export const EXPANDED_LANE_ROWS = 8;
/** QUEUE is a count plus its top rows (plan §1). */
export const QUEUE_LANE_ROWS = 5;

// ── Mail ────────────────────────────────────────────────────────────────────

/** The first `limit` rows of a lane, and how many more the lane holds. */
export function laneBlock<Row>(
  rows: readonly Row[],
  total: number,
  limit: number,
): { shown: Row[]; more: number } {
  const shown = rows.slice(0, limit);
  return { shown, more: Math.max(total, rows.length) - shown.length };
}

// ── Calendar ────────────────────────────────────────────────────────────────

/** The fields of GET /api/calendar's rows that Today reads. */
export interface CalendarEventWire {
  id: string;
  title: string;
  startTime: string;
  endTime: string;
  location: string | null;
  allDay: boolean;
  /** The calendar's own colour, when the provider recorded one. */
  color?: string | null;
  /** CalendarProvider on the row: GOOGLE, OUTLOOK, ICLOUD, NAVER, DEVICE, LOCAL. */
  provider?: string;
  /** The linked account's label, on a linked calendar's event only. */
  sourceLabel?: string;
}

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
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

const SECOND_MS = 1000;

/** The zone's offset from UTC at `date`, in milliseconds (east is positive). */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const c = zoneClock(date, timeZone);
  const asUtc = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
  return asUtc - Math.floor(date.getTime() / SECOND_MS) * SECOND_MS;
}

/** The instant the calendar day (year, month, day) begins in the zone. */
function zoneMidnight(year: number, month: number, day: number, timeZone: string): Date {
  const wallClock = Date.UTC(year, month - 1, day);
  const first = wallClock - zoneOffsetMs(new Date(wallClock), timeZone);
  // The offset was read a few hours away from the answer; across a clock
  // change it differs, so read it again at the answer itself.
  return new Date(wallClock - zoneOffsetMs(new Date(first), timeZone));
}

function isKnownZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Today in the user's zone: local midnight to the next local midnight (23 or
 * 25 hours on a clock-change day). An unknown zone reads as UTC.
 */
export function dayRangeInZone(now: Date, timeZone: string): { start: Date; end: Date } {
  const zone = isKnownZone(timeZone) ? timeZone : "UTC";
  const { year, month, day } = zoneClock(now, zone);
  return {
    start: zoneMidnight(year, month, day, zone),
    // Date.UTC rolls a day past the month's end into the next month.
    end: zoneMidnight(year, month, day + 1, zone),
  };
}

interface Span {
  start: number;
  end: number;
}

function spanOf(event: CalendarEventWire): Span | null {
  const start = new Date(event.startTime).getTime();
  const end = new Date(event.endTime).getTime();
  if (Number.isNaN(start)) return null;
  return { start, end: Number.isNaN(end) ? start : end };
}

/** All-day events first, then by start, then the shorter one first. */
export function orderEvents(events: readonly CalendarEventWire[]): CalendarEventWire[] {
  return events
    .flatMap((event) => {
      const span = spanOf(event);
      return span ? [{ event, span }] : [];
    })
    .sort(
      (a, b) =>
        Number(b.event.allDay) - Number(a.event.allDay) ||
        a.span.start - b.span.start ||
        a.span.end - b.span.end,
    )
    .map(({ event }) => event);
}

/**
 * Ids of timed events that overlap another timed event. Back-to-back meetings
 * do not overlap; all-day events never conflict (a holiday is not a clash).
 */
export function findConflicts(events: readonly CalendarEventWire[]): Set<string> {
  const timed = events
    .flatMap((event) => {
      const span = event.allDay ? null : spanOf(event);
      return span && span.end > span.start ? [{ id: event.id, ...span }] : [];
    })
    .sort((a, b) => a.start - b.start);
  const conflicts = new Set<string>();
  // Sweep in start order, remembering the event that ends last so far: a long
  // meeting conflicts with everything that starts before it ends.
  let latest: (typeof timed)[number] | null = null;
  for (const current of timed) {
    if (latest && current.start < latest.end) {
      conflicts.add(latest.id);
      conflicts.add(current.id);
    }
    if (!latest || current.end > latest.end) latest = current;
  }
  return conflicts;
}

export type EventPhase = "allDay" | "past" | "now" | "upcoming";

export function eventPhase(event: CalendarEventWire, now: Date): EventPhase {
  if (event.allDay) return "allDay";
  const span = spanOf(event);
  const at = now.getTime();
  if (!span || span.end <= at) return "past";
  return span.start <= at ? "now" : "upcoming";
}

/**
 * Where the "now" marker goes in an ordered list: before the first timed
 * event that has not ended (so it sits above a running meeting), or at the end
 * once the day is done. Null when the day has no timed events to place it in.
 */
export function nowMarkerIndex(ordered: readonly CalendarEventWire[], now: Date): number | null {
  if (!ordered.some((event) => !event.allDay)) return null;
  const index = ordered.findIndex((event) => {
    const phase = eventPhase(event, now);
    return phase === "now" || phase === "upcoming";
  });
  return index === -1 ? ordered.length : index;
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** A calendar colour safe to put in a style attribute; null for anything else. */
export function eventBarColor(color: string | null | undefined): string | null {
  return color && HEX_COLOR.test(color) ? color : null;
}

/** The calendar providers that are an account a SourceBadge can name. */
const ACCOUNT_CALENDAR_PROVIDERS: readonly InboxProvider[] = [
  "GOOGLE",
  "OUTLOOK",
  "ICLOUD",
  "NAVER",
];

/**
 * The provider to badge an event with. A device calendar or a local event is
 * not an account, so it gets no SourceBadge (its label, if any, still shows).
 */
export function eventSourceProvider(provider: string | undefined): InboxProvider | null {
  return ACCOUNT_CALENDAR_PROVIDERS.find((known) => known === provider) ?? null;
}
