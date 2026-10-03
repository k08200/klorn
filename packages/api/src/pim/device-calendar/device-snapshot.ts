/**
 * One device calendar snapshot, checked at the boundary (step C6 of
 * docs/providers/unified-platform-plan.md). A desktop app sends, for one calendar
 * the user turned on, every event of a bounded window; the snapshot is then the
 * whole truth for that window and that calendar (pim/device-calendar/device-ingest.ts).
 *
 * The JSON schema below caps every size (the route applies it, with a body limit);
 * `normaliseDeviceSnapshot` checks what a schema cannot: the window is a real
 * interval of at most DEVICE_WINDOW_MAX_DAYS near now, a timed event is two
 * offset-bearing instants (stored as UTC), an all-day event is two dates stored at
 * UTC midnight with the end exclusive (as C4 and C7 store them), and a meeting
 * link reaches a row only through `safeMeetingLink`. An event longer than
 * DEVICE_EVENT_MAX_SPAN_DAYS, cancelled events, events
 * outside the window and a repeated external id are left out and counted; a
 * malformed time refuses the whole snapshot, so a device never half-applies one.
 * Pure: no database, and no clock but the `now` passed in.
 */

import type { CalendarEventFields } from "../calendar-rows.js";
import { MAX_MEETING_LINK_LENGTH, safeMeetingLink } from "../meeting-link.js";

export { isDeviceSourceKey } from "./device-source-key.js";

/** The longest window one snapshot may cover. */
export const DEVICE_WINDOW_MAX_DAYS = 62;
/**
 * How far back the desktop app's window reaches: the start of today minus this.
 * Seven days keep last week's meetings for the briefing and the assistant.
 */
export const DEVICE_WINDOW_PAST_DAYS = 7;
/**
 * A window may start at most this long before now: the app's seven days plus TWO.
 * The app's window starts at a local midnight, so late in the day it is already
 * seven days and almost a day old, and on a 25-hour fall-back day that is 8 days and
 * up to an hour: a limit of exactly 8 x 24 h refused the last hour of each day while
 * the fall-back was inside the window. The second day covers that hour and a device
 * clock that runs behind. The row retention (device-ingest.ts) is the same span, so
 * the server keeps nothing older than a window can still confirm.
 */
export const DEVICE_WINDOW_MAX_LAG_DAYS = DEVICE_WINDOW_PAST_DAYS + 2;
/** A window may end at most this long after now. */
export const DEVICE_WINDOW_MAX_LEAD_DAYS = 93;
/**
 * The longest event kept, start to end. A longer one is left out (and counted), so
 * no row can end far beyond any window and escape the retention prune.
 */
export const DEVICE_EVENT_MAX_SPAN_DAYS = 31;
/** How far ahead of the server's clock a device's snapshot time may be. */
export const DEVICE_SNAPSHOT_CLOCK_SKEW_DAYS = 1;
/** The most events one snapshot may carry (the CalDAV listing's cap, C3). */
export const DEVICE_SNAPSHOT_MAX_EVENTS = 500;
export const DEVICE_TITLE_MAX = 500;
export const DEVICE_LOCATION_MAX = 500;
export const DEVICE_EXTERNAL_ID_MAX = 512;
export const DEVICE_CALENDAR_TITLE_MAX = 200;
/** Every event at every cap fits (500 x ~3.6 KB); anything larger is refused unread. */
export const DEVICE_SNAPSHOT_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

const DAY_MS = 86_400_000;
/** Long enough for any ISO 8601 instant with an offset and nanoseconds. */
const TIME_STRING_MAX = 40;

export type DeviceEventStatus = "confirmed" | "tentative" | "cancelled";

/** One event as the device sends it. */
export interface DeviceEventBody {
  readonly externalId: string;
  readonly title: string;
  /** An instant with an offset; for an all-day event a date (YYYY-MM-DD). */
  readonly start: string;
  /** As `start`; for an all-day event the day AFTER the last one (exclusive). */
  readonly end: string;
  readonly allDay: boolean;
  readonly location?: string | null;
  readonly meetingLink?: string | null;
  readonly status?: DeviceEventStatus;
}

