/**
 * Which ended meetings count toward per-contact co-attendance, and for whom.
 * Pure: the listing is pim/calendar-providers/google-meetings.ts, the writes
 * coattendance-store.ts. Founder decision 2026-11-01: counts only, never an
 * attendee list. The rules:
 *   - the meeting has ended (its end is at or before now), is not cancelled, has an
 *     identity and timed start and end;
 *   - not all day: an all-day event with guests is mostly a notice (out of office, a
 *     deadline, a holiday, travel), not time spent together, and counting it would
 *     inflate "met";
 *   - the guest list is complete: the provider did not omit attendees, and there are
 *     at most MAX_COUNTED_ATTENDEES people invited. A larger meeting (an all-hands, a
 *     webinar) says little about any one guest, and Google returns only the user's
 *     own entry past the listing's cap anyway, so it counts nothing;
 *   - the user did not decline: every entry of theirs (the calendar owner's `self`
 *     entry, or any of their known addresses) is `declined` means they did not go;
 *   - a contact is a person (rooms and other resources never count), not the user,
 *     with a plain address, who did not decline. Tentative and unanswered count: a
 *     calendar records invitations, not who walked in.
 * A meeting is small when at most SMALL_MEETING_MAX_PEOPLE people attended (the
 * user plus the counted contacts): audience size dominates how much a shared
 * meeting says about a relationship (Karagiannis & Vojnović 2009), so it is kept as
 * a raw count of its own, never as a weight.
 */

import { isPlainAddress } from "../../mail/email-address.js";
import type { MeetingAttendee, ProviderMeeting } from "../calendar-providers/types.js";

/** At most this many people (the user included) make a small meeting. */
export const SMALL_MEETING_MAX_PEOPLE = 5;
/** Invitees (rooms excluded) past which a meeting counts nothing; also Google's maxAttendees. */
export const MAX_COUNTED_ATTENDEES = 50;
/** RFC 5321's limit on a forward path, the longest address worth keeping. */
const MAX_ADDRESS_LENGTH = 254;

export interface CountedMeeting {
  readonly identity: string;
  readonly startTime: Date;
  readonly endTime: Date;
  /** Normalised addresses of the contacts who attended with the user, each once. */
  readonly contacts: readonly string[];
  readonly small: boolean;
}

/** The trimmed, lower-cased address, or null when it is not one plain address. */
export function normalizeAttendeeEmail(raw: string): string | null {
  const address = raw.trim().toLowerCase();
  if (address.length === 0 || address.length > MAX_ADDRESS_LENGTH) return null;
  return isPlainAddress(address) ? address : null;
}

function isCountableEvent(meeting: ProviderMeeting, now: Date): boolean {
  if (!meeting.identity || meeting.cancelled || meeting.allDay) return false;
  if (!meeting.startTime || !meeting.endTime) return false;
  if (meeting.endTime.getTime() > now.getTime()) return false;
  return !meeting.attendeesOmitted;
}

function isOwn(attendee: MeetingAttendee, ownAddresses: ReadonlySet<string>): boolean {
  if (attendee.self) return true;
  const address = normalizeAttendeeEmail(attendee.email);
  return address !== null && ownAddresses.has(address);
}

const declined = (attendee: MeetingAttendee) => attendee.responseStatus === "declined";

/** The contacts an ended meeting counts for, or null when it counts for no one. */
export function countMeeting(
  meeting: ProviderMeeting,
  ownAddresses: ReadonlySet<string>,
  now: Date,
): CountedMeeting | null {
  if (!isCountableEvent(meeting, now) || !meeting.startTime || !meeting.endTime) return null;
  const people = meeting.attendees.filter((attendee) => !attendee.resource);
  if (people.length > MAX_COUNTED_ATTENDEES) return null;

  const mine = people.filter((attendee) => isOwn(attendee, ownAddresses));
  if (mine.length > 0 && mine.every(declined)) return null;

  const contacts = new Set<string>();
  for (const attendee of people) {
    if (declined(attendee) || isOwn(attendee, ownAddresses)) continue;
    const address = normalizeAttendeeEmail(attendee.email);
    if (address !== null) contacts.add(address);
  }
  if (contacts.size === 0) return null;

  return {
    identity: meeting.identity,
    startTime: meeting.startTime,
    endTime: meeting.endTime,
    contacts: [...contacts],
    small: contacts.size + 1 <= SMALL_MEETING_MAX_PEOPLE,
  };
}
