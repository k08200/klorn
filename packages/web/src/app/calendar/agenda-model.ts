/**
 * The phone calendar's day agenda (mobile redesign PR5, MB1): which events a
 * day shows and in what order, moving between days, and the name of the
 * meeting provider behind an event's link.
 *
 * Pure and import-free: pinned by
 * packages/api/src/__tests__/web-calendar-agenda-model.test.ts (the web
 * package has no unit-test runner).
 */

const DAY_MS = 86_400_000;
const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The fields of a calendar event the agenda reads. */
export interface AgendaEvent {
  startTime: string;
  allDay: boolean;
}

function parseDayKey(key: string): { year: number; month: number; day: number } | null {
  const match = DAY_KEY.exec(key);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** The YYYY-MM-DD key `delta` days from `key` (calendar days, no clock involved). */
export function shiftDayKey(key: string, delta: number): string {
  const parts = parseDayKey(key);
  if (!parts) return key;
  const noon = Date.UTC(parts.year, parts.month - 1, parts.day, 12);
  return new Date(noon + delta * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The month a day belongs to, in the page's month shape: day 1 at noon UTC
 * (month-utils firstOfMonth). Read off the key itself, so no zone offset can
 * move it into the next or previous month.
 */
export function monthStartForKey(key: string): Date | null {
  const parts = parseDayKey(key);
  if (!parts) return null;
  return new Date(Date.UTC(parts.year, parts.month - 1, 1, 12));
}

/** The date a key names, for formatting in the UTC zone ("11월 18일 화요일"). */
export function dateForKey(key: string): Date | null {
  const parts = parseDayKey(key);
  if (!parts) return null;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12));
}

function startMs(event: AgendaEvent): number {
  const ms = Date.parse(event.startTime);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/** A day's events: all-day ones first, then by start time; the input is not changed. */
export function dayAgenda<E extends AgendaEvent>(events: readonly E[]): E[] {
  return [...events].sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return startMs(a) - startMs(b);
  });
}

/** Meetings in the day header: the timed events (an all-day one is not a meeting). */
export function timedCount(events: readonly AgendaEvent[]): number {
  return events.filter((event) => !event.allDay).length;
}

const PROVIDERS: ReadonlyArray<{ host: string; name: string }> = [
  { host: "meet.google.com", name: "Google Meet" },
  { host: "zoom.us", name: "Zoom" },
  { host: "zoom.com", name: "Zoom" },
  { host: "teams.microsoft.com", name: "Microsoft Teams" },
  { host: "teams.live.com", name: "Microsoft Teams" },
  { host: "webex.com", name: "Webex" },
  { host: "whereby.com", name: "Whereby" },
];

/**
 * The provider of a meeting link already passed by safeMeetingHref: a known
 * service by name, else the bare host (without "www."). Null for anything
 * that does not parse.
 */
export function meetingProviderName(safeHref: string | null): string | null {
  if (!safeHref) return null;
  let host: string;
  try {
    host = new URL(safeHref).hostname.toLowerCase();
  } catch {
    return null;
  }
  const known = PROVIDERS.find((p) => host === p.host || host.endsWith(`.${p.host}`));
  if (known) return known.name;
  return host.startsWith("www.") ? host.slice(4) : host;
}
