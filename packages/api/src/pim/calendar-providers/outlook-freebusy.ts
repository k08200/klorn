/**
 * Free/busy for an Outlook account (step C4): POST /me/calendar/getSchedule.
 * https://learn.microsoft.com/graph/api/calendar-getschedule
 *
 * getSchedule needs Calendars.Read (Calendars.ReadBasic is the least privileged
 * permission it lists, and Calendars.Read is a higher one), which the calendar
 * link already requests, so no further consent. The same page lists delegated
 * personal Microsoft accounts as "Not supported": for those, a check on the
 * account's OWN calendar falls back to the calendar view, whose events carry the
 * same busy/free state (`showAs`). Other people's free/busy has no fallback and
 * is reported unknown, never free.
 *
 * A schedule item counts as busy unless Graph says `free` or `workingElsewhere`
 * (the two values its own availabilityView maps to 0), so `busy`, `tentative`,
 * `oof` and an `unknown` all block the slot: a check errs toward a conflict. So
 * does a busy item whose times cannot be read: it blocks the whole window, because
 * dropping it would answer "free" for time that may be taken.
 *
 * Only the account's DEFAULT calendar is read (`/me/calendarView` and
 * `/me/calendar/getSchedule`); secondary and shared calendars are not.
 */

import type { BusyConflict, ConflictSummary } from "../../google-calendar-time.js";
import { type GraphEvent, instantOf, listCalendarView } from "./outlook-events.js";
import { GRAPH_BASE_URL, GraphRequestError, graphRequest } from "./outlook-graph.js";
import type { CalendarWindow, PersonFreeBusy } from "./types.js";

const GET_SCHEDULE_URL = `${GRAPH_BASE_URL}/me/calendar/getSchedule`;
const UTC = "UTC";
/** The label a busy block carries to the model; never the account's address. */
const PRIMARY_CALENDAR_LABEL = "primary";
/** getSchedule's largest availabilityView slot. The view is unused; a big slot keeps the payload small. */
const AVAILABILITY_VIEW_INTERVAL_MINUTES = 1440;
/** Events read in a conflict window, by the calendar-view fallback and the degraded primary check. */
const BUSY_WINDOW_MAX_EVENTS = 250;
const NOT_BUSY_STATUSES: ReadonlySet<string> = new Set(["free", "workingElsewhere"]);
/** 4xx answers that are about the request or the account type, not about the credentials or load. */
const NOT_FALLBACK_STATUSES: ReadonlySet<number> = new Set([401, 408, 429]);
const MAX_LOGGED_CODE_LENGTH = 64;

/** Fallback reasons already logged: one line per distinct answer per process, not one per check. */
const loggedFallbackReasons = new Set<string>();

export function _resetScheduleFallbackLogForTests(): void {
  loggedFallbackReasons.clear();
}

/** Says why getSchedule was not used, by status and Graph's short code only (never a body or an address). */
function logScheduleFallback(reason: string): void {
  if (loggedFallbackReasons.has(reason)) return;
  loggedFallbackReasons.add(reason);
  console.warn(`[OUTLOOK-CAL] getSchedule unavailable (${reason}); using the calendar view`);
}

function scheduleErrorReason(info: GraphScheduleInformation | undefined): string {
  if (!info) return "no schedule returned";
  const code = (info.error as { responseCode?: unknown } | undefined)?.responseCode;
  return typeof code === "string" && code.length <= MAX_LOGGED_CODE_LENGTH
    ? `schedule error ${code}`
    : "schedule error";
}

interface GraphScheduleItem {
  readonly status?: string | null;
  readonly start?: { dateTime?: string | null; timeZone?: string | null } | null;
  readonly end?: { dateTime?: string | null; timeZone?: string | null } | null;
}

interface GraphScheduleInformation {
  readonly scheduleId?: string | null;
  readonly scheduleItems?: readonly GraphScheduleItem[] | null;
  readonly error?: unknown;
}

function isBusy(status: string | null | undefined): boolean {
  return !NOT_BUSY_STATUSES.has(status ?? "unknown");
}

function isoOf(value: GraphScheduleItem["start"]): string | null {
  return instantOf(value, UTC)?.toISOString() ?? null;
}

/** An ISO instant as Graph's naive UTC wall-clock time ("2026-10-02T00:00:00"). */
function naiveUtc(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19);
}

async function getSchedule(
  token: string,
  emails: readonly string[],
  window: CalendarWindow,
): Promise<GraphScheduleInformation[]> {
  const body = await graphRequest<{ value?: GraphScheduleInformation[] }>(token, GET_SCHEDULE_URL, {
    method: "POST",
    timeZone: UTC,
    body: {
      schedules: emails,
      startTime: { dateTime: naiveUtc(window.timeMin), timeZone: UTC },
      endTime: { dateTime: naiveUtc(window.timeMax), timeZone: UTC },
      availabilityViewInterval: AVAILABILITY_VIEW_INTERVAL_MINUTES,
    },
  });
  return body.value ?? [];
}

