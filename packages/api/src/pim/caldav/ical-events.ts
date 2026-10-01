/**
 * iCalendar objects (RFC 5545) from a CalDAV calendar-query, as the occurrences of
 * one window (step C3). Parsing, RRULE/RDATE/EXDATE expansion and RECURRENCE-ID
 * matching are ical.js's (Mozilla, MPL-2.0, no dependencies); deciding instants,
 * ids and what counts as readable is done here.
 *
 * Instants:
 *   - DATE values (all-day): midnight UTC of the date, end exclusive, like a Google
 *     all-day row, whatever the user's zone.
 *   - UTC (`Z`) values: as written.
 *   - A TZID that names a zone Intl knows (an IANA name, a Windows name through the
 *     Outlook table, or a prefixed form such as `/mozilla.org/.../Europe/Berlin`):
 *     the wall clock read in that zone by `wallClockToUtcMs`, so the tz database,
 *     not a VTIMEZONE that may carry only some years' rules, decides DST.
 *   - Any other TZID: its own VTIMEZONE in the same object (ical.js reads it).
 *     With none, the user's zone.
 *   - Floating values (no zone): the user's zone (RFC 5545 3.3.5).
 *
 * Ids: a single event is its UID; an occurrence of a series is `UID#<original
 * start>` (the RECURRENCE-ID as a UTC stamp, or the date for an all-day series), so
 * a moved occurrence keeps its id. A UID over MAX_UID_LENGTH is hashed.
 *
 * Bounds: a series is walked from its DTSTART at most CALDAV_MAX_SERIES_ITERATIONS
 * steps, and one listing at most CALDAV_MAX_TOTAL_ITERATIONS in all; running out
 * marks the result truncated. Whatever cannot be read (unparsable text, a VEVENT
 * with no UID or DTSTART) is counted in `unreadable`, never guessed: the sync only
 * removes rows after a listing with nothing unreadable and nothing truncated.
 */

import { createHash } from "node:crypto";
import ICAL from "ical.js";
import { wallClockToUtcMs } from "../../time-zone.js";
import { ianaZoneOf } from "../calendar-providers/outlook-time-zones.js";
import type { ProviderCalendarEvent } from "../calendar-providers/types.js";
import { safeMeetingLink } from "../meeting-link.js";

/** Steps one series may be walked from its DTSTART: a daily series since 1972 fits. */
export const CALDAV_MAX_SERIES_ITERATIONS = 20_000;
/** Steps one listing may take across every series, so a hostile calendar cannot pin the CPU. */
export const CALDAV_MAX_TOTAL_ITERATIONS = 200_000;
const MAX_UID_LENGTH = 400;
const MAX_TZID_PREFIX_SEGMENTS = 4;

type IcalComponent = InstanceType<typeof ICAL.Component>;
type IcalTime = InstanceType<typeof ICAL.Time>;
type IcalEvent = InstanceType<typeof ICAL.Event>;

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

class Unreadable extends Error {}

function ianaFor(tzid: string): string | null {
  const direct = ianaZoneOf(tzid);
  if (direct) return direct;
  const segments = tzid.split("/").filter(Boolean);
  for (let drop = 1; drop <= MAX_TZID_PREFIX_SEGMENTS && drop < segments.length; drop += 1) {
    const candidate = ianaZoneOf(segments.slice(drop).join("/"));
    if (candidate) return candidate;
  }
  return null;
}

function wallClockMs(time: IcalTime): number {
  return Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
}

/** The instant of an ical.js time, by the rules in the header. */
function instantOf(time: IcalTime, userZone: string): Date {
  if (time.isDate) return new Date(Date.UTC(time.year, time.month - 1, time.day));
  const tzid = time.zone?.tzid;
  let ms: number;
  if (tzid === "UTC" || tzid === "Z") {
    ms = wallClockMs(time);
  } else if (tzid && tzid !== "floating") {
    const iana = ianaFor(tzid);
    if (iana) ms = wallClockToUtcMs(wallClockMs(time), iana);
    else if (time.zone?.component) ms = time.toUnixTime() * 1000;
    else ms = wallClockToUtcMs(wallClockMs(time), userZone);
  } else {
    ms = wallClockToUtcMs(wallClockMs(time), userZone);
  }
  if (!Number.isFinite(ms)) throw new Unreadable();
  return new Date(ms);
}

