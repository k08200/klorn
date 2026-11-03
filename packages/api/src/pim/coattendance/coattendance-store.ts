/**
 * Writes of per-contact co-attendance (ContactCoAttendance) and of the meetings
 * already counted (CoAttendanceMeeting). The only place either table is written.
 *
 * One UTC end-day per transaction (planBatches). The pass (coattendance-sync.ts)
 * hands over every meeting of a day from all of the user's Google calendars at
 * once, and a day is evaluated only once (the user's watermark). So the rows that
 * share a Postgres transaction id (xmin) are one whole day's contacts, which each
 * row's lastMetAt (the same end-day) already says. What xmin can still reveal:
 * only a day over a cap (MEETINGS_PER_TRANSACTION meetings or
 * CONTACTS_PER_TRANSACTION distinct contacts) is split, into the fewest balanced
 * slices in marker-key order (a 26-meeting day is 13 + 13), so each part is a
 * key-ordered slice of that day, never one meeting alone.
 *
 * Every day transaction takes a per-user advisory lock and re-reads the day's
 * markers under it: a one-slice day that has any marker is complete (it committed
 * whole) and is skipped; a split day writes only the meetings not yet marked, so a
 * pass that died between slices, or a second process, resumes it without counting
 * anything twice and without losing the rest of the day.
 *
 * Exactly once per meeting. The transaction first claims the batch's markers
 * (INSERT ... ON CONFLICT DO NOTHING RETURNING, through createManyAndReturn with
 * skipDuplicates), then adds the meetings it claimed, and only those, to each
 * contact's counters. A meeting in two of the user's calendars, or claimed by a
 * concurrent pass, finds its marker and counts nothing. A failed counter write
 * rolls the batch back with it.
 *
 * What is stored about a meeting: the hash of its identity and the UTC day it
 * ended, on the marker; on each contact's row, the UTC end-day of the first and
 * the last meeting. Nothing finer than a day, and no write time. Markers are
 * claimed in key order and contacts written in address order, so two concurrent
 * batches lock shared rows in the same order and cannot deadlock.
 *
 * Known limits: a meeting is counted as it was when its day was evaluated, so a
 * late accept or guest change after that is never counted; it is counted again if
 * its identity changes (a new iCalUID: re-imported, recreated, or a recurring
 * series split at "this and following") within days not yet evaluated.
 */

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
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

/** Rows of one day split into balanced slices, each within both caps. */
function sliceDay(day: readonly Keyed[]): Keyed[][] {
  const contactsOf = (slice: readonly Keyed[]) =>
    new Set(slice.flatMap(({ meeting }) => meeting.contacts)).size;
  const fits = (slice: readonly Keyed[]) =>
    slice.length <= MEETINGS_PER_TRANSACTION && contactsOf(slice) <= CONTACTS_PER_TRANSACTION;
  const n = day.length;
  const fewest = Math.max(
    1,
    Math.ceil(n / MEETINGS_PER_TRANSACTION),
    Math.ceil(contactsOf(day) / CONTACTS_PER_TRANSACTION),
  );
  for (let parts = fewest; parts <= n; parts += 1) {
    const size = Math.ceil(n / parts);
    const slices: Keyed[][] = [];
    for (let at = 0; at < n; at += size) slices.push(day.slice(at, at + size));
    if (slices.every(fits)) return slices;
  }
  return day.map((one) => [one]);
}

interface DayPlan {
  /** The UTC end-day, as epoch milliseconds. */
  readonly day: number;
  readonly slices: Keyed[][];
}

/**
 * One plan per UTC end-day, days in order, each day's meetings in marker-key order
 * (one meeting once). A day within both caps is one slice. A day over a cap is
 * split into the fewest balanced slices that fit (ceil(n / parts) meetings each,
 * more parts only when a slice would pass the contact cap), so a 26-meeting day is
 * 13 + 13, never 25 + 1 with a lone meeting in a transaction of its own.
 */
function planDays(meetings: readonly CountedMeeting[]): DayPlan[] {
  const byDay = new Map<number, Map<string, Keyed>>();
  for (const meeting of meetings) {
    const day = utcDayOf(meeting.endTime).getTime();
    const key = eventKeyOf(meeting.identity);
    const keyed = byDay.get(day) ?? new Map<string, Keyed>();
    keyed.set(key, { key, meeting });
    byDay.set(day, keyed);
  }
  return [...byDay]
    .sort(([a], [b]) => a - b)
    .map(([day, keyed]) => ({ day, slices: sliceDay([...keyed.values()].sort(byKey)) }));
}

