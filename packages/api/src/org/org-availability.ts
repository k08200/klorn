/**
 * Organization free/busy (Klorn Teams launch feature 3, team-mode-v3.md):
 * the team scheduling assistant may use a co-member's busy times only while
 * that member has granted FREEBUSY to the SAME organization. Enforced here, at
 * the resolver every caller (route, chat tool) goes through, not at a route.
 *
 *   - Busy start and end times only: never a title, attendee, location or
 *     description (the select below names nothing else).
 *   - The grant is read on every query, so a revocation counts on the next one.
 *   - Every cross-member read is audited (requester, member, window).
 *   - A member of another organization is never read.
 */

import { teamsOpenTo } from "../config.js";
import { prisma } from "../db.js";
import { calendarSourceScope } from "../pim/calendar-scope.js";
import type { BusyInterval } from "../pim/slot-suggest.js";
import { OrgError } from "./org-error.js";
import { requireMembership } from "./org-members.js";
import { normalizeEmail } from "./org-shape.js";

const MAX_EVENTS = 2000;

/**
 * Busy blocks of the requester's co-members (by lowercase address) who share
 * free/busy with the requester's organization. Members without a grant are
 * absent from the map: their availability stays UNKNOWN.
 */
export async function grantedOrgFreeBusy(
  requesterId: string,
  emails: readonly string[],
  windowStart: Date,
  windowEnd: Date,
): Promise<Map<string, BusyInterval[]>> {
  const busy = new Map<string, BusyInterval[]>();
  if (emails.length === 0 || !teamsOpenTo(requesterId)) return busy;
  const mine = await prisma.orgMembership.findUnique({
    where: { userId: requesterId },
    select: { orgId: true },
  });
  if (!mine) return busy;

  const wanted = new Set(emails.map((email) => email.toLowerCase()));
  const [coMembers, grants] = await Promise.all([
    prisma.orgMembership.findMany({
      where: { orgId: mine.orgId, userId: { not: requesterId } },
      select: { userId: true, user: { select: { email: true } } },
    }),
    prisma.availabilityGrant.findMany({
      where: { orgId: mine.orgId, scope: "FREEBUSY", userId: { not: requesterId } },
      select: { userId: true },
    }),
  ]);
  const granted = new Set(grants.map((grant) => grant.userId));
  const readable = coMembers
    .filter((member) => granted.has(member.userId))
    .map((member) => ({ userId: member.userId, email: member.user.email.toLowerCase() }))
    .filter((member) => wanted.has(member.email));
  if (readable.length === 0) return busy;

  const events = await prisma.calendarEvent.findMany({
    where: {
      userId: { in: readable.map((member) => member.userId) },
      startTime: { lte: windowEnd },
      endTime: { gte: windowStart },
      ...calendarSourceScope(),
    },
    select: { userId: true, startTime: true, endTime: true },
    take: MAX_EVENTS,
  });
  await prisma.orgAuditEvent.createMany({
    data: readable.map((member) => ({
      orgId: mine.orgId,
      action: "availability.read",
      actorUserId: requesterId,
      targetUserId: member.userId,
      detail: { windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString() },
    })),
  });
  for (const member of readable) {
    busy.set(
      member.email,
      events
        .filter((event) => event.userId === member.userId)
        .map((event) => ({
          start: event.startTime.toISOString(),
          end: event.endTime.toISOString(),
        })),
    );
  }
  return busy;
}

/**
 * The addresses an org availability query covers: every co-member, or the
 * requested subset, each of whom must be a co-member.
 */
export async function orgAvailabilityMembers(
  userId: string,
  requested: string | undefined,
): Promise<string[]> {
  const mine = await requireMembership(userId);
  const coMembers = await prisma.orgMembership.findMany({
    where: { orgId: mine.orgId, userId: { not: userId } },
    orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
    select: { user: { select: { email: true } } },
  });
  const all = coMembers.map((member) => member.user.email.toLowerCase());
  if (requested === undefined || requested.trim() === "") return all;
  const picked = requested.split(",").map((raw) => normalizeEmail(raw));
  if (picked.some((email) => email === null || !all.includes(email))) {
    throw new OrgError(400, "NOT_A_MEMBER", "Pick members of your organization.");
  }
  return [...new Set(picked as string[])];
}
