/**
 * The meeting start ring's fallback (background.ts, T-5): the meetings it
 * would have read from Google, taken from the user's stored calendar rows when
 * the live listing failed.
 *
 * The T-60 heads-up leaves every primary-calendar meeting with a video link to
 * the start ring (agentcore/meeting-start-ring.ts), so when the start ring's
 * Google read fails on every tick of its 5-minute window (an outage, a refresh
 * that keeps failing) the meeting had no alert at all. The stored row is what
 * the heads-up itself trusts, and the start ring dedupes by the same Google
 * event id ([id] marker on its bell row), so a later live read that does
 * succeed cannot ring the meeting again.
 *
 * Rows read: the primary Google calendar (no linked account; an external id),
 * timed, starting inside the window, with a join link pim/meeting.ts would find
 * (meeting-start-ring.ts ringsAtStart) — minus any meeting whose heads-up
 * already rang (its bell key `meeting-prep:<rowId>:<startMs>`), so one meeting
 * still gets one alert.
 */

import { ringsAtStart } from "../agentcore/meeting-start-ring.js";
import { prisma } from "../db.js";
import { calendarSourceScope } from "./calendar-scope.js";
import { meetingLinkInText } from "./meeting-link.js";

/** How far ahead the start ring announces a meeting (background.ts). */
export const START_RING_WINDOW_MINUTES = 5;
const MS_PER_MINUTE = 60_000;
/** Rows read at most: a 5-minute window holds a handful. */
const STORED_SCAN = 20;
/** The heads-up's bell dedupe key prefix (agentcore/proactive-actions.ts). */
const MEETING_PREP_KEY_PREFIX = "meeting-prep:";

export interface StoredMeeting {
  id: string;
  summary: string;
  start: string;
  end: string;
  meetingLink: string | null;
  attendees: string[];
  attendeeCount: number | null;
}

export async function storedStartRingMeetings(userId: string, now: Date): Promise<StoredMeeting[]> {
  const rows = await prisma.calendarEvent.findMany({
    where: {
      userId,
      provider: "GOOGLE",
      sourceAccountId: null,
      externalId: { not: null },
      allDay: false,
      startTime: {
        gt: now,
        lte: new Date(now.getTime() + START_RING_WINDOW_MINUTES * MS_PER_MINUTE),
      },
      AND: [calendarSourceScope()],
    },
    select: {
      id: true,
      googleId: true,
      externalId: true,
      sourceAccountId: true,
      title: true,
      startTime: true,
      endTime: true,
      meetingLink: true,
      description: true,
      location: true,
      attendeeCount: true,
    },
    orderBy: [{ startTime: "asc" }, { id: "asc" }],
    take: STORED_SCAN,
  });
  const withLink = rows.filter(ringsAtStart);
  if (withLink.length === 0) return [];
  const keyOf = (row: { id: string; startTime: Date }) =>
    `${MEETING_PREP_KEY_PREFIX}${row.id}:${row.startTime.getTime()}`;
  // A dedupe look-back: a heads-up row the user cleared still counts as rung.
  const rung = await prisma.notification.findMany({
    where: { userId, dedupeKey: { in: withLink.map(keyOf) } },
    select: { dedupeKey: true },
  });
  const rungKeys = new Set(rung.map((row) => row.dedupeKey));
  return withLink
    .filter((row) => !rungKeys.has(keyOf(row)))
    .map((row) => ({
      id: row.googleId ?? row.externalId ?? row.id,
      summary: row.title || "Untitled Meeting",
      start: row.startTime.toISOString(),
      end: row.endTime.toISOString(),
      meetingLink: row.meetingLink ?? meetingLinkInText(row.description, row.location),
      attendees: [],
      attendeeCount: row.attendeeCount,
    }));
}
