/**
 * iCalendar objects (RFC 5545) from a CalDAV calendar-query, as the occurrences of
 * one window (step C3). ical.js (Mozilla, MPL-2.0, no dependencies) parses and
 * walks RRULE/RDATE/EXDATE; deciding instants, matching overrides, ids and what
 * counts as readable is done here.
 *
 * Instants (ical-time.ts):
 *   - DATE values (all-day): midnight UTC of the date, end exclusive, like a Google
 *     all-day row, whatever the user's zone.
 *   - UTC (`Z`) values: as written.
 *   - A TZID that names a zone Intl knows (an IANA name, a Windows name through the
 *     Outlook table, or a prefixed form such as `/mozilla.org/.../Europe/Berlin`):
 *     the wall clock read in that zone by `wallClockToUtcMs`, so the tz database,
 *     not a VTIMEZONE that may carry only some years' rules, decides DST. Also
 *     with no VTIMEZONE in the object, where ical.js drops the TZID: the TZID the
 *     value was written with is read from its property, never the user's zone.
 *   - Any other TZID: its own VTIMEZONE in the same object (ical.js reads it).
 *     With none, the user's zone.
 *   - Floating values (no zone): the user's zone (RFC 5545 3.3.5).
 *
 * Overrides (RECURRENCE-ID) and EXDATEs are matched to occurrences by INSTANT, not
 * by ical.js, which compares wall clocks when a zone has no VTIMEZONE: it missed a
 * UTC-form RECURRENCE-ID or EXDATE against a TZID start, and took an EXDATE at the
 * same wall clock in another zone for a match (review findings). ical.js's
 * iterator is handed the master without EXDATE and no overrides. A DATE EXDATE
 * still removes a timed occurrence on that date (ical.js's rule for the mixed form).
 *
 * Ids: a single event is its UID; an occurrence of a series is `UID#<original
 * start>` (the RECURRENCE-ID as a UTC stamp, or the date for an all-day series), so
 * a moved occurrence keeps its id. A UID over MAX_UID_LENGTH is hashed.
 *
 * Bounds: a series is walked from its DTSTART at most CALDAV_MAX_SERIES_ITERATIONS
 * steps and one listing CALDAV_MAX_TOTAL_ITERATIONS in all (running out marks the
 * result truncated); a step before the window costs no zone arithmetic; ical.js's
 * own search is bounded by ical-recur-guard.ts. Whatever cannot be read (text that
 * does not parse, a VEVENT with no UID or DTSTART, a rule past a bound) is counted
 * in `unreadable`, never guessed: the sync only removes rows after a listing with
 * nothing unreadable and nothing truncated. Text is stripped of NUL (Postgres
 * refuses it) and cut to a bound.
 */

import { createHash } from "node:crypto";
import ICAL from "ical.js";
import type { ProviderCalendarEvent } from "../calendar-providers/types.js";
import { safeMeetingLink } from "../meeting-link.js";
import { assertBoundedRecurrence, withRecurSpinBudget } from "./ical-recur-guard.js";
import {
  type IcalClock,
  type IcalComponent,
  type IcalTime,
  icalClock,
  MAX_UTC_OFFSET_MS,
  UnreadableIcal,
  wallClockMs,
  writtenTzidOf,
} from "./ical-time.js";

/** Steps one series may be walked from its DTSTART: a daily series since 1960 fits. */
export const CALDAV_MAX_SERIES_ITERATIONS = 25_000;
/** Steps one listing may take across every series. */
export const CALDAV_MAX_TOTAL_ITERATIONS = 200_000;
export const CALDAV_MAX_TITLE_LENGTH = 1_000;
export const CALDAV_MAX_DESCRIPTION_LENGTH = 20_000;
export const CALDAV_MAX_LOCATION_LENGTH = 1_000;
const MAX_UID_LENGTH = 400;
/** Postgres refuses U+0000 in text, which would fail the whole account's sync. */
const NUL = String.fromCharCode(0);

export interface CaldavOccurrence extends ProviderCalendarEvent {
  /** Timed and not TRANSP:TRANSPARENT: time the person is busy (free/busy). */
  readonly busy: boolean;
}

export interface CaldavWindow {
  readonly start: Date;
  readonly end: Date;
}

export interface WindowOccurrences {
  readonly occurrences: CaldavOccurrence[];
  /** VEVENTs or objects that could not be read. */
  readonly unreadable: number;
  /** True when an iteration bound stopped a series before the window's end. */
  readonly truncated: boolean;
}