function stampOf(time: IcalTime, userZone: string): string {
  const instant = instantOf(time, userZone);
  const iso = instant.toISOString();
  return time.isDate
    ? iso.slice(0, 10).replace(/-/g, "")
    : iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function boundedUid(uid: string): string {
  return uid.length <= MAX_UID_LENGTH
    ? uid
    : `sha256:${createHash("sha256").update(uid, "utf8").digest("hex")}`;
}

function textProperty(component: IcalComponent, name: string): string | null {
  const value = component.getFirstPropertyValue(name);
  return typeof value === "string" && value.trim() !== "" ? value : null;
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

function occurrence(
  item: IcalComponent,
  externalId: string,
  times: { start: IcalTime; end: IcalTime },
  userZone: string,
): CaldavOccurrence {
  const allDay = times.start.isDate;
  const startTime = instantOf(times.start, userZone);
  const rawEnd = instantOf(times.end, userZone);
  const endTime = rawEnd.getTime() < startTime.getTime() ? startTime : rawEnd;
  const transparent =
    String(item.getFirstPropertyValue("transp") ?? "").toUpperCase() === "TRANSPARENT";
  return {
    externalId,
    summary: textProperty(item, "summary"),
    description: textProperty(item, "description"),
    location: textProperty(item, "location"),
    meetingLink: meetingLinkOf(item),
    start: allDay ? startTime.toISOString().slice(0, 10) : startTime.toISOString(),
    end: allDay ? endTime.toISOString().slice(0, 10) : endTime.toISOString(),
    allDay,
    startTime,
    endTime,
    busy: !allDay && !transparent,
  };
}

interface Budget {
  remaining: number;
}

interface SeriesResult {
  readonly occurrences: CaldavOccurrence[];
  readonly truncated: boolean;
}

function eventTimes(event: IcalEvent): { start: IcalTime; end: IcalTime } {
  if (!event.component.hasProperty("dtstart")) throw new Unreadable();
  return { start: event.startDate, end: event.endDate };
}

/** A VEVENT without RRULE/RDATE (or an override whose series is not in the object). */
function single(component: IcalComponent, window: CaldavWindow, userZone: string): SeriesResult {
  const uid = boundedUid(String(component.getFirstPropertyValue("uid")));
  const event = new ICAL.Event(component);
  const recurrenceId = component.getFirstPropertyValue("recurrence-id") as IcalTime | null;
  const id = recurrenceId ? `${uid}#${stampOf(recurrenceId, userZone)}` : uid;
  if (isCancelled(component)) return { occurrences: [], truncated: false };
  const found = occurrence(component, id, eventTimes(event), userZone);
  const inside = overlapsWindow(found.startTime as Date, found.endTime as Date, window);
  return { occurrences: inside ? [found] : [], truncated: false };
}

function series(
  master: IcalComponent,
  overrides: readonly IcalComponent[],
  window: CaldavWindow,
  userZone: string,
  budget: Budget,
): SeriesResult {
  if (isCancelled(master)) return { occurrences: [], truncated: false };
  const uid = boundedUid(String(master.getFirstPropertyValue("uid")));
  const event = new ICAL.Event(master, { exceptions: [...overrides], strictExceptions: true });
  eventTimes(event);
  const found: CaldavOccurrence[] = [];
  const visited = new Set<string>();
  const iterator = event.iterator();
  let steps = 0;
  for (let next = iterator.next(); next; next = iterator.next()) {
    steps += 1;
    budget.remaining -= 1;
    if (steps > CALDAV_MAX_SERIES_ITERATIONS || budget.remaining < 0) {
      return { occurrences: found, truncated: true };
    }
    if (instantOf(next, userZone).getTime() >= window.end.getTime()) break;
    const details = event.getOccurrenceDetails(next);
    const key = stampOf(details.recurrenceId, userZone);
    visited.add(key);
    if (isCancelled(details.item.component)) continue;
    const item = occurrence(
      details.item.component,
      `${uid}#${key}`,
      { start: details.startDate, end: details.endDate },
      userZone,
    );
    if (overlapsWindow(item.startTime as Date, item.endTime as Date, window)) found.push(item);
  }
  // An override whose original start is past the window can move an occurrence INTO
  // it; the walk above stopped before reaching it.
  for (const override of overrides) {
    const recurrenceId = override.getFirstPropertyValue("recurrence-id") as IcalTime | null;
    if (!recurrenceId) continue;
    const key = stampOf(recurrenceId, userZone);
    if (visited.has(key) || instantOf(recurrenceId, userZone).getTime() < window.end.getTime()) {
      continue;
    }
    found.push(...single(override, window, userZone).occurrences);
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
    if (typeof uid !== "string" || uid.trim() === "") throw new Unreadable();
    groups.set(uid, [...(groups.get(uid) ?? []), vevent]);
  }
  return groups;
}

function groupOccurrences(
  components: readonly IcalComponent[],
  window: CaldavWindow,
  userZone: string,
  budget: Budget,
): SeriesResult {
  const master = components.find((c) => !c.hasProperty("recurrence-id"));
  const overrides = components.filter((c) => c.hasProperty("recurrence-id"));
  if (master && isRecurring(master)) return series(master, overrides, window, userZone, budget);
  const parts = (master ? [master] : overrides).map((c) => single(c, window, userZone));
  return { occurrences: parts.flatMap((p) => p.occurrences), truncated: false };
}

function rootOf(text: string): IcalComponent {
  const parsed = ICAL.parse(text);
  const root = new ICAL.Component(parsed as never);
  if (root.name !== "vcalendar") throw new Unreadable();
  return root;
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
  const budget: Budget = { remaining: CALDAV_MAX_TOTAL_ITERATIONS };
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
        const result = groupOccurrences(components, window, userZone, budget);
        occurrences.push(...result.occurrences);
        truncated = truncated || result.truncated;
      } catch {
        unreadable += 1;
      }
    }
  }
  occurrences.sort(
    (a, b) =>
      (a.startTime as Date).getTime() - (b.startTime as Date).getTime() ||
      a.externalId.localeCompare(b.externalId),
  );
  return { occurrences, unreadable, truncated };
}
