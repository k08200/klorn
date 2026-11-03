/**
 * Writes of per-contact co-attendance (ContactCoAttendance) and of the meetings
 * already counted (CoAttendanceMeeting). The only place either table is written.
 *
 * Exactly once per meeting, without keeping who attended it. Meetings are written
 * one UTC end-day per transaction (planBatches): every meeting that ended on day D
 * goes in one transaction, so rows that share a transaction id (Postgres xmin)
 * reveal no more than lastMetAt, a day, already does. Only a day past a cap
 * (MEETINGS_PER_TRANSACTION meetings or CONTACTS_PER_TRANSACTION distinct
 * contacts) is split, across transactions in marker-key order. The transaction
 * first claims the batch's markers (INSERT ... ON CONFLICT DO NOTHING RETURNING,
 * through createManyAndReturn with skipDuplicates), then adds the meetings it
 * claimed, and only those, to each contact's counters. A meeting listed again by a
 * later pass, by another of the user's calendars, or by a concurrent pass (whose
 * insert waits on the unique index, then returns nothing) finds its marker and
 * counts nothing. A failed counter write rolls the batch's markers back with it,
 * so the next pass counts those meetings again rather than never.
 *
 * What is stored about a meeting: the hash of its identity and the UTC day it
 * ended, on the marker; on each contact's row, the UTC day of the first and the
 * last meeting. Nothing finer than a day, and no write time, so rows written
 * together do not line up into one meeting's guest list by time. Markers are
 * claimed in key order and contacts written in address order, so two concurrent
 * batches lock shared rows in the same order and cannot deadlock.
 *
 * Known limits: a meeting is counted as it was when first seen ended, so guests
 * added or removed afterwards are not recounted; it is counted again if its
 * identity changes (a new iCalUID: re-imported, recreated, or a recurring series
 * split at "this and following") or if its end moves to a day after its marker was
 * pruned.
 */

import { createHash } from "node:crypto";
import { INTERACTIVE_TX_OPTIONS, prisma } from "../../db.js";
import type { CalendarProviderName } from "../calendar-rows.js";
import { type CountedMeeting, normalizeAttendeeEmail, utcDayOf } from "./coattendance-rules.js";

/** Meetings per transaction: bounds how long one holds a pooled connection. */
export const MEETINGS_PER_TRANSACTION = 25;
/** Distinct contacts (one upsert each) per transaction, for the same reason. */
export const CONTACTS_PER_TRANSACTION = 200;

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

/** A meeting with its marker key, computed once. */
interface Keyed {
  readonly key: string;
  readonly meeting: CountedMeeting;
}

const byKey = (a: Keyed, b: Keyed) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * One batch per UTC end-day, days in order, each in marker-key order. A day is
 * split only when it would pass MEETINGS_PER_TRANSACTION meetings or
 * CONTACTS_PER_TRANSACTION distinct contacts; a batch never mixes days. One
 * meeting has at most MAX_COUNTED_ATTENDEES contacts, so it always fits alone.
 */
export function planBatches(meetings: readonly CountedMeeting[]): CountedMeeting[][] {
  const keyed = meetings.map((meeting) => ({
    key: eventKeyOf(meeting.identity),
    day: utcDayOf(meeting.endTime).getTime(),
    meeting,
  }));
  keyed.sort((a, b) => a.day - b.day || byKey(a, b));
  const batches: CountedMeeting[][] = [];
  let batch: CountedMeeting[] = [];
  let batchDay = Number.NaN;
  let contacts = new Set<string>();
  for (const { day, meeting } of keyed) {
    const widened = new Set([...contacts, ...meeting.contacts]);
    const full =
      day !== batchDay ||
      batch.length >= MEETINGS_PER_TRANSACTION ||
      widened.size > CONTACTS_PER_TRANSACTION;
    batchDay = day;
    if (full && batch.length > 0) {
      batches.push(batch);
      batch = [];
      contacts = new Set(meeting.contacts);
    } else {
      contacts = widened;
    }
    batch.push(meeting);
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
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
  // Key order: concurrent claims of overlapping batches wait on each other's
  // unique-index entries in one order, never in a cycle.
  const keyed = meetings
    .map((meeting) => ({ key: eventKeyOf(meeting.identity), meeting }))
    .sort(byKey);
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.coAttendanceMeeting.createManyAndReturn({
      data: keyed.map(({ key, meeting }) => ({
        userId,
        provider,
        eventKey: key,
        endedAt: utcDayOf(meeting.endTime),
      })),
      skipDuplicates: true,
      select: { eventKey: true },
    });
    const won = new Set(claimed.map((row) => row.eventKey));
    const counted = keyed.filter(({ key }) => won.has(key)).map(({ meeting }) => meeting);
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
  const unique = new Map(counted.map((meeting) => [eventKeyOf(meeting.identity), meeting]));
  const known = await alreadyCounted(provider, userId, [...unique.keys()]);
  const fresh = [...unique].filter(([key]) => !known.has(key)).map(([, meeting]) => meeting);
  let meetings = 0;
  const touched = new Set<string>();
  for (const batch of planBatches(fresh)) {
    const added = await claimBatch(provider, userId, batch);
    meetings += added.length;
    for (const meeting of added) for (const contact of meeting.contacts) touched.add(contact);
  }
  return { meetings, contacts: touched.size };
}

/**
 * Forget the markers whose day is before `before`. The caller passes the window's
 * start minus one day: a marker keeps only the day its meeting ended, and a
 * meeting still listed (it ends after the window's start) has a day no earlier
 * than one day before that start.
 */
export async function pruneCountedMeetings(userId: string, before: Date): Promise<number> {
  const { count } = await prisma.coAttendanceMeeting.deleteMany({
    where: { userId, endedAt: { lt: before } },
  });
  return count;
}
