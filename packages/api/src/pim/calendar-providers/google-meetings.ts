/**
 * The Google listing behind co-attendance counting (pim/coattendance/): its own
 * events.list over a PAST window, because the row sync lists only upcoming events
 * (Google's timeMin bounds an event's end). No new scope: events.list returns
 * attendees under calendar.events and calendar.readonly alike, which the primary
 * and every linked Google account already hold.
 *
 * Asked of Google, and nothing more:
 *   - `fields`: identity (id, iCalUID, originalStartTime), status, start, end,
 *     attendeesOmitted, and per attendee only email, self, organizer, resource and
 *     responseStatus. No title, description, location or conference data;
 *   - `eventTypes: ["default"]`: meetings, not working-location, focus-time,
 *     out-of-office or birthday entries, which would only fill the pages;
 *   - `maxAttendees`: past MAX_COUNTED_ATTENDEES Google returns only the user's own
 *     entry and sets attendeesOmitted, so a large meeting's guest list is never read;
 *   - `singleEvents`: each occurrence of a recurring meeting is its own meeting.
 * Paged up to MEETINGS_MAX_PAGES; more is reported as truncated. Each page waits at
 * most MEETINGS_TIMEOUT_MS and is never retried (the next pass is the retry).
 */

import type { calendar_v3 } from "googleapis";
import { MAX_COUNTED_ATTENDEES } from "../coattendance/coattendance-rules.js";
import type { CalendarWindow, MeetingAttendee, MeetingListing, ProviderMeeting } from "./types.js";

export const MEETINGS_PAGE_SIZE = 250;
export const MEETINGS_MAX_PAGES = 4;
export const MEETINGS_TIMEOUT_MS = 10_000;

const PRIMARY_CALENDAR_ID = "primary";
const MEETING_FIELDS =
  "nextPageToken,items(id,iCalUID,status,start,end,originalStartTime,attendeesOmitted,attendees(email,self,organizer,resource,responseStatus))";

function instantOf(value: string | null | undefined): Date | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** The original start as an instant, so two renderings (two zones) of one instance match. */
function originalStartKey(item: calendar_v3.Schema$Event): string {
  const original = item.originalStartTime;
  if (!original) return "";
  return instantOf(original.dateTime)?.toISOString() ?? original.date ?? "";
}

function identityOf(item: calendar_v3.Schema$Event): string {
  if (item.iCalUID) return `ical:${item.iCalUID}|${originalStartKey(item)}`;
  return item.id ? `id:${item.id}` : "";
}

function toAttendee(attendee: calendar_v3.Schema$EventAttendee): MeetingAttendee {
  return {
    email: attendee.email ?? "",
    self: attendee.self === true,
    organizer: attendee.organizer === true,
    resource: attendee.resource === true,
    responseStatus: attendee.responseStatus ?? null,
  };
}

function toMeeting(item: calendar_v3.Schema$Event): ProviderMeeting {
  return {
    identity: identityOf(item),
    cancelled: item.status === "cancelled",
    allDay: !item.start?.dateTime && Boolean(item.start?.date),
    startTime: instantOf(item.start?.dateTime),
    endTime: instantOf(item.end?.dateTime),
    attendeesOmitted: item.attendeesOmitted === true,
    attendees: (item.attendees ?? []).map(toAttendee),
  };
}

export async function listMeetingAttendeesVia(
  api: calendar_v3.Calendar,
  window: CalendarWindow,
): Promise<MeetingListing> {
  const meetings: ProviderMeeting[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MEETINGS_MAX_PAGES; page += 1) {
    const res = await api.events.list(
      {
        calendarId: PRIMARY_CALENDAR_ID,
        timeMin: window.timeMin,
        timeMax: window.timeMax,
        singleEvents: true,
        orderBy: "startTime",
        eventTypes: ["default"],
        maxAttendees: MAX_COUNTED_ATTENDEES,
        maxResults: MEETINGS_PAGE_SIZE,
        fields: MEETING_FIELDS,
        ...(pageToken ? { pageToken } : {}),
      },
      { timeout: MEETINGS_TIMEOUT_MS, retry: false },
    );
    for (const item of res.data.items ?? []) meetings.push(toMeeting(item));
    pageToken = res.data.nextPageToken ?? undefined;
    if (!pageToken) return { meetings, truncated: false };
  }
  return { meetings, truncated: true };
}
