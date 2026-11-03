/**
 * Writes of per-contact co-attendance (ContactCoAttendance) and of the meetings
 * already counted (CoAttendanceMeeting). The only place either table is written.
 *
 * Exactly once per meeting, without keeping who attended it: a meeting is counted
 * in one transaction that first claims its marker (INSERT ... ON CONFLICT DO
 * NOTHING through createMany's skipDuplicates) and only then, if the claim
 * inserted the row, adds one to each contact's counters. A meeting listed again by
 * a later pass, by another of the user's calendars, or by a concurrent pass (whose
 * insert waits on the unique index and then inserts nothing) finds its marker and
 * counts nothing. A failed counter write rolls the marker back with it, so the
 * next pass counts that meeting again rather than never. The marker holds a hash
 * of the meeting's identity and its end, never an attendee.
 *
 * Known limit: a meeting is counted as it was when first seen ended; attendees
 * added or removed afterwards are not recounted.
 */

import { createHash } from "node:crypto";
import { INTERACTIVE_TX_OPTIONS, prisma } from "../../db.js";
import type { CalendarProviderName } from "../calendar-rows.js";
import { type CountedMeeting, normalizeAttendeeEmail } from "./coattendance-rules.js";

export interface RecordResult {
  /** Meetings counted by this call (not already counted before). */
  readonly meetings: number;
  /** Distinct contacts whose counters those meetings moved. */
  readonly contacts: number;
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

/** Claim one meeting's marker and, if this call inserted it, count it. True when counted. */
export function claimAndCount(
  provider: CalendarProviderName,
  userId: string,
  meeting: CountedMeeting,
): Promise<boolean> {
  const metAt = meeting.startTime;
  const contacts = [...meeting.contacts];
  return prisma.$transaction(async (tx) => {
    const claim = await tx.coAttendanceMeeting.createMany({
      data: [
        { userId, provider, eventKey: eventKeyOf(meeting.identity), endedAt: meeting.endTime },
      ],
      skipDuplicates: true,
    });
    if (claim.count === 0) return false;
    for (const contactEmail of contacts) {
      await tx.contactCoAttendance.upsert({
        where: { userId_contactEmail: { userId, contactEmail } },
        create: {
          userId,
          contactEmail,
          meetingCount: 1,
          smallMeetingCount: meeting.small ? 1 : 0,
          firstMetAt: metAt,
          lastMetAt: metAt,
        },
        update: {
          meetingCount: { increment: 1 },
          smallMeetingCount: { increment: meeting.small ? 1 : 0 },
        },
      });
    }
    // Conditional, so a concurrent writer can only move first earlier and last later.
    await tx.contactCoAttendance.updateMany({
      where: { userId, contactEmail: { in: contacts }, firstMetAt: { gt: metAt } },
      data: { firstMetAt: metAt },
    });
    await tx.contactCoAttendance.updateMany({
      where: { userId, contactEmail: { in: contacts }, lastMetAt: { lt: metAt } },
      data: { lastMetAt: metAt },
    });
    return true;
  }, INTERACTIVE_TX_OPTIONS);
}

/** The meetings among `counted` whose marker already exists (one read for the whole pass). */
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
 * one read; each remaining one is claimed and counted in its own transaction, so a
 * concurrent pass that got there first is still safe. Throws on a write failure
 * (the meeting being written is rolled back; earlier ones stay counted).
 */
export async function recordCountedMeetings(
  provider: CalendarProviderName,
  userId: string,
  counted: readonly CountedMeeting[],
): Promise<RecordResult> {
  const byKey = new Map(counted.map((meeting) => [eventKeyOf(meeting.identity), meeting]));
  const known = await alreadyCounted(provider, userId, [...byKey.keys()]);
  const touched = new Set<string>();
  let meetings = 0;
  for (const [key, meeting] of byKey) {
    if (known.has(key)) continue;
    if (!(await claimAndCount(provider, userId, meeting))) continue;
    meetings += 1;
    for (const contact of meeting.contacts) touched.add(contact);
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