/** The body of PUT /api/device-calendar/sources/:key/window. */
export interface DeviceSnapshotBody {
  readonly windowStart: string;
  readonly windowEnd: string;
  /** When the device read the calendar (its clock); an older one is ignored. */
  readonly snapshotAt: string;
  readonly calendarTitle: string;
  readonly events: readonly DeviceEventBody[];
}

export interface DeviceSnapshotWindow {
  readonly start: Date;
  readonly end: Date;
}

export interface NormalisedDeviceEvent {
  readonly externalId: string;
  readonly fields: CalendarEventFields;
}

export interface DeviceSnapshot {
  readonly window: DeviceSnapshotWindow;
  readonly snapshotAt: Date;
  readonly calendarTitle: string;
  readonly events: readonly NormalisedDeviceEvent[];
  /** Cancelled, out-of-window and repeated events left out. */
  readonly skipped: number;
}

/** Which part of the snapshot was refused; never echoes a value. */
export type DeviceSnapshotRefusal = "window" | "snapshotAt" | "events" | "event";

export type DeviceSnapshotResult =
  | { readonly ok: true; readonly snapshot: DeviceSnapshot }
  | { readonly ok: false; readonly reason: DeviceSnapshotRefusal };

const timeString = { type: "string", minLength: 1, maxLength: TIME_STRING_MAX } as const;

const deviceEventSchema = {
  type: "object",
  additionalProperties: false,
  required: ["externalId", "title", "start", "end", "allDay"],
  properties: {
    externalId: { type: "string", minLength: 1, maxLength: DEVICE_EXTERNAL_ID_MAX },
    title: { type: "string", maxLength: DEVICE_TITLE_MAX },
    start: timeString,
    end: timeString,
    allDay: { type: "boolean" },
    location: { type: ["string", "null"], maxLength: DEVICE_LOCATION_MAX },
    meetingLink: { type: ["string", "null"], maxLength: MAX_MEETING_LINK_LENGTH },
    status: { type: "string", enum: ["confirmed", "tentative", "cancelled"] },
  },
} as const;

/** The route's body schema: every string and the event count capped. */
export const deviceSnapshotBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["windowStart", "windowEnd", "snapshotAt", "calendarTitle", "events"],
  properties: {
    windowStart: timeString,
    windowEnd: timeString,
    snapshotAt: timeString,
    calendarTitle: { type: "string", minLength: 1, maxLength: DEVICE_CALENDAR_TITLE_MAX },
    events: { type: "array", maxItems: DEVICE_SNAPSHOT_MAX_EVENTS, items: deviceEventSchema },
  },
} as const;

const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** UTC midnight of a real calendar date, or null (2026-02-30 is not one). */
function utcDate(year: number, month: number, day: number): number | null {
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);
  const real =
    back.getUTCFullYear() === year && back.getUTCMonth() === month - 1 && back.getUTCDate() === day;
  return real ? ms : null;
}

/** An ISO 8601 instant that names its zone (Z or an offset); a naive time is refused. */
export function parseDeviceInstant(value: string): Date | null {
  const m = INSTANT.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac, zulu, sign, oh, om] = m;
  const day = utcDate(Number(y), Number(mo), Number(d));
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s ?? "0");
  if (day === null || hour > 23 || minute > 59 || second > 59) return null;
  const offsetHours = Number(oh ?? "0");
  const offsetMinutes = Number(om ?? "0");
  if (offsetHours > 23 || offsetMinutes > 59) return null;
  const millis = Math.floor(Number(`0.${frac ?? "0"}`) * 1000);
  const offset = zulu ? 0 : (sign === "-" ? -1 : 1) * (offsetHours * 60 + offsetMinutes);
  return new Date(day + ((hour * 60 + minute - offset) * 60 + second) * 1000 + millis);
}

/** A date (YYYY-MM-DD) as UTC midnight of that date, the way all-day rows are stored. */
export function parseDeviceDate(value: string): Date | null {
  const m = DATE_ONLY.exec(value);
  if (!m) return null;
  const ms = utcDate(Number(m[1]), Number(m[2]), Number(m[3]));
  return ms === null ? null : new Date(ms);
}

/**
 * True when an event or row belongs to the window: it starts before the window
 * ends and ends after it starts; a zero-length event counts when its instant lies
 * inside. The ingest applies the same rule to stored rows, so the snapshot and the
 * removal agree on what the window holds.
 */
