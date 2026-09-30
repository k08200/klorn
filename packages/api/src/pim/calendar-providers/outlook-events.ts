/**
 * Reading events from an Outlook calendar (step C4): GET /me/calendarView with
 * paging, zone handling, all-day events and cancelled events left out.
 * https://learn.microsoft.com/graph/api/calendar-list-calendarview
 *
 * calendarView expands a recurring series into its occurrences (a series master
 * is never returned), which is the same shape Google's `singleEvents: true`
 * gives the Google sync. Paging follows `@odata.nextLink`:
 * https://learn.microsoft.com/graph/paging
 */

import { hasExplicitOffset, naiveLocalToUtc } from "../../google-calendar-time.js";
import { GRAPH_BASE_URL, graphRequest, nextLinkOf } from "./outlook-graph.js";
import type { CalendarListQuery, ProviderCalendarEvent } from "./types.js";

const CALENDAR_VIEW_URL = `${GRAPH_BASE_URL}/me/calendarView`;
const CALENDAR_VIEW_SELECT =
  "id,subject,bodyPreview,isAllDay,isCancelled,showAs,start,end,location,onlineMeeting,onlineMeetingUrl";
/** calendarView's `$top` ceiling (minimum 1, maximum 1000). */
const MAX_PAGE_SIZE = 1000;
/** Pages read for one listing: a server that never ends must not loop the sync forever. */
const MAX_PAGES = 10;
/** calendarView needs both ends of a window; an open-ended query gets this many days. */
const OPEN_ENDED_WINDOW_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/** Graph's dateTimeTimeZone: a naive wall-clock time plus the zone it is in. */
export interface GraphDateTimeZone {
  readonly dateTime?: string | null;
  readonly timeZone?: string | null;
}

/** The slice of a Graph event this provider reads (see CALENDAR_VIEW_SELECT). */
export interface GraphEvent {
  readonly id?: string | null;
  readonly subject?: string | null;
  readonly bodyPreview?: string | null;
  readonly isAllDay?: boolean | null;
  readonly isCancelled?: boolean | null;
  readonly showAs?: string | null;
  readonly start?: GraphDateTimeZone | null;
  readonly end?: GraphDateTimeZone | null;
  readonly location?: { readonly displayName?: string | null } | null;
  readonly onlineMeeting?: { readonly joinUrl?: string | null } | null;
  readonly onlineMeetingUrl?: string | null;
}

interface GraphEventPage {
  readonly value?: readonly GraphEvent[];
  readonly "@odata.nextLink"?: unknown;
}

function calendarViewUrl(query: CalendarListQuery): string {
  const timeMax =
    query.timeMax ??
    new Date(Date.parse(query.timeMin) + OPEN_ENDED_WINDOW_DAYS * DAY_MS).toISOString();
  const top = Math.min(query.maxResults, MAX_PAGE_SIZE);
  // `$` stays literal in the names: Graph documents them that way, and the
  // values are the only part that needs encoding.
  return (
    `${CALENDAR_VIEW_URL}?startDateTime=${encodeURIComponent(query.timeMin)}` +
    `&endDateTime=${encodeURIComponent(timeMax)}` +
    `&$top=${top}&$orderby=start/dateTime&$select=${CALENDAR_VIEW_SELECT}`
  );
}

/**
 * The raw events of the window in start order, cancelled ones left out (they are
 * not counted toward `maxResults` either), at most `maxResults` of them.
 * `timeZone` is the zone Graph renders times in (UTC when absent).
 */
export async function listCalendarView(
  token: string,
  query: CalendarListQuery,
): Promise<GraphEvent[]> {
  const events: GraphEvent[] = [];
  let url: string | null = calendarViewUrl(query);
  for (let page = 0; url !== null && page < MAX_PAGES; page += 1) {
    const body: GraphEventPage = await graphRequest<GraphEventPage>(token, url, {
      method: "GET",
      timeZone: query.timeZone,
    });
    for (const item of body.value ?? []) {
      if (item.isCancelled === true) continue;
      events.push(item);
      if (events.length >= query.maxResults) return events;
    }
    url = nextLinkOf(body);
  }
  return events;
}

function isKnownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The instant of a Graph time. Graph answers a naive wall-clock time and names
 * its zone; that zone is used when it is one Intl knows (IANA names and "UTC"
 * are), else the zone the query asked for, else UTC, which is what Graph answers
 * when no zone was asked for. Null for a value that cannot be read.
 */
export function instantOf(
  value: GraphDateTimeZone | null | undefined,
  queryZone: string | undefined,
): Date | null {
  const dateTime = value?.dateTime;
  if (!dateTime) return null;
  if (hasExplicitOffset(dateTime)) {
    const parsed = new Date(dateTime);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const reported = value?.timeZone;
  const zone = reported && isKnownZone(reported) ? reported : (queryZone ?? "UTC");
  return naiveLocalToUtc(dateTime, zone);
}

/**
 * An all-day event's date. Graph documents an all-day event as midnight to
 * midnight in one zone, so the date is read off the wall-clock value as it is
 * and never shifted through an instant: a date must stay the date the user sees.
 */
function dateOf(value: GraphDateTimeZone | null | undefined): string {
  const match = value?.dateTime?.match(ISO_DATE);
  return match ? match[0] : "";
}

function timedTimes(item: GraphEvent, queryZone: string | undefined) {
  const start = instantOf(item.start, queryZone);
  const end = instantOf(item.end, queryZone);
  return {
    start: start?.toISOString() ?? item.start?.dateTime ?? "",
    end: end?.toISOString() ?? item.end?.dateTime ?? "",
    startTime: queryZone ? start : null,
    endTime: queryZone ? end : null,
  };
}

function allDayTimes(item: GraphEvent, queryZone: string | undefined) {
  const start = dateOf(item.start);
  const end = dateOf(item.end);
  // Like a Google all-day row: the date read as midnight UTC.
  return {
    start,
    end,
    startTime: queryZone && start ? new Date(start) : null,
    endTime: queryZone && end ? new Date(end) : null,
  };
}

/** One Graph event in the provider-neutral shape the sync maps into a row. */
export function toProviderEvent(
  item: GraphEvent,
  queryZone: string | undefined,
): ProviderCalendarEvent {
  const allDay = item.isAllDay === true;
  return {
    externalId: item.id || "",
    summary: item.subject || null,
    description: item.bodyPreview || null,
    location: item.location?.displayName || null,
    meetingLink: item.onlineMeeting?.joinUrl || item.onlineMeetingUrl || null,
    allDay,
    ...(allDay ? allDayTimes(item, queryZone) : timedTimes(item, queryZone)),
  };
}
