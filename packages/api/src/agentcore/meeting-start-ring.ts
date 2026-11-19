/**
 * Which meetings background.ts's start ring announces (NT0 item 11: one
 * meeting, one notification). That ring (T-5, interrupt bucket, with the join
 * link) reads the user's primary Google calendar live and rings each meeting
 * with a video link. The proactive heads-up (T-60, proactive-actions.ts) leaves
 * those meetings — and any linked-calendar copy of them — to it.
 */

import { prisma } from "../db.js";
import { meetingLinkInText } from "../pim/meeting-link.js";
import { isBackgroundAgentsDisabled } from "../scheduler-heartbeat.js";

/**
 * Whether the start ring will run for this user: background agents on, the
 * user's meetingAutoJoin not off, and a Google login token it can use until
 * `startsBy` — a refresh token, or an access token that has not expired by
 * then. A token mail/gmail.ts invalidated (blanked) or that will lapse cannot
 * reach Google, so the start ring would ring nothing and the heads-up stays.
 */
export async function meetingStartRingCovers(userId: string, startsBy: Date): Promise<boolean> {
  if (isBackgroundAgentsDisabled()) return false;
  const [token, config] = await Promise.all([
    prisma.userToken.findFirst({
      where: { userId, provider: "google" },
      select: { accessToken: true, refreshToken: true, expiresAt: true },
    }),
    prisma.automationConfig.findUnique({ where: { userId }, select: { meetingAutoJoin: true } }),
  ]);
  if (config !== null && config.meetingAutoJoin === false) return false;
  if (!token) return false;
  if (token.refreshToken) return true;
  return Boolean(token.accessToken) && (!token.expiresAt || token.expiresAt > startsBy);
}

interface MeetingRow {
  title: string;
  startTime: Date;
  externalId: string | null;
  sourceAccountId: string | null;
  meetingLink: string | null;
  description: string | null;
  location: string | null;
}

/**
 * A primary-calendar event with a link pim/meeting.ts would find. Primary = no
 * linked account and an external id (a LOCAL row has none); the primary
 * calendar is the Google login calendar.
 */
export function ringsAtStart(event: MeetingRow): boolean {
  if (event.sourceAccountId !== null || !event.externalId) return false;
  return Boolean(event.meetingLink || meetingLinkInText(event.description, event.location));
}

/** One meeting across calendars: an invite copied into another provider has another id, not another title or start. */
function twinKey(event: MeetingRow): string {
  return `${event.title.trim().toLowerCase()}\u0000${event.startTime.getTime()}`;
}

/**
 * The events the heads-up leaves to the start ring: the rows it rings, and
 * every row of the batch with the same title and start (a linked-calendar copy
 * of the same meeting, which calendar-dedupe cannot pair across providers).
 */
export function leftToStartRing<T extends MeetingRow>(
  events: readonly T[],
  covers: boolean,
): Set<T> {
  if (!covers) return new Set();
  const twins = new Set(events.filter(ringsAtStart).map(twinKey));
  return new Set(events.filter((event) => twins.has(twinKey(event))));
}
