/**
 * GOOGLE implementation of CalendarProviderActions: every googleapis calendar
 * call the app makes lives in this file. The bodies are the ones that used to
 * sit in `pim/calendar.ts` and the three sync sites, moved without a behaviour
 * change for the primary calendar.
 *
 * Linked Google accounts reuse the same session over their own OAuth client.
 * They hold the `calendar.readonly` scope only, so a write through one is
 * refused by Google itself; nothing here adds a scope.
 */

import { type calendar_v3, google } from "googleapis";
import {
  type CalendarConflictItem,
  calendarLabelMap,
  mapGoogleEventTimes,
  selectFreeBusyCalendarIds,
  summarizeConflicts,
  summarizeFreeBusy,
} from "../../google-calendar-time.js";
import { getAuthedClient, getLinkedCalendarClients } from "../../mail/gmail.js";
import { captureError } from "../../sentry.js";
import type {
  CalendarAccountRef,
  CalendarCreateInput,
  CalendarEventPatch,
  CalendarEventWritten,
  CalendarListQuery,
  CalendarProviderActions,
  CalendarSession,
  CalendarWindow,
  PersonFreeBusy,
  ProviderCalendarEvent,
} from "./types.js";

type GoogleAuth = InstanceType<typeof google.auth.OAuth2>;

const PRIMARY_CALENDAR_ID = "primary";
/** One `calendarList.list` page is enough: a user writes to far fewer than 250 calendars. */
const CALENDAR_LIST_PAGE_SIZE = 250;

/**
 * The start/end Google wants for an event. Timed events carry the user's
 * IANA zone so a naive dateTime is read in THEIR wall clock (#676). All-day
 * events are DATES (end exclusive, Google's contract) - the date is read
 * off the string, never off an instant, so "2026-08-01T00:00:00Z" and
 * "2026-08-01T00:00:00+09:00" both mean August 1st. Pure, exported for
 * its tests.
 */
export function googleEventTimes(input: {
  startTime: string;
  endTime: string;
  allDay: boolean;
  timeZone: string;
}): { start: calendar_v3.Schema$EventDateTime; end: calendar_v3.Schema$EventDateTime } {
  if (input.allDay) {
    return {
      start: { date: input.startTime.slice(0, 10) },
      end: { date: input.endTime.slice(0, 10) },
    };
  }
  return {
    start: { dateTime: input.startTime, timeZone: input.timeZone },
    end: { dateTime: input.endTime, timeZone: input.timeZone },
  };
}

function meetingLinkOf(item: calendar_v3.Schema$Event): string | null {
  let meetingLink: string | null = null;
  if (item.conferenceData?.entryPoints) {
    const video = item.conferenceData.entryPoints.find((e) => e.entryPointType === "video");
    if (video) meetingLink = video.uri || null;
  }
  if (!meetingLink && item.hangoutLink) meetingLink = item.hangoutLink;
  return meetingLink;
}

function toProviderEvent(
  item: calendar_v3.Schema$Event,
  timeZone: string | undefined,
): ProviderCalendarEvent {
  const times = timeZone ? mapGoogleEventTimes(item, timeZone) : null;
  return {
    externalId: item.id || "",
    summary: item.summary || null,
    description: item.description || null,
    location: item.location || null,
    meetingLink: meetingLinkOf(item),
    start: item.start?.dateTime || item.start?.date || "",
    end: item.end?.dateTime || item.end?.date || "",
    allDay: !item.start?.dateTime,
    startTime: times?.startTime ?? null,
    endTime: times?.endTime ?? null,
  };
}

function canonicalTimes(data: calendar_v3.Schema$Event) {
  return {
    canonicalStart: data.start?.dateTime ?? data.start?.date ?? null,
    canonicalEnd: data.end?.dateTime ?? data.end?.date ?? null,
  };
}

/** Free/busy across every calendar the account writes to - one query covers the
 *  work / shared / secondary calendars a primary-only check structurally misses. */
async function freeBusyAcrossCalendars(calendar: calendar_v3.Calendar, window: CalendarWindow) {
  const list = await calendar.calendarList.list({
    maxResults: CALENDAR_LIST_PAGE_SIZE,
    minAccessRole: "writer",
  });
  const ids = selectFreeBusyCalendarIds(list.data.items);
  if (ids.length === 0) return [];
  const fb = await calendar.freebusy.query({
    requestBody: {
      timeMin: window.timeMin,
      timeMax: window.timeMax,
      items: ids.map((id) => ({ id })),
    },
  });
  const calendars = fb.data.calendars ?? {};

  // freebusy reports per-calendar failures inline (not as an HTTP error): a
  // calendar the token can't read returns { errors:[...] } with empty busy. If
  // we ignored it, that calendar would look free - a silent false "no conflict".
  // Surface it so the gap is visible instead of becoming a missed double-book.
  const failed = Object.entries(calendars).filter(([, c]) => (c?.errors?.length ?? 0) > 0);
  if (failed.length > 0) {
    const reasons = failed.map(([id, c]) => `${id}:${c?.errors?.[0]?.reason ?? "unknown"}`);
    console.warn(`[CALENDAR] freebusy partial — ${failed.length} calendar(s) failed: ${reasons}`);
    captureError(new Error("freebusy partial result"), {
      tags: { scope: "calendar.freebusy_partial" },
      extra: { failedCount: failed.length, reasons },
    });
  }

  return summarizeFreeBusy(calendars, calendarLabelMap(list.data.items));
}