/** True when [start, end) meets the window; a zero-length event counts at its start. */
export function overlapsWindow(start: Date, end: Date, window: CaldavWindow): boolean {
  if (start.getTime() >= window.end.getTime()) return false;
  if (end.getTime() > window.start.getTime()) return true;
  return end.getTime() === start.getTime() && start.getTime() >= window.start.getTime();
}

interface Context {
  readonly window: CaldavWindow;
  readonly clock: IcalClock;
  steps: number;
}

interface SeriesResult {
  readonly occurrences: CaldavOccurrence[];
  readonly truncated: boolean;
}

const NONE: SeriesResult = { occurrences: [], truncated: false };

function boundedUid(uid: string): string {
  return uid.length <= MAX_UID_LENGTH
    ? uid
    : `sha256:${createHash("sha256").update(uid, "utf8").digest("hex")}`;
}

function textProperty(component: IcalComponent, name: string, max: number): string | null {
  const value = component.getFirstPropertyValue(name);
  if (typeof value !== "string") return null;
  const clean = value.split(NUL).join("").slice(0, max);
  return clean.trim() === "" ? null : clean;
}

function meetingLinkOf(component: IcalComponent): string | null {
  const candidates = [
    ...component.getAllProperties("conference").map((prop) => prop.getFirstValue()),
    component.getFirstPropertyValue("url"),
  ];
  for (const candidate of candidates) {
    const link = safeMeetingLink(candidate);
    if (link) return link;
  }
  return null;
}

