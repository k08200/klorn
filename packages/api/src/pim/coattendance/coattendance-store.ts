/**
 * Writes of per-contact co-attendance (ContactCoAttendance) and of the meetings
 * already counted (CoAttendanceMeeting). The only place either table is written.
 *
 * Exactly once per meeting, without keeping who attended it. Meetings are written
 * in batches of MEETINGS_PER_TRANSACTION, one transaction each. The transaction
 * first claims the batch's markers (INSERT ... ON CONFLICT DO NOTHING RETURNING,
 * through createManyAndReturn with skipDuplicates), then adds the meetings it
 * claimed, and only those, to each contact's counters. A meeting listed again by a
 * later pass, by another of the user's calendars, or by a concurrent pass (whose
 * insert waits on the unique index, then returns nothing) finds its marker and
 * counts nothing. A failed counter write rolls the batch's markers back with it,
 * so the next pass counts those meetings again rather than never.
 *
 * What is stored about a meeting: the hash of its identity and its end, on the
 * marker; on each contact's row, the day (UTC) of the first and the last meeting,
 * never an instant, so rows written together do not line up into one meeting's
 * guest list by time. Contacts are written in address order, so two concurrent
 * batches lock shared rows in the same order and cannot deadlock.
 *
 * Known limit: a meeting is counted as it was when first seen ended; guests added
 * or removed afterwards are not recounted.
 */

import { createHash } from "node:crypto";
import { INTERACTIVE_TX_OPTIONS, prisma } from "../../db.js";
import type { CalendarProviderName } from "../calendar-rows.js";
import { type CountedMeeting, normalizeAttendeeEmail } from "./coattendance-rules.js";

/** Meetings per transaction: bounds how long one holds a pooled connection. */
export const MEETINGS_PER_TRANSACTION = 25;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RecordResult {
  /** Meetings counted by this call (not already counted before). */
  readonly meetings: number;
  /** Distinct contacts whose counters those meetings moved. */
  readonly contacts: number;
}

interface ContactTally {
  meetings: number;
  small: number;
  firstDay: Date;
  lastDay: Date;
}

/** The marker key: SHA-256 (hex) of the meeting's identity, never the identity itself. */
export function eventKeyOf(identity: string): string {
  return createHash("sha256").update(identity).digest("hex");
}

/** The start of the instant's UTC day. */
export function utcDayOf(instant: Date): Date {
  return new Date(Math.floor(instant.getTime() / DAY_MS) * DAY_MS);
}

/**
 * Every address of the user Klorn knows: the account, the primary Google login, and
 * each linked calendar and inbox. Excluded from counting alongside the calendar
 * owner's own (`self`) entry.
 */
export async function loadOwnAddresses(userId: string): Promise<Set<string>> {
  const [user, tokens, calendars, inboxes] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
    prisma.userToken.findMany({ where: { userId }, select: { googleEmail: true } }),
    prisma.linkedCalendarAccount.findMany({ where: { userId }, select: { email: true } }),
    prisma.linkedInboxAccount.findMany({ where: { userId }, select: { email: true } }),
  ]);
  const raw = [
    user?.email,
    ...tokens.map((token) => token.googleEmail),
    ...calendars.map((account) => account.email),
    ...inboxes.map((account) => account.email),
  ];
  const own = new Set<string>();
  for (const value of raw) {
    const address = value ? normalizeAttendeeEmail(value) : null;
    if (address) own.add(address);
  }
  return own;
}