export function overlapsDeviceWindow(
  start: Date,
  end: Date,
  window: DeviceSnapshotWindow,
): boolean {
  const s = start.getTime();
  const e = end.getTime();
  if (s >= window.end.getTime()) return false;
  if (e > window.start.getTime()) return true;
  return e === s && s >= window.start.getTime();
}

function parseWindow(body: DeviceSnapshotBody, now: Date): DeviceSnapshotWindow | null {
  const start = parseDeviceInstant(body.windowStart);
  const end = parseDeviceInstant(body.windowEnd);
  if (!start || !end || end.getTime() <= start.getTime()) return null;
  if (end.getTime() - start.getTime() > DEVICE_WINDOW_MAX_DAYS * DAY_MS) return null;
  if (start.getTime() < now.getTime() - DEVICE_WINDOW_MAX_LAG_DAYS * DAY_MS) return null;
  if (end.getTime() > now.getTime() + DEVICE_WINDOW_MAX_LEAD_DAYS * DAY_MS) return null;
  return { start, end };
}

/** The snapshot time, near the server's clock (a far-future one would block every later upload). */
function parseSnapshotAt(value: string, now: Date): Date | null {
  const at = parseDeviceInstant(value);
  if (!at) return null;
  if (at.getTime() > now.getTime() + DEVICE_SNAPSHOT_CLOCK_SKEW_DAYS * DAY_MS) return null;
  if (at.getTime() < now.getTime() - DEVICE_WINDOW_MAX_LAG_DAYS * DAY_MS) return null;
  return at;
}

/** Within the span cap, so its end is at most the window end plus that span. */
function withinSpan(times: { start: Date; end: Date }): boolean {
  return times.end.getTime() - times.start.getTime() <= DEVICE_EVENT_MAX_SPAN_DAYS * DAY_MS;
}

function eventTimes(event: DeviceEventBody): { start: Date; end: Date } | null {
  const parse = event.allDay ? parseDeviceDate : parseDeviceInstant;
  const start = parse(event.start);
  const end = parse(event.end);
  if (!start || !end) return null;
  // An all-day end is exclusive, so it must be a later date; a timed event may be a marker.
  const valid = event.allDay ? end.getTime() > start.getTime() : end.getTime() >= start.getTime();
  return valid ? { start, end } : null;
}

/**
 * Postgres text cannot hold NUL: one in an invitation's title would fail the
 * transaction on every upload and the calendar could never sync again. Dropped.
 */
export function withoutNul(value: string): string {
  return value.includes("\u0000") ? value.replaceAll("\u0000", "") : value;
}

function rowFields(event: DeviceEventBody, times: { start: Date; end: Date }): CalendarEventFields {
  return {
    title: withoutNul(event.title),
    description: null,
    startTime: times.start,
    endTime: times.end,
    location: event.location == null ? null : withoutNul(event.location),
    meetingLink: safeMeetingLink(event.meetingLink),
    allDay: event.allDay,
  };
}

/** See the header. */
export function normaliseDeviceSnapshot(body: DeviceSnapshotBody, now: Date): DeviceSnapshotResult {
  const window = parseWindow(body, now);
  if (!window) return { ok: false, reason: "window" };
  const snapshotAt = parseSnapshotAt(body.snapshotAt, now);
  if (!snapshotAt) return { ok: false, reason: "snapshotAt" };
  if (body.events.length > DEVICE_SNAPSHOT_MAX_EVENTS) return { ok: false, reason: "events" };

  const seen = new Set<string>();
  const events: NormalisedDeviceEvent[] = [];
  let skipped = 0;
  for (const event of body.events) {
    const times = eventTimes(event);
    if (!times) return { ok: false, reason: "event" };
    const externalId = withoutNul(event.externalId);
    const keep =
      event.status !== "cancelled" &&
      externalId !== "" &&
      withinSpan(times) &&
      !seen.has(externalId) &&
      overlapsDeviceWindow(times.start, times.end, window);
    if (!keep) {
      skipped += 1;
      continue;
    }
    seen.add(externalId);
    events.push({ externalId, fields: rowFields(event, times) });
  }
  const calendarTitle = withoutNul(body.calendarTitle);
  return { ok: true, snapshot: { window, snapshotAt, calendarTitle, events, skipped } };
}