function isCancelled(component: IcalComponent): boolean {
  return String(component.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED";
}

/** A time value and the TZID it was written with (ical.js may have dropped it). */
interface WrittenTime {
  readonly time: IcalTime;
  readonly tzid: string | null;
}

function timeProperty(component: IcalComponent, name: string): WrittenTime | null {
  const property = component.getFirstProperty(name);
  const value = property?.getFirstValue();
  return value instanceof ICAL.Time ? { time: value, tzid: writtenTzidOf(property) } : null;
}

function dtstartOf(component: IcalComponent): WrittenTime {
  const start = timeProperty(component, "dtstart");
  if (!start) throw new UnreadableIcal();
  return start;
}

function occurrence(
  item: IcalComponent,
  externalId: string,
  allDay: boolean,
  times: { start: Date; end: Date },
): CaldavOccurrence {
  const transparent =
    String(item.getFirstPropertyValue("transp") ?? "").toUpperCase() === "TRANSPARENT";
  const iso = (instant: Date) =>
    allDay ? instant.toISOString().slice(0, 10) : instant.toISOString();
  return {
    externalId,
    summary: textProperty(item, "summary", CALDAV_MAX_TITLE_LENGTH),
    description: textProperty(item, "description", CALDAV_MAX_DESCRIPTION_LENGTH),
    location: textProperty(item, "location", CALDAV_MAX_LOCATION_LENGTH),
    meetingLink: meetingLinkOf(item),
    start: iso(times.start),
    end: iso(times.end),
    allDay,
    startTime: times.start,
    endTime: times.end,
    busy: !allDay && !transparent,
  };
}

/** One VEVENT at its own times: a single event, or an override of a series. */
function ownOccurrence(component: IcalComponent, externalId: string, ctx: Context) {
  if (isCancelled(component)) return null;
  const startTime = dtstartOf(component);
  const start = ctx.clock.instantOf(startTime.time, startTime.tzid);
  const end = ctx.clock.endOf(component, startTime.time, start);
  const found = occurrence(component, externalId, startTime.time.isDate, { start, end });
  return overlapsWindow(start, end, ctx.window) ? found : null;
}

/** A VEVENT without RRULE/RDATE, or an override whose series is not in the object. */
function single(component: IcalComponent, ctx: Context): SeriesResult {
  const uid = boundedUid(String(component.getFirstPropertyValue("uid")));
  const recurrenceId = timeProperty(component, "recurrence-id");
  const id = recurrenceId
    ? `${uid}#${ctx.clock.stampOf(recurrenceId.time, recurrenceId.tzid)}`
    : uid;
  const found = ownOccurrence(component, id, ctx);
  return { occurrences: found ? [found] : [], truncated: false };
}

interface SeriesShape {
  readonly uid: string;
  readonly durationMs: number;
  /** The TZID DTSTART was written with: every step of the series is in it. */
  readonly stepTzid: string | null;
  /** EXDATE stamps: the instant of a DATE-TIME, the date of a DATE. */
  readonly exdates: ReadonlySet<string>;
  /** DATE EXDATEs (`YYYYMMDD`), which also remove a timed occurrence on that date. */
  readonly exdateDays: ReadonlySet<string>;
  readonly overrides: ReadonlyMap<string, IcalComponent>;
  /** Override instants, for deciding which early steps need an exact instant. */
  readonly overrideMs: readonly number[];
}

/** The `YYYYMMDD` of a value's own wall clock. */
function wallDay(time: IcalTime): string {
  const pad = (n: number, width: number) => String(n).padStart(width, "0");
  return `${pad(time.year, 4)}${pad(time.month, 2)}${pad(time.day, 2)}`;
}

function shapeOf(master: IcalComponent, overrides: readonly IcalComponent[], ctx: Context) {
  const { clock } = ctx;
  const startTime = dtstartOf(master);
  const start = clock.instantOf(startTime.time, startTime.tzid);
  const exdateValues = master.getAllProperties("exdate").flatMap((property) =>
    property
      .getValues()
      .filter((value): value is IcalTime => value instanceof ICAL.Time)
      .map((time): WrittenTime => ({ time, tzid: writtenTzidOf(property) })),
  );
  const exdates = exdateValues.map((value) => clock.stampOf(value.time, value.tzid));
  const exdateDays = exdateValues
    .filter((value) => value.time.isDate)
    .map((value) => wallDay(value.time));
  const byStamp = new Map<string, IcalComponent>();
  const overrideMs: number[] = [];
  for (const override of overrides) {
    const recurrenceId = timeProperty(override, "recurrence-id");
    if (!recurrenceId) continue;
    byStamp.set(clock.stampOf(recurrenceId.time, recurrenceId.tzid), override);
    overrideMs.push(clock.instantOf(recurrenceId.time, recurrenceId.tzid).getTime());
  }
  return {
    uid: boundedUid(String(master.getFirstPropertyValue("uid"))),
    durationMs: clock.endOf(master, startTime.time, start).getTime() - start.getTime(),
    stepTzid: startTime.tzid,
    exdates: new Set(exdates),
    exdateDays: new Set(exdateDays),
    overrides: byStamp,
    overrideMs,
  } satisfies SeriesShape;
}

/**
 * True when an EXDATE removes the occurrence originally at `time` (stamp `stamp`):
 * the same instant, or, for a DATE EXDATE and a timed occurrence, the same date on
 * the occurrence's own wall clock (ical.js's rule for that mixed form, kept).
 */
function isExcluded(time: IcalTime, stamp: string, shape: SeriesShape): boolean {
  if (shape.exdates.has(stamp)) return true;
  return !time.isDate && shape.exdateDays.has(wallDay(time));
}

/**
 * The master as ical.js's iterator sees it: without EXDATE, which ical.js matches
 * by wall clock when a zone has no VTIMEZONE (so 10:00 New York removed 10:00
 * Seoul). EXDATEs are matched here, by instant. A new component over the same
 * parsed data and parent (for VTIMEZONE lookups); the master is left as it is.
 */
function iterableMaster(master: IcalComponent): IcalComponent {
  const [name, properties, components] = master.jCal as [string, unknown[][], unknown[]];
  const kept = properties.filter((property) => property[0] !== "exdate");
  return new ICAL.Component([name, kept, components], master.parent ?? undefined);
}

/** The occurrence a step of the series stands for, or null (excluded, cancelled, outside). */
function stepOccurrence(
  master: IcalComponent,
  next: IcalTime,
  shape: SeriesShape,
  ctx: Context,
  visited: Set<string>,
): CaldavOccurrence | null {
  const stamp = ctx.clock.stampOf(next, shape.stepTzid);
  if (isExcluded(next, stamp, shape)) return null;
  const id = `${shape.uid}#${stamp}`;
  const override = shape.overrides.get(stamp);
  if (override) {
    visited.add(stamp);
    return ownOccurrence(override, id, ctx);
  }
  const start = ctx.clock.instantOf(next, shape.stepTzid);
  const end = new Date(start.getTime() + shape.durationMs);
  const found = occurrence(master, id, next.isDate, { start, end });
  return overlapsWindow(start, end, ctx.window) ? found : null;
}

function series(master: IcalComponent, overrides: readonly IcalComponent[], ctx: Context) {
  if (isCancelled(master)) return NONE;
  assertBoundedRecurrence(master);
  const shape = shapeOf(master, overrides, ctx);
  const windowStart = ctx.window.start.getTime();
  const windowEnd = ctx.window.end.getTime();
  const found: CaldavOccurrence[] = [];
  const visited = new Set<string>();
  const iterator = new ICAL.Event(iterableMaster(master)).iterator();
  let steps = 0;
  for (let next = iterator.next(); next; next = iterator.next()) {
    steps += 1;
    ctx.steps += 1;
    if (steps > CALDAV_MAX_SERIES_ITERATIONS || ctx.steps > CALDAV_MAX_TOTAL_ITERATIONS) {
      return { occurrences: found, truncated: true };
    }
    // A step's wall clock is within MAX_UTC_OFFSET_MS of its instant: cheap bounds first.
    const approx = wallClockMs(next);
    if (approx - MAX_UTC_OFFSET_MS >= windowEnd) break;
    const reachesWindow = approx + MAX_UTC_OFFSET_MS + shape.durationMs >= windowStart;
    const nearOverride = shape.overrideMs.some((ms) => Math.abs(ms - approx) <= MAX_UTC_OFFSET_MS);
    if (!reachesWindow && !nearOverride) continue;
    const item = stepOccurrence(master, next, shape, ctx, visited);
    if (item) found.push(item);
  }
  // An override whose original start is past the window can move an occurrence INTO
  // it; the walk above stopped before reaching it.
  for (const [stamp, override] of shape.overrides) {
    const recurrenceId = timeProperty(override, "recurrence-id") as WrittenTime;
    if (visited.has(stamp) || isExcluded(recurrenceId.time, stamp, shape)) continue;
    if (ctx.clock.instantOf(recurrenceId.time, recurrenceId.tzid).getTime() < windowEnd) continue;
    const item = ownOccurrence(override, `${shape.uid}#${stamp}`, ctx);
    if (item) found.push(item);
  }
  return { occurrences: found, truncated: false };
}

function isRecurring(component: IcalComponent): boolean {
  return component.hasProperty("rrule") || component.hasProperty("rdate");
}

/** The VEVENTs of one object, grouped by UID: master (if any) and its overrides. */
function groupsOf(root: IcalComponent): Map<string, IcalComponent[]> {
  const groups = new Map<string, IcalComponent[]>();
  for (const vevent of root.getAllSubcomponents("vevent")) {
    const uid = vevent.getFirstPropertyValue("uid");
    if (typeof uid !== "string" || uid.trim() === "") throw new UnreadableIcal();
    groups.set(uid, [...(groups.get(uid) ?? []), vevent]);
  }
  return groups;
}

function groupOccurrences(components: readonly IcalComponent[], ctx: Context): SeriesResult {
  const master = components.find((c) => !c.hasProperty("recurrence-id"));
  const overrides = components.filter((c) => c.hasProperty("recurrence-id"));
  if (master && isRecurring(master)) return series(master, overrides, ctx);
  const parts = (master ? [master] : overrides).map((c) => single(c, ctx));
  return { occurrences: parts.flatMap((p) => p.occurrences), truncated: false };
}

function rootOf(text: string): IcalComponent {
  const root = new ICAL.Component(ICAL.parse(text) as never);
  if (root.name !== "vcalendar") throw new UnreadableIcal();
  return root;
}

function collect(objects: readonly string[], ctx: Context): WindowOccurrences {
  const occurrences: CaldavOccurrence[] = [];
  let unreadable = 0;
  let truncated = false;
  for (const text of objects) {
    let groups: Map<string, IcalComponent[]>;
    try {
      groups = groupsOf(rootOf(text));
    } catch {
      unreadable += 1;
      continue;
    }
    for (const components of groups.values()) {
      try {
        const result = groupOccurrences(components, ctx);
        occurrences.push(...result.occurrences);
        truncated = truncated || result.truncated;
      } catch {
        // Unparsable values, a missing DTSTART, a rule past a bound (RecurSpinLimitError).
        unreadable += 1;
      }
    }
  }
  return { occurrences, unreadable, truncated };
}

/**
 * The occurrences of `objects` (iCalendar texts) that meet `window`, in start
 * order. `userZone` is the zone floating times (and a TZID nothing defines) are
 * read in.
 */
export function occurrencesInWindow(
  objects: readonly string[],
  window: CaldavWindow,
  userZone: string,
): WindowOccurrences {
  const ctx: Context = { window, clock: icalClock(userZone), steps: 0 };
  const result = withRecurSpinBudget(() => collect(objects, ctx));
  const occurrences = [...result.occurrences].sort(
    (a, b) =>
      (a.startTime as Date).getTime() - (b.startTime as Date).getTime() ||
      a.externalId.localeCompare(b.externalId),
  );
  return { ...result, occurrences };
}
