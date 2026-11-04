/**
 * Past calendar co-attendance for the relationship snapshot: the reader's gate
 * over the co-attendance store (pim/coattendance/, #1604). Contract: doc §3(2),
 * "The reader's gate (P2's contract)".
 *
 * A missing ContactCoAttendance row means 0 meetings only when ALL of these hold;
 * otherwise every co-attendance field is null (unknown), and so is a row that
 * exists, because its counts may be incomplete:
 *   1. CALENDAR_COATTENDANCE_ENABLED is on;
 *   2. the watermark User.coAttendanceCountedThrough is at least utcDay(now) − 2;
 *   3. the user has a Google calendar source, and EVERY one (the primary UserToken,
 *      each GOOGLE LinkedCalendarAccount: the store's own readCoverage) has
 *      coAttendanceObservedSince at most utcDay(now) − 30, full-window coverage;
 *   4. no Google source awaits a reconnect;
 *   5. the user has no calendar source the store does not count (a
 *      LinkedCalendarAccount of any other provider);
 *   6. the sender is not one of the user's own addresses and the store can
 *      normalise its address.
 *
 * Freshness is the watermark's (2), never a source's coAttendanceLastPassAt: a
 * failing source freezes the watermark while the others' pass times stay fresh.
 */

import { calendarCoattendanceEnabled } from "../../config.js";
import { prisma } from "../../db.js";
import { normalizeAttendeeEmail, utcDayOf } from "../../pim/coattendance/coattendance-rules.js";
import { type Coverage, readCoverage } from "../../pim/coattendance/coattendance-sources.js";
import { COATTENDANCE_LOOKBACK_DAYS } from "../../pim/coattendance/coattendance-sync.js";
import type { CoAttendanceView } from "./relationship.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Condition 2: the watermark may trail today's UTC day by at most this many days. */
export const COATTENDANCE_MAX_WATERMARK_LAG_DAYS = 2;
/** Condition 3: every source must have been observed at least this many days ago. */
export const COATTENDANCE_FULL_WINDOW_DAYS = COATTENDANCE_LOOKBACK_DAYS;

export interface CoAttendanceCoverage extends Coverage {
  /** The user has a calendar source the store does not count (Outlook, CalDAV, device). */
  readonly hasNonGoogleSource: boolean;
}

export type CoAttendanceRow = NonNullable<CoAttendanceView["row"]>;

export interface CoAttendanceDeps {
  /** The watermark and the user's calendar sources. */
  coAttendanceCoverage(userId: string): Promise<CoAttendanceCoverage>;
  /** The stored counts for one normalised address; null = no row. */
  coAttendanceRow(userId: string, contactEmail: string): Promise<CoAttendanceRow | null>;
}

const daysBefore = (day: Date, n: number) => new Date(day.getTime() - n * DAY_MS);

/**
 * Conditions 2-5: the window the counts cover, [latest observedSince across the
 * Google sources, watermark], when a missing row means 0; null otherwise.
 */
export function coAttendanceWindow(
  coverage: CoAttendanceCoverage,
  now: Date,
): Omit<CoAttendanceView, "row"> | null {
  const today = utcDayOf(now);
  const { countedThrough, sources } = coverage;
  if (!countedThrough) return null;
  if (countedThrough < daysBefore(today, COATTENDANCE_MAX_WATERMARK_LAG_DAYS)) return null;
  if (coverage.hasNonGoogleSource || sources.length === 0) return null;
  const fullWindowStart = daysBefore(today, COATTENDANCE_FULL_WINDOW_DAYS);
  const observed: Date[] = [];
  for (const source of sources) {
    const since = source.observedSince;
    if (source.needsReconnect || !since || since > fullWindowStart) return null;
    observed.push(since);
  }
  const latest = Math.max(...observed.map((d) => d.getTime()));
  return { observedSince: new Date(latest), countedThrough };
}

/** Condition 6: the store counts this address (never the user's own, always normalised). */
export function isCountableContact(address: string, userAddresses: readonly string[]): boolean {
  if (normalizeAttendeeEmail(address) !== address) return false;
  return !userAddresses.some((own) => own.trim().toLowerCase() === address);
}

/** The sender's co-attendance; undefined = unknown (the gate failed). */
export async function loadCoAttendance(
  deps: CoAttendanceDeps,
  userId: string,
  sender: string,
  userAddresses: readonly string[],
  now: Date,
): Promise<CoAttendanceView | undefined> {
  if (!calendarCoattendanceEnabled()) return undefined;
  if (!isCountableContact(sender, userAddresses)) return undefined;
  const window = coAttendanceWindow(await deps.coAttendanceCoverage(userId), now);
  if (!window) return undefined;
  return { ...window, row: await deps.coAttendanceRow(userId, sender) };
}

export async function readCoAttendanceCoverage(userId: string): Promise<CoAttendanceCoverage> {
  const [coverage, other] = await Promise.all([
    readCoverage(userId),
    prisma.linkedCalendarAccount.findFirst({
      where: { userId, provider: { not: "GOOGLE" } },
      select: { id: true },
    }),
  ]);
  return { ...coverage, hasNonGoogleSource: other !== null };
}

export function readCoAttendanceRow(
  userId: string,
  contactEmail: string,
): Promise<CoAttendanceRow | null> {
  return prisma.contactCoAttendance.findUnique({
    where: { userId_contactEmail: { userId, contactEmail } },
    select: { meetingCount: true, smallMeetingCount: true, lastMetAt: true },
  });
}