/** Per contact: meetings, small meetings, first and last day, in address order. */
function tallyByContact(meetings: readonly CountedMeeting[]): Array<[string, ContactTally]> {
  const tallies = new Map<string, ContactTally>();
  for (const meeting of meetings) {
    const day = utcDayOf(meeting.startTime);
    for (const contact of meeting.contacts) {
      const tally = tallies.get(contact);
      if (!tally) {
        tallies.set(contact, {
          meetings: 1,
          small: meeting.small ? 1 : 0,
          firstDay: day,
          lastDay: day,
        });
        continue;
      }
      tally.meetings += 1;
      tally.small += meeting.small ? 1 : 0;
      if (day < tally.firstDay) tally.firstDay = day;
      if (day > tally.lastDay) tally.lastDay = day;
    }
  }
  return [...tallies].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Claim a batch of meetings' markers and count the ones this call claimed.
 * Answers how many it counted (0 when every marker already existed).
 */
export async function claimAndCount(
  provider: CalendarProviderName,
  userId: string,
  meetings: readonly CountedMeeting[],
): Promise<number> {
  return (await claimBatch(provider, userId, meetings)).length;
}

/** claimAndCount's work: answers the meetings this call counted. */
function claimBatch(
  provider: CalendarProviderName,
  userId: string,
  meetings: readonly CountedMeeting[],
): Promise<CountedMeeting[]> {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.coAttendanceMeeting.createManyAndReturn({
      data: meetings.map((meeting) => ({
        userId,
        provider,
        eventKey: eventKeyOf(meeting.identity),
        endedAt: meeting.endTime,
      })),
      skipDuplicates: true,
      select: { eventKey: true },
    });
    const won = new Set(claimed.map((row) => row.eventKey));
    const counted = meetings.filter((meeting) => won.has(eventKeyOf(meeting.identity)));
    for (const [contactEmail, tally] of tallyByContact(counted)) {
      const row = await tx.contactCoAttendance.upsert({
        where: { userId_contactEmail: { userId, contactEmail } },
        create: {
          userId,
          contactEmail,
          meetingCount: tally.meetings,
          smallMeetingCount: tally.small,
          firstMetAt: tally.firstDay,
          lastMetAt: tally.lastDay,
        },
        update: {
          meetingCount: { increment: tally.meetings },
          smallMeetingCount: { increment: tally.small },
        },
        select: { firstMetAt: true, lastMetAt: true },
      });
      // The upsert holds the row's lock until commit, so widening from what it
      // returned cannot lose a concurrent writer's earlier or later day.
      if (row.firstMetAt <= tally.firstDay && row.lastMetAt >= tally.lastDay) continue;
      await tx.contactCoAttendance.update({
        where: { userId_contactEmail: { userId, contactEmail } },
        data: {
          firstMetAt: row.firstMetAt < tally.firstDay ? row.firstMetAt : tally.firstDay,
          lastMetAt: row.lastMetAt > tally.lastDay ? row.lastMetAt : tally.lastDay,
        },
      });
    }
    return counted;
  }, INTERACTIVE_TX_OPTIONS);
}

/** The keys among `keys` whose marker already exists (one read for the whole pass). */
async function alreadyCounted(
  provider: CalendarProviderName,
  userId: string,
  keys: readonly string[],
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await prisma.coAttendanceMeeting.findMany({
    where: { userId, provider, eventKey: { in: [...keys] } },
    select: { eventKey: true },
  });
  return new Set(rows.map((row) => row.eventKey));
}

/**
 * Count the meetings not counted before. Meetings already marked are skipped with
 * one read; the rest are claimed and counted batch by batch, so a concurrent pass
 * that got there first is still safe. Throws on a write failure (that batch is
 * rolled back; earlier batches stay counted).
 */
export async function recordCountedMeetings(
  provider: CalendarProviderName,
  userId: string,
  counted: readonly CountedMeeting[],
): Promise<RecordResult> {
  const byKey = new Map(counted.map((meeting) => [eventKeyOf(meeting.identity), meeting]));
  const known = await alreadyCounted(provider, userId, [...byKey.keys()]);
  const fresh = [...byKey].filter(([key]) => !known.has(key)).map(([, meeting]) => meeting);
  let meetings = 0;
  const touched = new Set<string>();
  for (let start = 0; start < fresh.length; start += MEETINGS_PER_TRANSACTION) {
    const batch = fresh.slice(start, start + MEETINGS_PER_TRANSACTION);
    const added = await claimBatch(provider, userId, batch);
    meetings += added.length;
    for (const meeting of added) for (const contact of meeting.contacts) touched.add(contact);
  }
  return { meetings, contacts: touched.size };
}

/** Forget the markers of meetings that ended before `before`: no pass can list them again. */
export async function pruneCountedMeetings(userId: string, before: Date): Promise<number> {
  const { count } = await prisma.coAttendanceMeeting.deleteMany({
    where: { userId, endedAt: { lt: before } },
  });
  return count;
}
