/**
 * The one calendar read path (step C7 of docs/providers/unified-platform-plan.md).
 *
 * Since C2 one event can be several CalendarEvent rows: the same invite in the
 * primary and in a linked calendar, and later one per connector. A reader that
 * lists or counts events must (1) apply the kill switch (`calendarSourceScope()`,
 * linked rows are invisible while the linked sync is off), (2) show an invite once
 * (`dedupeCalendarEvents`) and (3) apply any cap AFTER the dedupe, or copies spend
 * it. This module does all three, so a caller states only the time window. The
 * `where` is composed here, after the caller's predicate, so a caller can neither
 * forget the scope nor widen the user.
 *
 * With the linked sync off no linked row is visible, nothing can be a copy, and
 * the queries are the ones the readers always ran: a count stays a database
 * count and a cap stays a database `take`. Rows are fetched and merged only once
 * copies can exist. They are bounded by the sync itself (30 days, 100 events per
 * calendar), so a read without a `take` stays small.
 */

import type { Prisma } from "@prisma/client";
import { linkedCalendarSyncEnabled } from "../config.js";
import { prisma } from "../db.js";
import { dedupeCalendarEvents } from "./calendar-dedupe.js";
import { calendarSourceScope } from "./calendar-scope.js";

/** One event as the readers need it; `provider` and `sourceAccountId` say where it lives. */
export interface CalendarReadRow {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly location: string | null;
  readonly startTime: Date;
  readonly endTime: Date;
  readonly allDay: boolean;
  readonly provider: string;
  readonly externalId: string | null;
  readonly sourceAccountId: string | null;
}

export interface CalendarReadQuery {
  readonly userId: string;
  /** The time predicate (startTime / endTime / allDay). The user and the scope are added here. */
  readonly when: Prisma.CalendarEventWhereInput;
  /** Applied after the dedupe. */
  readonly limit?: number;
}

const ROW_SELECT = {
  id: true,
  title: true,
  description: true,
  location: true,
  startTime: true,
  endTime: true,
  allDay: true,
  provider: true,
  externalId: true,
  sourceAccountId: true,
} as const;

/** The fields the dedupe keys on; all a count needs. */
const IDENTITY_SELECT = { provider: true, externalId: true, sourceAccountId: true } as const;

/** Events matching `when`, earliest first, each invite once (the primary copy wins). */
export async function readCalendarRows(query: CalendarReadQuery): Promise<CalendarReadRow[]> {
  const { userId, when, limit } = query;
  // A cap before the dedupe would let copies spend it, so the database caps the
  // query only while no linked row can be visible (what the readers always did).
  const dbTake = limit !== undefined && !linkedCalendarSyncEnabled() ? limit : undefined;
  const rows = await prisma.calendarEvent.findMany({
    where: { ...when, userId, ...calendarSourceScope() },
    orderBy: { startTime: "asc" },
    select: ROW_SELECT,
    take: dbTake,
  });
  const events = dedupeCalendarEvents(rows);
  return limit === undefined ? events : events.slice(0, limit);
}

/** How many events match `when`, each invite counted once. */
export async function countCalendarRows(query: Omit<CalendarReadQuery, "limit">): Promise<number> {
  const { userId, when } = query;
  if (!linkedCalendarSyncEnabled()) {
    return prisma.calendarEvent.count({ where: { ...when, userId, ...calendarSourceScope() } });
  }
  const rows = await prisma.calendarEvent.findMany({
    where: { ...when, userId, ...calendarSourceScope() },
    select: IDENTITY_SELECT,
  });
  return dedupeCalendarEvents(rows).length;
}

/** The next `limit` events that have not ended at `now` (what `list_events` asks). */
export function readUpcomingEvents(
  userId: string,
  limit: number,
  now: Date,
): Promise<CalendarReadRow[]> {
  return readCalendarRows({ userId, when: { endTime: { gt: now } }, limit });
}

/**
 * Timed events overlapping [start, end). All-day rows are left out on purpose:
 * Google's free/busy (which the conflict check still asks) treats an all-day
 * marker such as a birthday or a holiday as free time, and a row does not record
 * transparency, so counting it would refuse bookings free/busy would allow.
 */
export function readOverlappingTimedEvents(
  userId: string,
  window: { readonly start: Date; readonly end: Date },
): Promise<CalendarReadRow[]> {
  return readCalendarRows({
    userId,
    when: {
      startTime: { lt: window.end },
      endTime: { gt: window.start },
      allDay: false,
    },
  });
}
