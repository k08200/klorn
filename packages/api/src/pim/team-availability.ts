/**
 * Team availability — "when is the whole team free" (team mode P1).
 *
 * Given a member list and a window, intersect the USER's calendar with every
 * VISIBLE member's free/busy and return the first common slots (business
 * hours, weekdays, half-hour grid — shared walk with the alternative-slot
 * suggester). Visibility is honest: a member whose calendar the user cannot
 * see is reported in `unknownMembers`, never silently treated as free —
 * a silent unknown is a double-booking waiting to happen.
 */

import { prisma } from "../db.js";
import { normalizeMembers } from "../routes/teams.js";
import { normalizeTimeZone } from "../time-zone.js";
import { getAttendeeBusyByMember } from "./calendar.js";
import { calendarSourceScope } from "./calendar-scope.js";
import { type BusyInterval, findFreeSlots, type SuggestedSlot } from "./slot-suggest.js";

export interface TeamAvailability {
  slots: SuggestedSlot[];
  /** Members whose free/busy was actually checked. */
  checkedMembers: string[];
  /** Members whose calendars the user cannot see — availability UNKNOWN. */
  unknownMembers: string[];
  timeZone: string;
}

const MAX_MEMBERS = 30;
const MAX_SLOTS = 5;
const DEFAULT_DURATION_MINUTES = 60;
const MAX_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export async function getTeamAvailability(
  userId: string,
  members: string[],
  windowStartIso: string,
  windowEndIso: string,
  durationMinutes: number = DEFAULT_DURATION_MINUTES,
): Promise<TeamAvailability | { error: string }> {
  // Same strict validation as saved teams (security review 2026-08-20,
  // MEDIUM): the ad-hoc path must not accept looser inputs than /api/teams —
  // free/busy probing with arbitrary strings starts here.
  const emails = normalizeMembers(members);
  if (!emails) return { error: `members must be 1–${MAX_MEMBERS} valid email addresses.` };
  if (emails.length > MAX_MEMBERS) return { error: `Too many members (max ${MAX_MEMBERS}).` };

  const start = Date.parse(windowStartIso);
  const end = Date.parse(windowEndIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return { error: "window_start / window_end must be valid ISO instants with end after start." };
  }
  if (end - start > MAX_WINDOW_MS) {
    return { error: "Window too large — 14 days maximum." };
  }

  const config = await prisma.automationConfig.findUnique({
    where: { userId },
    select: { timezone: true },
  });
  const timeZone = normalizeTimeZone(config?.timezone);

  const [myEvents, memberBusy] = await Promise.all([
    prisma.calendarEvent.findMany({
      where: {
        userId,
        startTime: { lte: new Date(end) },
        endTime: { gte: new Date(start) },
        ...calendarSourceScope(),
      },
      select: { startTime: true, endTime: true },
      take: 500,
    }),
    getAttendeeBusyByMember(
      userId,
      emails,
      new Date(start).toISOString(),
      new Date(end).toISOString(),
    ),
  ]);

  const checkedMembers = memberBusy.filter((m) => m.blocks !== null).map((m) => m.email);
  const unknownMembers = memberBusy.filter((m) => m.blocks === null).map((m) => m.email);

  const busy: BusyInterval[] = [
    ...myEvents.map((e) => ({ start: e.startTime.toISOString(), end: e.endTime.toISOString() })),
    ...memberBusy.flatMap((m) => m.blocks ?? []),
  ];

  const slots = findFreeSlots({
    windowStart: new Date(start).toISOString(),
    windowEnd: new Date(end).toISOString(),
    durationMs: Math.max(1, durationMinutes) * 60 * 1000,
    busy,
    timeZone,
    maxSlots: MAX_SLOTS,
  });

  return { slots, checkedMembers, unknownMembers, timeZone };
}
