/**
 * Instants of iCalendar times (step C3). See ical-events.ts for the rules; this
 * module only computes them, with a per-listing cache of zone lookups so a long
 * series does not pay an Intl construction per occurrence.
 *
 * ical.js keeps a value's TZID only when the object has a VTIMEZONE for it; with
 * none it reads the value as floating and the TZID is gone from the value. So every
 * call takes the TZID parameter the value was WRITTEN with (`writtenTzidOf`), used
 * whenever ical.js handed back a floating value.
 */

import ICAL from "ical.js";
import { wallClockToUtcMs } from "../../time-zone.js";
import { ianaZoneOf } from "../calendar-providers/outlook-time-zones.js";

export type IcalTime = InstanceType<typeof ICAL.Time>;
export type IcalComponent = InstanceType<typeof ICAL.Component>;
type IcalProperty = InstanceType<typeof ICAL.Property>;

const FLOATING = "floating";

const DAY_MS = 24 * 60 * 60 * 1000;
const SECOND_MS = 1000;
const MAX_TZID_PREFIX_SEGMENTS = 4;
/**
 * The widest distance between a wall clock read as if it were UTC and the real
 * instant: UTC+14:00 (Kiribati), with margin for UTC-12:00 the other way.
 */
export const MAX_UTC_OFFSET_MS = 14 * 60 * 60 * 1000;

/** Thrown for a time that cannot be read; the caller counts the object unreadable. */
export class UnreadableIcal extends Error {
  constructor() {
    super("unreadable iCalendar value");
    this.name = "UnreadableIcal";
  }
}

/** The wall clock written as if it were UTC: cheap, and within MAX_UTC_OFFSET_MS of the instant. */
export function wallClockMs(time: IcalTime): number {
  return Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
}

function resolveIana(tzid: string): string | null {
  const direct = ianaZoneOf(tzid);
  if (direct) return direct;
  // Prefixed forms such as /mozilla.org/20050126_1/Europe/Berlin.
  const segments = tzid.split("/").filter(Boolean);
  for (let drop = 1; drop <= MAX_TZID_PREFIX_SEGMENTS && drop < segments.length; drop += 1) {
    const candidate = ianaZoneOf(segments.slice(drop).join("/"));
    if (candidate) return candidate;
  }
  return null;
}

/** The TZID parameter a value was written with, or null. */
export function writtenTzidOf(property: IcalProperty | null): string | null {
  const tzid = property?.getParameter("tzid");
  return typeof tzid === "string" && tzid !== "" ? tzid : null;
}

export interface IcalClock {
  /**
   * The instant of a DATE or DATE-TIME value; `writtenTzid` is the TZID parameter
   * it was written with. Throws UnreadableIcal.
   */
  instantOf(time: IcalTime, writtenTzid: string | null): Date;
  /** A stable key for a value: `YYYYMMDD` for a date, the UTC stamp otherwise. */
  stampOf(time: IcalTime, writtenTzid: string | null): string;
  /** The end of an event that starts at `start` (`startTime` is its DTSTART value). */
  endOf(component: IcalComponent, startTime: IcalTime, start: Date): Date;
}

/** A clock for one listing: `userZone` reads floating times and TZIDs nothing defines. */
export function icalClock(userZone: string): IcalClock {
  const zones = new Map<string, string | null>();
  const ianaFor = (tzid: string): string | null => {
    if (!zones.has(tzid)) zones.set(tzid, resolveIana(tzid));
    return zones.get(tzid) ?? null;
  };

  const instantOf = (time: IcalTime, writtenTzid: string | null): Date => {
    if (time.isDate) return new Date(Date.UTC(time.year, time.month - 1, time.day));
    const own = time.zone?.tzid;
    const tzid = !own || own === FLOATING ? (writtenTzid ?? own) : own;
    let ms: number;
    if (tzid === "UTC" || tzid === "Z") ms = wallClockMs(time);
    else if (tzid && tzid !== FLOATING) {
      const iana = ianaFor(tzid);
      if (iana) ms = wallClockToUtcMs(wallClockMs(time), iana);
      else if (time.zone?.component) ms = time.toUnixTime() * SECOND_MS;
      else ms = wallClockToUtcMs(wallClockMs(time), userZone);
    } else ms = wallClockToUtcMs(wallClockMs(time), userZone);
    if (!Number.isFinite(ms)) throw new UnreadableIcal();
    return new Date(ms);
  };

  const stampOf = (time: IcalTime, writtenTzid: string | null): string => {
    const iso = instantOf(time, writtenTzid).toISOString();
    return time.isDate
      ? iso.slice(0, 10).replace(/-/g, "")
      : iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  };

  const endOf = (component: IcalComponent, startTime: IcalTime, start: Date): Date => {
    const dtendProperty = component.getFirstProperty("dtend");
    const dtend = dtendProperty?.getFirstValue();
    const duration = component.getFirstPropertyValue("duration") as {
      toSeconds(): number;
    } | null;
    let end: number;
    if (dtend instanceof ICAL.Time) end = instantOf(dtend, writtenTzidOf(dtendProperty)).getTime();
    // DURATION is added as elapsed time; a day-based one on a DST day is an hour off.
    else if (duration) end = start.getTime() + duration.toSeconds() * SECOND_MS;
    else end = start.getTime() + (startTime.isDate ? DAY_MS : 0);
    return new Date(Math.max(end, start.getTime()));
  };

  return { instantOf, stampOf, endOf };
}
