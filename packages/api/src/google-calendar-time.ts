/**
 * Defensive parsing for Google Calendar's `start.dateTime` / `end.dateTime`.
 *
 * Google's events.list returns dateTime as RFC3339, normally with an offset.
 * In rare cases (or under explicit `timeZone` request param) it can come
 * back without an offset, in which case `new Date(...)` would parse it as
 * server-local time (UTC on Render) and store the wrong UTC moment.
 *
 * Symptom in production (2026-06-04): KST events stored as if they were
 * in another zone, surfacing as a consistent ±N-hour shift on the
 * calendar grid.
 *
 * Behavior:
 *   1. If `dateTime` already carries an explicit offset (e.g. ends in
 *      `+09:00` or `Z`), use it verbatim — Google has already canonicalized.
 *   2. Else combine the naive `dateTime` with the event's `timeZone`
 *      metadata via Intl to compute the correct UTC moment.
 *   3. Else fall back to the supplied user timezone (last-line defence —
 *      we'd rather be off by minutes than off by hours).
 *
 * All-day events (`start.date`, no dateTime) are handled separately by
 * the caller; this helper only deals with timed events.
 */

const OFFSET_RE = /(Z|[+-]\d{2}:?\d{2})$/;

/** Returns true iff the dateTime string ends with `Z` or a `±HH:MM` offset. */
export function hasExplicitOffset(dateTime: string): boolean {
  return OFFSET_RE.test(dateTime);
}

/**
 * Combine a naive (no-offset) ISO string with an IANA timezone to produce
 * the correct UTC moment.
 *
 * Approach:
 *   - Treat the naive string as a wall-clock time in the given zone.
 *   - Use Intl.DateTimeFormat to discover the UTC offset for that wall
 *     clock at that moment (which handles DST transitions correctly).
 *   - Apply the offset to get the UTC moment.
 *
 * Returns null if the string isn't a parseable naive ISO time.
 */
export function naiveLocalToUtc(naive: string, timeZone: string): Date | null {
  // Accept "YYYY-MM-DDTHH:MM:SS" or "YYYY-MM-DDTHH:MM" with optional .SSS
  const m = naive.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss] = m;
  // Construct as if UTC, then ask Intl what offset that wall-clock time
  // would have in the target zone, then shift by that offset.
  const asUtcMs = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(hh),
    Number(mm),
    ss ? Number(ss) : 0,
  );
  // Intl returns the parts of the as-if-UTC moment when displayed in
  // `timeZone` — the diff between those parts and the input tells us the
  // zone's offset at that wall clock.
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(asUtcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const tzAsUtcMs = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  // offset (ms) = (what Intl thinks the time is in tz) - (the input as UTC)
  // To get the actual UTC moment for the wall clock, subtract that offset.
  const offsetMs = tzAsUtcMs - asUtcMs;
  return new Date(asUtcMs - offsetMs);
}

/**
 * Parse a Google Calendar `dateTime` / `timeZone` pair into the correct
 * UTC `Date`. Use this anywhere we'd otherwise call `new Date(item.start.dateTime)`
 * directly — that naked call is the silent-failure path the bug above
 * surfaced through.
 *
 * @param dateTime  RFC3339 string from `item.start.dateTime` or `item.end.dateTime`
 * @param eventZone Optional `item.start.timeZone` / `item.end.timeZone`
 * @param userZone  User's stored IANA zone, used as fallback when nothing else is available
 */
export function parseGoogleDateTime(
  dateTime: string,
  eventZone: string | null | undefined,
  userZone: string,
): Date {
  if (hasExplicitOffset(dateTime)) {
    // Google emitted a canonical RFC3339 with offset — trust it.
    return new Date(dateTime);
  }
  // Naive string — combine with the event's stored zone, else the user's.
  const zone = eventZone || userZone;
  const parsed = naiveLocalToUtc(dateTime, zone);
  if (parsed) return parsed;
  // Last-ditch fallback: let Date parse however it likes. Better than
  // throwing and dropping the whole sync.
  return new Date(dateTime);
}
