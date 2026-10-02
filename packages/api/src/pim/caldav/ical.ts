/**
 * iCalendar (RFC 5545) parsing — the subset a calendar client actually needs.
 *
 * Written by hand rather than pulled from npm: the repo takes no new runtime
 * dependency for this, and the parts that matter here are the parts a general
 * library gets right but we would still have to verify — folding, parameter
 * quoting, text escaping, and the three shapes a DTSTART can take. Each of
 * those is a test below.
 *
 * What this deliberately does NOT do: expand RRULE into occurrences, or
 * convert a TZID-qualified local time into an absolute instant. Both need a
 * timezone database and a recurrence engine, and both are decisions the caller
 * should make with its own clock. We hand back exactly what the server said,
 * labelled, so nothing is silently invented.
 */

/** A single date-time as iCalendar actually expresses it. */
export interface ICalTime {
  /** The raw value as it appeared, e.g. "20260929T140000Z" or "20260929". */
  readonly raw: string;
  /** VALUE=DATE — an all-day boundary. DTEND of an all-day event is exclusive. */
  readonly isAllDay: boolean;
  /** Named zone from TZID, when the value is local rather than UTC. */
  readonly tzid?: string;
  /** ISO-8601 instant, only when the value is unambiguous (UTC or all-day). */
  readonly iso?: string;
}

export interface ICalEvent {
  /** UID — stable across updates; the key for dedupe and for mapping to ours. */
  readonly uid: string;
  readonly summary?: string;
  readonly description?: string;
  readonly location?: string;
  readonly start?: ICalTime;
  readonly end?: ICalTime;
  /** Present verbatim when the event recurs; not expanded (see file header). */
  readonly rrule?: string;
  readonly organizer?: string;
  readonly attendees: readonly string[];
  readonly status?: string;
  /** RECURRENCE-ID — set on an override instance of a recurring series. */
  readonly recurrenceId?: string;
}

interface ParsedLine {
  readonly name: string;
  readonly params: Readonly<Record<string, string>>;
  readonly value: string;
}

/**
 * Undo RFC 5545 line folding.
 *
 * A folded line is CRLF followed by a single space or tab, and the whole of
 * that — break plus the one whitespace octet — is removed. Servers in the wild
 * send bare LF as well as CRLF, so both are accepted. Getting this wrong
 * corrupts every long SUMMARY and every base64 attachment, silently.
 */
export function unfold(text: string): string {
  return text.replace(/\r\n[ \t]|\n[ \t]|\r[ \t]/g, "");
}

/**
 * Split one content line into name, parameters and value.
 *
 * The separator is the first colon that is not inside a quoted parameter
 * value — `ATTENDEE;CN="Doe, John:Jr":mailto:j@example.com` is one property,
 * not three. Scanning with a quote flag is the whole trick.
 */
export function parseLine(line: string): ParsedLine | null {
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ":" && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon === -1) return null;

  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);

  // Parameters are separated by semicolons, again respecting quotes.
  const segments: string[] = [];
  let current = "";
  inQuotes = false;
  for (const ch of head) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === ";" && !inQuotes) {
      segments.push(current);
      current = "";
    } else current += ch;
  }
  segments.push(current);

  const name = (segments.shift() ?? "").trim().toUpperCase();
  if (!name) return null;

  const params: Record<string, string> = {};
  for (const seg of segments) {
    const eq = seg.indexOf("=");
    if (eq === -1) continue;
    const key = seg.slice(0, eq).trim().toUpperCase();
    let raw = seg.slice(eq + 1).trim();
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) raw = raw.slice(1, -1);
    params[key] = raw;
  }
  return { name, params, value };
}

/**
 * Unescape a TEXT value.
 *
 * Order matters: a literal backslash is itself escaped, so `\\n` means
 * backslash-then-n and must not become a newline. Walking the string once and
 * consuming the pair is the only way to keep that straight; a chain of
 * `.replace()` calls gets it wrong.
 */
export function unescapeText(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== "\\") {
      out += value[i];
      continue;
    }
    const next = value[++i];
    if (next === undefined) {
      out += "\\";
      break;
    }
    if (next === "n" || next === "N") out += "\n";
    else if (next === "," || next === ";" || next === "\\") out += next;
    else out += next; // unknown escape: keep the character, drop the backslash
  }
  return out;
}

