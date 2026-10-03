export const DEFAULT_TIME_ZONE = "Asia/Seoul";

interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function normalizeTimeZone(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) return DEFAULT_TIME_ZONE;
  const tz = value.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/**
 * "+09:00" / "-04:00" — the ISO offset string for `timeZone` at `date`.
 * Used wherever a zone-aware offset must be shown/instructed (e.g.
 * agent-context.ts's "Current Time" line, event-parse.ts's LLM prompt)
 * instead of a hardcoded "+09:00" that assumed every user was in Seoul.
 * Derived from getTimeZoneOffsetMs (below) — the same arithmetic this file
 * already uses elsewhere — rather than parsing Intl's locale-formatted
 * "GMT±HH:MM" string, so there's one source of truth for offset math.
 */
export function offsetStringFor(date: Date, timeZone: string): string {
  const offsetMs = getTimeZoneOffsetMs(date, timeZone);
  const sign = offsetMs < 0 ? "-" : "+";
  const abs = Math.abs(offsetMs);
  const hours = Math.floor(abs / (60 * 60 * 1000));
  const minutes = Math.floor((abs % (60 * 60 * 1000)) / (60 * 1000));
  return `${sign}${pad2(hours)}:${pad2(minutes)}`;
}

export function localDateKey(now: Date = new Date(), timeZone: string = DEFAULT_TIME_ZONE): string {
  const parts = getLocalParts(now, normalizeTimeZone(timeZone));
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

export function localMinuteOfDay(
  now: Date = new Date(),
  timeZone: string = DEFAULT_TIME_ZONE,
): number {
  const parts = getLocalParts(now, normalizeTimeZone(timeZone));
  return parts.hour * 60 + parts.minute;
}

/** Day of week in `timeZone`, 0 = Sunday … 6 = Saturday (matches Date.getDay). */
export function localDayOfWeek(
  now: Date = new Date(),
  timeZone: string = DEFAULT_TIME_ZONE,
): number {
  const parts = getLocalParts(now, normalizeTimeZone(timeZone));
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

/**
 * True when the wall-clock time in `timeZone` is within `windowMinutes` of the
 * top of `hour` (e.g. hour=18, window=5 → 18:00–18:05 local). The proactive
 * scheduler uses this so daily/weekly notifications fire at the user's local
 * hour, not the server's UTC hour.
 */
export function isLocalTimeWithin(
  now: Date,
  timeZone: string,
  hour: number,
  windowMinutes = 5,
): boolean {
  const minuteOfDay = localMinuteOfDay(now, timeZone);
  return minuteOfDay >= hour * 60 && minuteOfDay <= hour * 60 + windowMinutes;
}

export function localDayUtcRange(
  now: Date = new Date(),
  timeZone: string = DEFAULT_TIME_ZONE,
): { dateKey: string; gte: Date; lt: Date } {
  const tz = normalizeTimeZone(timeZone);
  const dateKey = localDateKey(now, tz);
  const nextDateKey = addDaysToDateKey(dateKey, 1);
  return {
    dateKey,
    gte: localDateTimeToUtc(dateKey, "00:00", tz),
    lt: localDateTimeToUtc(nextDateKey, "00:00", tz),
  };
}

function localDateTimeToUtc(dateKey: string, hhmm: string, timeZone: string): Date {
  const [year, month, day] = dateKey.split("-").map((part) => Number.parseInt(part, 10));
  const [hour, minute] = hhmm.split(":").map((part) => Number.parseInt(part, 10));
  return new Date(wallClockToUtcMs(Date.UTC(year, month - 1, day, hour, minute, 0, 0), timeZone));
}

/**
 * The instant a wall-clock time is in `timeZone`. `localAsUtcMs` is the wall clock
 * written as if it were UTC (`Date.UTC(y, m, d, h, mi, s)`).
 *
 * The zone's offset has to be the one in force at the REAL instant, which is not
 * known until the answer is. Reading the offset at `localAsUtcMs` itself is an
 * hour off in the hours either side of a DST transition (the offset is sampled
 * 8 hours too early in Los Angeles, 2 hours too late in Berlin, and a transition
 * can sit in between): a Singapore holiday read in Los Angeles landed a day early
 * after the fall-back. So: take the offset at the as-if-UTC instant, convert,
 * take the offset at the result, and convert again if it moved. Two passes settle
 * every time that exists. A time that does not exist (inside a spring-forward gap)
 * never settles, and is read with the earlier offset, which puts it after the gap
 * (02:30 becomes 03:30). An ambiguous time (fall back) reads as its first
 * occurrence in a negative-offset zone and may read as either in a positive one;
 * it is always a valid instant for that wall clock.
 */
export function wallClockToUtcMs(localAsUtcMs: number, timeZone: string): number {
  const firstOffset = getTimeZoneOffsetMs(new Date(localAsUtcMs), timeZone);
  const firstGuess = localAsUtcMs - firstOffset;
  const secondOffset = getTimeZoneOffsetMs(new Date(firstGuess), timeZone);
  if (secondOffset === firstOffset) return firstGuess;
  const secondGuess = localAsUtcMs - secondOffset;
  const thirdOffset = getTimeZoneOffsetMs(new Date(secondGuess), timeZone);
  if (thirdOffset === secondOffset) return secondGuess;
  return localAsUtcMs - Math.min(secondOffset, thirdOffset);
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = getLocalParts(date, timeZone);
  const localAsUtcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    0,
  );
  return localAsUtcMs - date.getTime();
}

/**
 * One formatter per zone: building an Intl.DateTimeFormat costs tens of
 * microseconds, which a recurring-calendar expansion (step C3) paid several times
 * per occurrence. Formatting is stateless, so a shared formatter returns exactly
 * what a fresh one did. Bounded: past the cap a zone simply gets a fresh formatter.
 */
const MAX_CACHED_FORMATTERS = 1000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  if (formatters.size < MAX_CACHED_FORMATTERS) formatters.set(timeZone, formatter);
  return formatter;
}

function getLocalParts(date: Date, timeZone: string): LocalDateTimeParts {
  const formatter = formatterFor(timeZone);
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const hour = Number.parseInt(parts.hour ?? "0", 10);
  return {
    year: Number.parseInt(parts.year ?? "1970", 10),
    month: Number.parseInt(parts.month ?? "1", 10),
    day: Number.parseInt(parts.day ?? "1", 10),
    hour: hour === 24 ? 0 : hour,
    minute: Number.parseInt(parts.minute ?? "0", 10),
    second: Number.parseInt(parts.second ?? "0", 10),
  };
}

function addDaysToDateKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map((part) => Number.parseInt(part, 10));
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
