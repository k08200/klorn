/**
 * The one server-side gate for a calendar event's meeting link, whatever the
 * provider (Outlook joinUrl, Google conferenceData / hangoutLink, a link lifted
 * from an event description, or one sent to the create route).
 *
 * The rule itself is not about meetings, so it lives in safe-https-link.ts and a
 * drive file's link passes the same one. The names here are aliases: the same
 * function and the same cap.
 */

import { MAX_HTTPS_LINK_LENGTH, safeHttpsLink } from "../safe-https-link.js";

/** The longest meeting link kept; a longer value is not a join link, and every client shows it. */
export const MAX_MEETING_LINK_LENGTH = MAX_HTTPS_LINK_LENGTH;

/**
 * A meeting link that is safe to hand on: an https URL without embedded
 * credentials, of at most 2048 characters, returned normalised; anything else is
 * dropped (see `safeHttpsLink`).
 */
export const safeMeetingLink = safeHttpsLink;

const ZOOM_LINK_IN_TEXT = /https:\/\/(?:[a-z0-9-]+\.)*zoom\.us\/[^\s]*/i;
const MEET_LINK_IN_TEXT = /https:\/\/meet\.google\.com\/[^\s]*/;

/**
 * A Zoom or Meet link written in an event's description or location: the
 * links pim/meeting.ts getUpcomingMeetings finds beyond the conference data.
 * Shared so the proactive meeting heads-up can tell which synced rows the
 * meeting-start ring (background.ts) covers.
 */
export function meetingLinkInText(
  description: string | null | undefined,
  location: string | null | undefined,
): string | null {
  const text = `${description || ""} ${location || ""}`;
  return (
    safeMeetingLink(text.match(ZOOM_LINK_IN_TEXT)?.[0]) ??
    safeMeetingLink(text.match(MEET_LINK_IN_TEXT)?.[0])
  );
}
