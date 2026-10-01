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

const ISO_DATE_LENGTH = "2026-10-03".length;

/**
 * An all-day event is stored as UTC midnight of its dates (end exclusive), so its
 * date is read off the UTC instant. Reading it in the user's zone would put it a
 * day early west of UTC (Los Angeles shows Oct 2 for an event on Oct 3).
 */
function utcDate(date: Date): string {
  return date.toISOString().slice(0, ISO_DATE_LENGTH);
}

function boundaries(row: CalendarReadRow, timeZone: string): { start: string; end: string } {
  return row.allDay
    ? { start: utcDate(row.startTime), end: utcDate(row.endTime) }
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

/**
 * One row as an entry of the conflict list: the interval, a label for the
 * calendar (never an account id), provider and readOnly. No title: a conflict
 * check says WHEN the user is busy, like free/busy, and must not hand the agent
 * the name of a meeting on a linked (work) calendar.
 */
export function toRowConflict(row: CalendarReadRow, timeZone: string) {
  const readOnly = isReadOnlyCalendarRow(row);
  return {
    ...boundaries(row, timeZone),
    calendar: readOnly ? "linked" : "primary",
    provider: row.provider,
    readOnly,
  };
}

/**
 * A busy block without the event's title. The degraded primary-only path
 * (`primaryBusyBlocks`) returns the raw invite title; a conflict check says WHEN
 * the user is busy, like free/busy, and the title is external content.
 */
export function withoutSummary<T extends { summary?: unknown }>(conflict: T): Omit<T, "summary"> {
  const { summary: _summary, ...rest } = conflict;
  return rest;
}

function isLinkedConflict(entry: unknown): boolean {
  const { readOnly, calendar } = (entry ?? {}) as { readOnly?: unknown; calendar?: unknown };
  return readOnly === true || calendar === "linked";
}

/**
 * The conflicts as `create_event` echoes them to the model: an entry from a
 * linked calendar carries no `summary` (defense in depth: row entries have none
 * already), every other entry is untouched, so flag off the echo is what it was.
 */
export function withoutLinkedTitles(conflicts: readonly unknown[]): unknown[] {
  return conflicts.map((entry) => {
    if (!isLinkedConflict(entry)) return entry;
    const { summary: _summary, ...rest } = entry as Record<string, unknown>;
    return rest;
  });
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

/** Overlapping or touching intervals joined, earliest first: how free/busy reports them. */
function mergeTouching(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  return sorted.reduce<Interval[]>((merged, next) => {
    const last = merged.at(-1);
    if (last === undefined || next.start > last.end) return [...merged, next];
    return [...merged.slice(0, -1), { start: last.start, end: Math.max(last.end, next.end) }];
  }, []);
}

function covers(outer: Interval, inner: Interval): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/**
 * Row conflicts first (they name the provider), then the live free/busy blocks no
 * row already accounts for. Google reports busy time merged: two adjacent
 * meetings come back as one block. So a block is accounted for when the rows,
 * joined the same way, cover it: it is those events seen twice and is dropped.
 * Anything else stays, because free/busy sees what rows do not: calendars the
 * sync does not mirror and changes newer than the last sync. A block that cannot
 * be read is kept: never lose a possible conflict.
 */
export function mergeConflicts(
  rowConflicts: readonly unknown[],
  rows: readonly CalendarReadRow[],
  liveBlocks: readonly unknown[],
): unknown[] {
  const joined = mergeTouching(rows.map(rowInterval));
  const unaccounted = liveBlocks.filter((block) => {
    const interval = blockInterval(block);
    return interval === null || !joined.some((row) => covers(row, interval));
  });
  return [...rowConflicts, ...unaccounted];
}