/** Turn `20260929T140000Z` / `20260929` into an ISO instant where unambiguous. */
function toIso(raw: string, isAllDay: boolean): string | undefined {
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (isAllDay && dateOnly) return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;
  const utc = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(raw);
  if (utc) {
    const [, y, mo, d, h, mi, s] = utc;
    return `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`;
  }
  // Local time with or without TZID: absolute instant is unknowable here.
  return undefined;
}

function parseTime(line: ParsedLine): ICalTime {
  const isAllDay = line.params.VALUE === "DATE";
  const tzid = line.params.TZID;
  const raw = line.value.trim();
  const iso = toIso(raw, isAllDay);
  return { raw, isAllDay, ...(tzid ? { tzid } : {}), ...(iso ? { iso } : {}) };
}

/** `mailto:a@b.com` → `a@b.com`; anything else is returned unchanged. */
function stripMailto(value: string): string {
  return value.replace(/^mailto:/i, "").trim();
}

/**
 * Parse every VEVENT in an iCalendar document.
 *
 * Nested components (VALARM inside VEVENT, and VTIMEZONE beside it) are
 * skipped rather than flattened — an alarm's own SUMMARY must not overwrite
 * the event's, which is the classic bug in a naive line-by-line reader.
 */
export function parseEvents(icsText: string): ICalEvent[] {
  const lines = unfold(icsText).split(/\r\n|\n|\r/);
  const events: ICalEvent[] = [];

  let current: {
    uid?: string;
    summary?: string;
    description?: string;
    location?: string;
    start?: ICalTime;
    end?: ICalTime;
    rrule?: string;
    organizer?: string;
    attendees: string[];
    status?: string;
    recurrenceId?: string;
  } | null = null;
  // Depth of components opened *inside* the VEVENT we are reading (VALARM…).
  let nested = 0;

  for (const rawLine of lines) {
    const line = parseLine(rawLine);
    if (!line) continue;

    if (line.name === "BEGIN") {
      const component = line.value.trim().toUpperCase();
      if (component === "VEVENT" && current === null) {
        current = { attendees: [] };
        nested = 0;
      } else if (current !== null) nested++;
      continue;
    }

    if (line.name === "END") {
      const component = line.value.trim().toUpperCase();
      if (component === "VEVENT" && current !== null && nested === 0) {
        if (current.uid) {
          events.push({
            uid: current.uid,
            attendees: current.attendees,
            ...(current.summary !== undefined ? { summary: current.summary } : {}),
            ...(current.description !== undefined ? { description: current.description } : {}),
            ...(current.location !== undefined ? { location: current.location } : {}),
            ...(current.start ? { start: current.start } : {}),
            ...(current.end ? { end: current.end } : {}),
            ...(current.rrule !== undefined ? { rrule: current.rrule } : {}),
            ...(current.organizer !== undefined ? { organizer: current.organizer } : {}),
            ...(current.status !== undefined ? { status: current.status } : {}),
            ...(current.recurrenceId !== undefined ? { recurrenceId: current.recurrenceId } : {}),
          });
        }
        current = null;
      } else if (current !== null && nested > 0) nested--;
      continue;
    }

    if (current === null || nested > 0) continue;

    switch (line.name) {
      case "UID":
        current.uid = line.value.trim();
        break;
      case "SUMMARY":
        current.summary = unescapeText(line.value);
        break;
      case "DESCRIPTION":
        current.description = unescapeText(line.value);
        break;
      case "LOCATION":
        current.location = unescapeText(line.value);
        break;
      case "DTSTART":
        current.start = parseTime(line);
        break;
      case "DTEND":
        current.end = parseTime(line);
        break;
      case "RRULE":
        current.rrule = line.value.trim();
        break;
      case "ORGANIZER":
        current.organizer = stripMailto(line.value);
        break;
      case "ATTENDEE":
        current.attendees.push(stripMailto(line.value));
        break;
      case "STATUS":
        current.status = line.value.trim().toUpperCase();
        break;
      case "RECURRENCE-ID":
        current.recurrenceId = line.value.trim();
        break;
      default:
        break;
    }
  }

  return events;
}
