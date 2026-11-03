/**
 * Which ended meetings count toward per-contact co-attendance, and for whom.
 * Pure: the listing is pim/calendar-providers/google-meetings.ts, the writes
 * coattendance-store.ts. Founder decision 2026-11-01: counts only, never an
 * attendee list. The rules:
 *   - the meeting's whole UTC end-day has finished (its end is before today's UTC
 *     midnight), so a day's meetings are always counted together, in one
 *     transaction (coattendance-store.ts): rows written together then reveal no
 *     more than the day each row's lastMetAt already gives. A meeting ending today
 *     is counted at the first pass tomorrow. It is not cancelled, and has an
 *     identity and a timed start and end;
 *   - not all day: an all-day event with guests is mostly a notice (out of office, a
 *     deadline, a holiday, travel), not time spent together, and counting it would
 *     inflate "met";
 *   - the guest list is complete: the provider did not omit attendees, and there are
 *     at most MAX_COUNTED_ATTENDEES people invited. A larger meeting (an all-hands, a
 *     webinar) says little about any one guest, and Google returns only the user's
 *     own entry past the listing's cap anyway, so it counts nothing;
 *   - the user took part: one of their entries (the calendar owner's `self` entry,
 *     or any of their known addresses) organised it, accepted or is tentative. An
 *     invitation the user never answered does not count: anyone can put one on a
 *     calendar (Google adds invitations from anyone by default), so it is no
 *     evidence of a meeting and would let a stranger raise a count. An event with
 *     no entry of theirs counts only if the calendar says they organised it
 *     (Google's organizer.self); an imported or stranger-made event without their
 *     entry counts nothing;
 *   - a contact is a person (rooms and other resources never count), not the user,
 *     with a plain ASCII address, who did not decline. A contact's tentative or
 *     unanswered invitation counts: few guests answer, and the user's own answer
 *     already says the meeting happened.
 * A meeting is small when at most SMALL_MEETING_MAX_PEOPLE people took part (the
 * user plus the counted contacts; declined guests and rooms are not people present): audience size dominates how much a shared
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
const DAY_MS = 24 * 60 * 60 * 1000;

/** The start of the instant's UTC day. */
export function utcDayOf(instant: Date): Date {
  return new Date(Math.floor(instant.getTime() / DAY_MS) * DAY_MS);
}

export interface CountedMeeting {
  readonly identity: string;
  readonly startTime: Date;
  readonly endTime: Date;
  /** Normalised addresses of the contacts who attended with the user, each once. */
  readonly contacts: readonly string[];
  readonly small: boolean;
}

/** Printable ASCII only: the table's CHECK compares this lower-casing with Postgres's. */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

/** The trimmed, lower-cased address, or null when it is not one plain ASCII address. */
export function normalizeAttendeeEmail(raw: string): string | null {
  const address = raw.trim().toLowerCase();
  if (address.length === 0 || address.length > MAX_ADDRESS_LENGTH) return null;
  return PRINTABLE_ASCII.test(address) && isPlainAddress(address) ? address : null;
}

function isCountableEvent(meeting: ProviderMeeting, now: Date): boolean {
  if (!meeting.identity || meeting.cancelled || meeting.allDay) return false;
  if (!meeting.startTime || !meeting.endTime) return false;
  if (meeting.endTime.getTime() >= utcDayOf(now).getTime()) return false;
  return !meeting.attendeesOmitted;
}

function isOwn(attendee: MeetingAttendee, ownAddresses: ReadonlySet<string>): boolean {
  if (attendee.self) return true;
  const address = normalizeAttendeeEmail(attendee.email);
  return address !== null && ownAddresses.has(address);
}

const declined = (attendee: MeetingAttendee) => attendee.responseStatus === "declined";
const tookPart = (attendee: MeetingAttendee) =>
  attendee.organizer ||
  attendee.responseStatus === "accepted" ||
  attendee.responseStatus === "tentative";

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
  const userTookPart = mine.length > 0 ? mine.some(tookPart) : meeting.organizedBySelf;
  if (!userTookPart) return null;

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
