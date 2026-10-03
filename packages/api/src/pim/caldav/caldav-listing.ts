/**
 * One CalDAV account's events for a window, and whether that is ALL of them (step
 * C3). Discovery, then one calendar-query per VEVENT calendar over the window
 * widened by a day on each side (a server reads an all-day or floating event in its
 * own zone; the margin makes sure every event that could meet the window comes
 * back), then expansion and the window cut here, with the same instants the rows
 * store.
 *
 * Complete means: at least one calendar was found, none was left out (cap), every
 * collection under the home could be classified (one that could not may be an
 * event calendar), every calendar answered, none was cut short (507), every object
 * was readable, no series ran out of iterations, no object was skipped over a cap
 * and the parse budget did not run out (ical-bounds.ts), and no more than
 * `maxResults` occurrences met the window. Only then may the sync remove the
 * window's rows this listing does not have, and only rows of the calendars it
 * names (`calendarKeys`): each occurrence carries the key of the calendar it came
 * from, so a calendar missing from discovery is unknown, not empty.
 *
 * Failure: a 401 anywhere throws at once (the app password was revoked; the
 * failure policy flags the account). Another failure of one calendar leaves it out
 * and makes the listing incomplete; all of them failing throws the first error.
 * Discovery failing throws.
 */

import { createHash } from "node:crypto";
import { discoverEventCalendars, queryCalendarObjects } from "./caldav-client.js";
import { CaldavHttpError, caldavErrorClass } from "./caldav-errors.js";
import type { CaldavConnection } from "./caldav-http.js";
import type { ParseOptions } from "./ical-bounds.js";
import {
  type CaldavOccurrence,
  type CaldavWindow,
  compareOccurrences,
  IcalExpansion,
} from "./ical-events.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Hex digits of a calendar key: 64 bits, unique among one account's calendars. */
const CALENDAR_KEY_LENGTH = 16;
/** How much wider than the window the server is asked for (see the header). */
export const CALDAV_SERVER_WINDOW_MARGIN_MS = DAY_MS;
const HTTP_UNAUTHORIZED = 401;

/**
 * A calendar's stable key: a hash of its collection path (never the path, which
 * carries the account's numeric id on iCloud). The host is left out: iCloud moves
 * an account between partitions (p23-, p42-...) without renaming its calendars.
 */
export function calendarKeyOf(calendar: URL): string {
  const path = calendar.pathname.endsWith("/") ? calendar.pathname : `${calendar.pathname}/`;
  return createHash("sha256").update(path, "utf8").digest("hex").slice(0, CALENDAR_KEY_LENGTH);
}

export interface AccountWindowListing {
  readonly occurrences: CaldavOccurrence[];
  readonly complete: boolean;
  /** The calendars discovered (and read, when complete), by `calendarKeyOf`. */
  readonly calendarKeys: string[];
}

/** One calendar's objects. */
interface CalendarBatch {
  readonly key: string;
  readonly objects: readonly string[];
}

interface Gathered {
  readonly batches: CalendarBatch[];
  readonly failed: number;
  readonly unreadable: number;
  readonly truncated: boolean;
  readonly firstError: unknown;
}

async function gatherObjects(
  conn: CaldavConnection,
  calendars: readonly URL[],
  window: CaldavWindow,
): Promise<Gathered> {
  const start = new Date(window.start.getTime() - CALDAV_SERVER_WINDOW_MARGIN_MS);
  const end = new Date(window.end.getTime() + CALDAV_SERVER_WINDOW_MARGIN_MS);
  const batches: CalendarBatch[] = [];
  let failed = 0;
  let unreadable = 0;
  let truncated = false;
  let firstError: unknown = null;
  for (const calendar of calendars) {
    try {
      const result = await queryCalendarObjects(conn, calendar, start, end);
      batches.push({ key: calendarKeyOf(calendar), objects: result.objects });
      unreadable += result.unreadable;
      truncated = truncated || result.truncated;
    } catch (err) {
      if (err instanceof CaldavHttpError && err.status === HTTP_UNAUTHORIZED) throw err;
      failed += 1;
      firstError ??= err;
    }
  }
  return { batches, failed, unreadable, truncated, firstError };
}

/** Every batch's occurrences, tagged with its calendar, under one listing's bounds. */
async function expandBatches(
  batches: readonly CalendarBatch[],
  window: CaldavWindow,
  userZone: string,
  parse: ParseOptions,
) {
  const expansion = new IcalExpansion(window, userZone, parse);
  const occurrences: CaldavOccurrence[] = [];
  for (const batch of batches) {
    const found = await expansion.add(batch.objects);
    occurrences.push(...found.map((item) => ({ ...item, calendarKey: batch.key })));
  }
  return { occurrences: occurrences.sort(compareOccurrences), ...expansion.finish() };
}

/**
 * See the header. `userZone` reads floating times; `maxResults` caps the
 * occurrences; `parse` is for tests (the parse budget's clock and size).
 */
export async function listAccountWindow(
  conn: CaldavConnection,
  window: CaldavWindow,
  userZone: string,
  maxResults: number,
  parse: ParseOptions = {},
): Promise<AccountWindowListing> {
  const discovered = await discoverEventCalendars(conn);
  const gathered = await gatherObjects(conn, discovered.calendars, window);
  if (discovered.calendars.length > 0 && gathered.failed === discovered.calendars.length) {
    throw gathered.firstError;
  }
  const parsed = await expandBatches(gathered.batches, window, userZone, parse);
  // An account with no calendar found is never "complete": an empty or odd discovery
  // answer must not read as "every event was deleted" and empty the window.
  const complete =
    discovered.calendars.length > 0 &&
    !discovered.truncated &&
    discovered.unclassified === 0 &&
    gathered.failed === 0 &&
    !gathered.truncated &&
    gathered.unreadable === 0 &&
    parsed.unreadable === 0 &&
    !parsed.truncated &&
    parsed.occurrences.length <= maxResults;
  if (!complete) {
    console.warn(
      `[CALDAV] ${conn.provider.provider} listing incomplete (rows are kept): calendars=${discovered.calendars.length}` +
        ` capped=${discovered.truncated} unclassified=${discovered.unclassified} failed=${gathered.failed} cut=${gathered.truncated || parsed.truncated}` +
        ` unreadable=${gathered.unreadable + parsed.unreadable} over=${parsed.occurrences.length > maxResults}` +
        (gathered.firstError ? ` first=${caldavErrorClass(gathered.firstError)}` : ""),
    );
  }
  return {
    occurrences: parsed.occurrences.slice(0, Math.max(0, maxResults)),
    complete,
    calendarKeys: discovered.calendars.map(calendarKeyOf),
  };
}
