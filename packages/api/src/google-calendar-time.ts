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

/** Minimal structural slice of a Google Calendar event's time fields. */
export interface GoogleEventTimeInput {
  start?: { dateTime?: string | null; date?: string | null; timeZone?: string | null } | null;
  end?: { dateTime?: string | null; date?: string | null; timeZone?: string | null } | null;
}

/**
 * Map a Google Calendar event's start/end into stored `Date` instants + an
 * `allDay` flag, applying the user's timezone to naive timed values exactly as
 * the automation scheduler does. Returns null when start or end is missing.
 *
 * Shared so first-login init-sync and the 60s scheduler agree on the instant —
 * a timed event must not land at a different UTC moment depending on which path
 * wrote it. (Sub-project D will route the scheduler through this too.)
 */
export function mapGoogleEventTimes(
  item: GoogleEventTimeInput,
  userTimezone: string,
): { startTime: Date; endTime: Date; allDay: boolean } | null {
  const startRaw = item.start?.dateTime || item.start?.date || "";
  const endRaw = item.end?.dateTime || item.end?.date || "";
  if (!startRaw || !endRaw) return null;

  const isTimed = Boolean(item.start?.dateTime);
  const startTime = isTimed
    ? parseGoogleDateTime(startRaw, item.start?.timeZone ?? null, userTimezone)
    : new Date(startRaw);
  const endTime = isTimed
    ? parseGoogleDateTime(endRaw, item.end?.timeZone ?? null, userTimezone)
    : new Date(endRaw);
  return { startTime, endTime, allDay: !isTimed };
}

/**
 * Normalize an agent-supplied ISO time into an absolute UTC instant string for
 * a Google `events.list` timeMin/timeMax. The conflict-check tool asks the model
 * for an offset-bearing ISO8601, but if it drops the offset the only correct
 * reading is the USER's wall clock — never the server's UTC. Reusing
 * {@link hasExplicitOffset} / {@link naiveLocalToUtc} keeps this on the same
 * defensive path as the sync mapper. Returns null when the string is unparseable
 * so the caller can fail loudly instead of querying a garbage window.
 */
export function toAbsoluteInstant(value: string, userZone: string): string | null {
  if (hasExplicitOffset(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const utc = naiveLocalToUtc(value, userZone);
  return utc ? utc.toISOString() : null;
}

/** Structural slice of a Google `events.list` item used for conflict checks. */
export interface CalendarConflictItem {
  id?: string | null;
  summary?: string | null;
  start?: { dateTime?: string | null; date?: string | null } | null;
  end?: { dateTime?: string | null; date?: string | null } | null;
}

/** A timed event reduced to the fields the conflict response surfaces. */
export interface ConflictSummary {
  id: string | null | undefined;
  summary: string;
  start: string;
  end: string;
}

/**
 * Reduce raw `events.list` items to genuine time-slot conflicts. All-day events
 * (date-only, no `dateTime`) are full-day markers — holidays, birthdays, PTO —
 * and surfacing them as a clash for a timed meeting is a false positive, so they
 * are excluded. Only timed events (carrying `start.dateTime`) can double-book.
 */
export function summarizeConflicts(items: CalendarConflictItem[]): ConflictSummary[] {
  return items
    .filter((e) => Boolean(e.start?.dateTime))
    .map((e) => ({
      id: e.id,
      summary: e.summary || "(No title)",
      start: e.start?.dateTime || "",
      end: e.end?.dateTime || "",
    }));
}

/** Structural slice of a `calendarList.list` item. */
export interface CalendarListEntry {
  id?: string | null;
  accessRole?: string | null;
  primary?: boolean | null;
  summary?: string | null;
  summaryOverride?: string | null;
}

/**
 * Map calendar IDs to a human, non-identifying label. The raw freebusy key is
 * the calendar ID, which for the primary / Workspace calendars is the user's
 * email address — we must not surface that into the LLM prompt or any response.
 * `primary` → "primary"; secondary calendars → their user-chosen display name;
 * anything unlabelled → a generic "calendar".
 */
export function calendarLabelMap(
  items: CalendarListEntry[] | null | undefined,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const c of items ?? []) {
    if (!c.id) continue;
    map[c.id] = c.primary === true ? "primary" : c.summaryOverride || c.summary || "calendar";
  }
  return map;
}

/**
 * Pick the calendars a free/busy conflict check should query. A double-book can
 * only land on a calendar the user actually writes to, so we keep `primary` plus
 * any calendar with owner/writer access. Reader / freeBusyReader subscriptions
 * (shared team calendars, holidays, a colleague's calendar) are excluded — their
 * busy blocks are someone else's commitments, not the user's double-book.
 */
export function selectFreeBusyCalendarIds(items: CalendarListEntry[] | null | undefined): string[] {
  return (items ?? [])
    .filter(
      (c) =>
        !!c.id && (c.primary === true || c.accessRole === "owner" || c.accessRole === "writer"),
    )
    .map((c) => c.id as string);
}

/** Structural slice of one calendar's `freebusy.query` result. */
export interface FreeBusyCalendar {
  busy?: Array<{ start?: string | null; end?: string | null }> | null;
}

/** A busy interval found on one of the user's calendars. */
export interface BusyConflict {
  start: string;
  end: string;
  calendar: string;
}

/**
 * Flatten a `freebusy.query` response (a map of calendarId → busy intervals)
 * into a flat conflict list. freebusy already honours each event's free/busy
 * (transparency) status, so all-day "free" markers never appear here — only real
 * busy time. Intervals missing a start or end are skipped.
 *
 * The raw calendar ID (often the user's email) is NEVER emitted — each block is
 * tagged via `labelById` (see {@link calendarLabelMap}); an unmapped id degrades
 * to "primary" / "calendar".
 */
export function summarizeFreeBusy(
  calendars: Record<string, FreeBusyCalendar> | null | undefined,
  labelById?: Record<string, string>,
): BusyConflict[] {
  const out: BusyConflict[] = [];
  for (const [id, cal] of Object.entries(calendars ?? {})) {
    const calendar = labelById?.[id] ?? (id === "primary" ? "primary" : "calendar");
    for (const slot of cal?.busy ?? []) {
      if (slot?.start && slot?.end) {
        out.push({ start: slot.start, end: slot.end, calendar });
      }
    }
  }
  return out;
}