/** An item of either source reduced to what a busy check needs. */
interface TimedItem {
  readonly busy: boolean;
  readonly start: string | null;
  readonly end: string | null;
}

/**
 * Busy blocks from items: the readable ones as they are, and, when any busy item
 * has times that cannot be read, one block over the whole window (a conflict is
 * safer than a false "free").
 */
function busyBlocksFrom(items: readonly TimedItem[], window: CalendarWindow): BusyConflict[] {
  const busy = items.filter((item) => item.busy);
  const readable = busy.flatMap((item) =>
    item.start && item.end
      ? [{ start: item.start, end: item.end, calendar: PRIMARY_CALENDAR_LABEL }]
      : [],
  );
  const hasUnreadable = busy.some((item) => !item.start || !item.end);
  return hasUnreadable
    ? [
        ...readable,
        { start: window.timeMin, end: window.timeMax, calendar: PRIMARY_CALENDAR_LABEL },
      ]
    : readable;
}

function scheduleItem(item: GraphScheduleItem): TimedItem {
  return { busy: isBusy(item.status), start: isoOf(item.start), end: isoOf(item.end) };
}

function windowEvents(token: string, window: CalendarWindow): Promise<GraphEvent[]> {
  return listCalendarView(token, {
    timeMin: window.timeMin,
    timeMax: window.timeMax,
    maxResults: BUSY_WINDOW_MAX_EVENTS,
    timeZone: UTC,
  });
}

/** Busy blocks from the calendar view: the fallback for an account getSchedule does not serve. */
async function busyBlocksFromCalendarView(
  token: string,
  window: CalendarWindow,
): Promise<BusyConflict[]> {
  const events = await windowEvents(token, window);
  return busyBlocksFrom(
    events.map((event) => ({
      busy: isBusy(event.showAs),
      start: isoOf(event.start),
      end: isoOf(event.end),
    })),
    window,
  );
}

function isScheduleUnsupported(err: unknown): boolean {
  return (
    err instanceof GraphRequestError &&
    err.status >= 400 &&
    err.status < 500 &&
    !NOT_FALLBACK_STATUSES.has(err.status)
  );
}

/**
 * Busy blocks of the account's own calendar over the window. A failure that says
 * "not for this account" (a 4xx that is not auth, timeout or throttling) or a
 * per-schedule error falls back to the calendar view; everything else rejects,
 * so a revoked token or an outage is never hidden behind the fallback.
 */
export async function busyBlocksVia(
  token: string,
  accountEmail: string,
  window: CalendarWindow,
): Promise<BusyConflict[]> {
  try {
    const [own] = await getSchedule(token, [accountEmail], window);
    if (own && !own.error)
      return busyBlocksFrom((own.scheduleItems ?? []).map(scheduleItem), window);
    logScheduleFallback(scheduleErrorReason(own));
  } catch (err) {
    if (!isScheduleUnsupported(err)) throw err;
    const { status, graphCode } = err as GraphRequestError;
    logScheduleFallback(`http ${status}${graphCode ? ` ${graphCode}` : ""}`);
  }
  return busyBlocksFromCalendarView(token, window);
}

/** Timed, busy events of the calendar view as conflict summaries: the degraded path. */
export async function primaryBusyVia(
  token: string,
  window: CalendarWindow,
): Promise<ConflictSummary[]> {
  return (await windowEvents(token, window)).flatMap((event) => {
    if (event.isAllDay === true || !isBusy(event.showAs)) return [];
    const start = isoOf(event.start);
    const end = isoOf(event.end);
    // Times that cannot be read still block: the whole window, never a false "free".
    const readable = start !== null && end !== null;
    return [
      {
        id: event.id,
        summary: event.subject || "(No title)",
        start: readable ? start : window.timeMin,
        end: readable ? end : window.timeMax,
      },
    ];
  });
}

function toPersonFreeBusy(
  email: string,
  info: GraphScheduleInformation | undefined,
): PersonFreeBusy {
  // Not visible (absent, or a per-schedule error): unknown, never free.
  if (!info || info.error) return { email, blocks: null, anyBusy: false };
  const busyItems = (info.scheduleItems ?? []).filter((item) => isBusy(item.status));
  const blocks = busyItems.flatMap((item) => {
    const start = isoOf(item.start);
    const end = isoOf(item.end);
    return start && end ? [{ start, end }] : [];
  });
  // A busy entry with no usable times still reads as busy, never as a false "free".
  return { email, blocks, anyBusy: busyItems.length > 0 };
}

/** Other people's free/busy by address, in one getSchedule request. Rejects on a request failure. */
export async function peopleFreeBusyVia(
  token: string,
  emails: readonly string[],
  window: CalendarWindow,
): Promise<PersonFreeBusy[]> {
  if (emails.length === 0) return [];
  const schedules = await getSchedule(token, emails, window);
  const byAddress = new Map(
    schedules.map((info) => [(info.scheduleId ?? "").toLowerCase(), info] as const),
  );
  return emails.map((email) => toPersonFreeBusy(email, byAddress.get(email.toLowerCase())));
}