/** The transactions recordCountedMeetings writes, in order: each a slice of one day. */
export function planBatches(meetings: readonly CountedMeeting[]): CountedMeeting[][] {
  return planDays(meetings).flatMap(({ slices }) =>
    slices.map((slice) => slice.map(({ meeting }) => meeting)),
  );
}

/** Per contact: meetings, small meetings, first and last day, in address order. */
function tallyByContact(meetings: readonly CountedMeeting[]): Array<[string, ContactTally]> {
  const tallies = new Map<string, ContactTally>();
  for (const meeting of meetings) {
    // The END day, the day the meeting is batched by: a row's first and last met
    // then never name a different day from the transaction that wrote it.
    const day = utcDayOf(meeting.endTime);
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

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * pg_advisory_xact_lock(class, key): one user's day transactions run one at a
 * time across processes, and a transaction re-reads its day's markers under the
 * lock. The two-int form has its own key space, apart from the scheduler's
 * single-key lock.
 */
const COATTENDANCE_LOCK_CLASS = 0x0c0a7;

function lockUser(tx: Tx, userId: string) {
  return tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(${COATTENDANCE_LOCK_CLASS}::int, hashtext(${userId}))`,
  );
}

/** Claim the slice's markers and count the meetings this call claimed (inside `tx`). */
async function writeSlice(
  tx: Tx,
  provider: CalendarProviderName,
  userId: string,
  slice: readonly Keyed[],
): Promise<CountedMeeting[]> {
  // Key order: concurrent claims wait on each other's index entries in one order.
  const keyed = [...slice].sort(byKey);
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
}

/**
 * Claim and count a set of meetings in one transaction, with no day rules: what one
 * committed slice does. Answers how many it counted (0 when every marker existed).
 */
export function claimAndCount(
  provider: CalendarProviderName,
  userId: string,
  meetings: readonly CountedMeeting[],
): Promise<number> {
  const keyed = meetings.map((meeting) => ({ key: eventKeyOf(meeting.identity), meeting }));
  return prisma.$transaction(async (tx) => {
    await lockUser(tx, userId);
    return (await writeSlice(tx, provider, userId, keyed)).length;
  }, INTERACTIVE_TX_OPTIONS);
}

/**
 * Write one slice of a day, under the user's lock, after re-reading the day's
 * markers (rule b):
 *   - a one-slice day that has any marker is complete (its one transaction
 *     committed whole), so nothing is written;
 *   - a split day writes only the slice's meetings not yet marked, so a pass that
 *     died after some slices, or another process that wrote some meanwhile, is
 *     resumed, never repeated.
 */
function writeDaySlice(
  provider: CalendarProviderName,
  userId: string,
  plan: DayPlan,
  slice: readonly Keyed[],
): Promise<CountedMeeting[]> {
  return prisma.$transaction(async (tx) => {
    await lockUser(tx, userId);
    const markers = await tx.coAttendanceMeeting.findMany({
      where: { userId, provider, endedAt: new Date(plan.day) },
      select: { eventKey: true },
    });
    const marked = new Set(markers.map((row) => row.eventKey));
    if (marked.size > 0 && plan.slices.length === 1) return [];
    const todo = slice.filter(({ key }) => !marked.has(key));
    return todo.length === 0 ? [] : writeSlice(tx, provider, userId, todo);
  }, INTERACTIVE_TX_OPTIONS);
}

/**
 * Count the meetings of the days handed in: each UTC end-day in one transaction,
 * or, for a day over a cap, its balanced slices in key order (planBatches). Days
 * at or before the watermark are never handed in (the pass). Throws on a write
 * failure (that slice is rolled back; earlier ones stay, and are resumed past).
 */
export async function recordCountedMeetings(
  provider: CalendarProviderName,
  userId: string,
  counted: readonly CountedMeeting[],
): Promise<RecordResult> {
  let meetings = 0;
  const touched = new Set<string>();
  for (const plan of planDays(counted)) {
    for (const slice of plan.slices) {
      const added = await writeDaySlice(provider, userId, plan, slice);
      meetings += added.length;
      for (const meeting of added) for (const contact of meeting.contacts) touched.add(contact);
    }
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