function visibleBlocks(cal: calendar_v3.Schema$FreeBusyCalendar | undefined) {
  if (!cal || (cal.errors?.length ?? 0) > 0) return null;
  const blocks: Array<{ start: string; end: string }> = [];
  for (const b of cal.busy ?? []) {
    if (b.start && b.end) blocks.push({ start: b.start, end: b.end });
  }
  return blocks;
}

async function listEventsVia(
  api: calendar_v3.Calendar,
  query: CalendarListQuery,
): Promise<ProviderCalendarEvent[]> {
  const res = await api.events.list({
    calendarId: PRIMARY_CALENDAR_ID,
    timeMin: query.timeMin,
    ...(query.timeMax ? { timeMax: query.timeMax } : {}),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: query.maxResults,
    ...(query.timeZone ? { timeZone: query.timeZone } : {}),
  });
  return (res.data.items || []).map((item) => toProviderEvent(item, query.timeZone));
}

async function createEventVia(
  api: calendar_v3.Calendar,
  input: CalendarCreateInput,
): Promise<CalendarEventWritten> {
  const attendees = input.attendees ?? [];
  const res = await api.events.insert({
    calendarId: PRIMARY_CALENDAR_ID,
    requestBody: {
      summary: input.summary,
      description: input.description || "",
      location: input.location || "",
      ...googleEventTimes({
        startTime: input.startTime,
        endTime: input.endTime,
        allDay: input.allDay,
        timeZone: input.timeZone,
      }),
      ...(attendees.length > 0 ? { attendees: attendees.map((email) => ({ email })) } : {}),
    },
    // Invitations go out only when the human-approved draft carries
    // attendees (team mode P2) - the assistant's tool path never passes them.
    ...(attendees.length > 0 ? { sendUpdates: "all" as const } : {}),
  });
  // Canonical timestamps come back from Google's response - these are the
  // values Google actually stored, after applying its own offset/timeZone
  // resolution rules (the 2026-06-04 +13h shift bug).
  return { eventId: res.data.id, htmlLink: res.data.htmlLink, ...canonicalTimes(res.data) };
}

async function updateEventVia(
  api: calendar_v3.Calendar,
  eventId: string,
  patch: CalendarEventPatch,
): Promise<CalendarEventWritten> {
  const requestBody: calendar_v3.Schema$Event = {
    ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
    ...(patch.description !== undefined ? { description: patch.description ?? "" } : {}),
    ...(patch.location !== undefined ? { location: patch.location ?? "" } : {}),
    ...(patch.startTime && patch.endTime
      ? googleEventTimes({
          startTime: patch.startTime,
          endTime: patch.endTime,
          allDay: patch.allDay ?? false,
          timeZone: patch.timeZone,
        })
      : {}),
  };
  const res = await api.events.patch({ calendarId: PRIMARY_CALENDAR_ID, eventId, requestBody });
  return canonicalTimes(res.data);
}

/** Primary-only busy blocks (events.list) for tokens that lack calendar.readonly.
 *  Still timezone-correct and all-day-safe - just blind to other calendars. */
async function primaryBusyVia(api: calendar_v3.Calendar, window: CalendarWindow) {
  const res = await api.events.list({
    calendarId: PRIMARY_CALENDAR_ID,
    timeMin: window.timeMin,
    timeMax: window.timeMax,
    singleEvents: true,
    orderBy: "startTime",
  });
  return summarizeConflicts((res.data.items as CalendarConflictItem[]) || []);
}

async function peopleFreeBusyVia(
  api: calendar_v3.Calendar,
  emails: readonly string[],
  window: CalendarWindow,
): Promise<PersonFreeBusy[]> {
  const fb = await api.freebusy.query({
    requestBody: {
      timeMin: window.timeMin,
      timeMax: window.timeMax,
      items: emails.map((id) => ({ id })),
    },
  });
  const calendars = fb.data.calendars ?? {};
  return emails.map((email) => ({ email, blocks: visibleBlocks(calendars[email]) }));
}

/** A session over one already-resolved OAuth client. */
export function googleSessionFromClient(auth: GoogleAuth): CalendarSession {
  // Built per call, not once: constructing the API object is cheap, and it keeps
  // the moment of construction where it always was (after the caller's own
  // validation), which characterisation tests can observe.
  const api = () => google.calendar({ version: "v3", auth });

  return {
    provider: "GOOGLE",
    listEvents: (query) => listEventsVia(api(), query),
    createEvent: (input) => createEventVia(api(), input),
    updateEvent: (eventId, patch) => updateEventVia(api(), eventId, patch),
    deleteEvent: async (eventId) => {
      await api().events.delete({ calendarId: PRIMARY_CALENDAR_ID, eventId });
    },
    busyBlocks: (window) => freeBusyAcrossCalendars(api(), window),
    primaryBusyBlocks: (window) => primaryBusyVia(api(), window),
    peopleFreeBusy: (emails, window) => peopleFreeBusyVia(api(), emails, window),
  };
}

async function resolveClient(account: CalendarAccountRef): Promise<GoogleAuth | null> {
  if (account.linkedAccountId === null) return getAuthedClient(account.userId);
  const linked = await getLinkedCalendarClients(account.userId);
  return linked.find((entry) => entry.id === account.linkedAccountId)?.client ?? null;
}

export const googleCalendarActions: CalendarProviderActions = {
  provider: "GOOGLE",
  async connect(account) {
    const auth = await resolveClient(account);
    return auth ? googleSessionFromClient(auth) : null;
  },
};
