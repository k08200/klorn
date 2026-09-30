/**
 * How rows from the unified read path (pim/calendar-read.ts) are shown to the
 * model: the `list_events` event, the conflict entry, and the merge of row
 * conflicts with Google free/busy. Pure functions, no I/O.
 *
 * The event keeps the shape `list_events` always answered (id, summary, start,
 * end, location, description, every text wrapped as untrusted) and adds
 * `allDay`, `provider` and `readOnly`. Times are written the way Google wrote
 * them to the live call: an offset-bearing local time for a timed event, a plain
 * date for an all-day one (end exclusive), so the model reads both paths alike.
 */

import { localDateKey, localMinuteOfDay, offsetStringFor } from "../time-zone.js";
import { wrapUntrusted } from "../untrusted.js";
import type { CalendarReadRow } from "./calendar-read.js";
import { isReadOnlyCalendarRow } from "./calendar-scope.js";

const NO_TITLE = "(No title)";
const MINUTES_PER_HOUR = 60;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "2026-10-03T14:00:00+09:00": the instant as the wall clock in `timeZone` reads it. */
export function toLocalIso(date: Date, timeZone: string): string {
  const minutes = localMinuteOfDay(date, timeZone);
  const clock = `${pad2(Math.floor(minutes / MINUTES_PER_HOUR))}:${pad2(minutes % MINUTES_PER_HOUR)}`;
  return `${localDateKey(date, timeZone)}T${clock}:00${offsetStringFor(date, timeZone)}`;
}

function boundaries(row: CalendarReadRow, timeZone: string): { start: string; end: string } {
  return row.allDay
    ? { start: localDateKey(row.startTime, timeZone), end: localDateKey(row.endTime, timeZone) }
    : { start: toLocalIso(row.startTime, timeZone), end: toLocalIso(row.endTime, timeZone) };
}

/**
 * One row as a `list_events` event. A linked calendar's event is read-only and
 * has no id to offer: `delete_event` works on the primary calendar only, so an
 * id it cannot honour would invite a delete that cannot work.
 */
export function toToolEvent(row: CalendarReadRow, timeZone: string) {
  const readOnly = isReadOnlyCalendarRow(row);
  return {
    id: readOnly ? null : row.externalId,
    summary: wrapUntrusted(row.title || NO_TITLE, "calendar:summary"),
    ...boundaries(row, timeZone),
    allDay: row.allDay,
    location: wrapUntrusted(row.location, "calendar:location"),
    description: wrapUntrusted(row.description, "calendar:description"),
    provider: row.provider,
    readOnly,
  };
}

/** One row as an entry of the conflict list. The calendar is a label, never an account id. */
export function toRowConflict(row: CalendarReadRow, timeZone: string) {
  const readOnly = isReadOnlyCalendarRow(row);
  return {
    ...boundaries(row, timeZone),
    calendar: readOnly ? "linked" : "primary",
    summary: wrapUntrusted(row.title || NO_TITLE, "calendar:summary"),
    provider: row.provider,
    readOnly,
  };
}

interface Interval {
  readonly start: number;
  readonly end: number;
}

function rowInterval(row: CalendarReadRow): Interval {
  return { start: row.startTime.getTime(), end: row.endTime.getTime() };
}

/** The busy block's interval, or null when it has no two parseable instants. */
function blockInterval(block: unknown): Interval | null {
  const { start, end } = (block ?? {}) as { start?: unknown; end?: unknown };
  if (typeof start !== "string" || typeof end !== "string") return null;
  const interval = { start: Date.parse(start), end: Date.parse(end) };
  return Number.isNaN(interval.start) || Number.isNaN(interval.end) ? null : interval;
}

function covers(outer: Interval, inner: Interval): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/**
 * Row conflicts first (they name the event), then the live free/busy blocks no
 * row already accounts for. A block inside a row's interval is that event seen
 * twice and is dropped; anything else stays, because free/busy sees what rows do
 * not: calendars the sync does not mirror and changes newer than the last sync.
 * A block that cannot be read is kept: never lose a possible conflict.
 */
export function mergeConflicts(
  rowConflicts: readonly unknown[],
  rows: readonly CalendarReadRow[],
  liveBlocks: readonly unknown[],
): unknown[] {
  const intervals = rows.map(rowInterval);
  const unaccounted = liveBlocks.filter((block) => {
    const interval = blockInterval(block);
    return interval === null || !intervals.some((row) => covers(row, interval));
  });
  return [...rowConflicts, ...unaccounted];
}
