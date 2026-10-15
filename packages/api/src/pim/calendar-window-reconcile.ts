/**
 * Removing the rows of events that vanished from a CalDAV calendar (step C3 of
 * docs/providers/unified-platform-plan.md).
 *
 * Google (C2b) never removes a row because it is missing from a listing: its
 * listing is capped and paged, so absence proves nothing, and only an explicit
 * cancellation removes one. A CalDAV time-range query is different: it returns
 * every calendar object with an instance in the range, so a COMPLETE listing of a
 * window is the whole current set, and a row of that window it does not have was
 * deleted or cancelled upstream. The guard is therefore all-or-nothing:
 *   - the listing must say `complete` (every calendar answered, nothing capped, cut
 *     short by the server, unreadable, or over the event cap);
 *   - the provider must be ICLOUD or NAVER, and CALDAV_CALENDAR_ENABLED on;
 *   - only that account's rows (user, provider, source key) are candidates, only
 *     those inside the listing's window (decided with the same overlap rule the
 *     listing used), and only those written before the listing started, so a row a
 *     concurrent sync just wrote is never taken for a vanished one;
 *   - only rows of a calendar the listing read (`calendarKeys`): a row of a
 *     calendar the discovery did not list, or with no calendar recorded, is
 *     unknown, never removed (review fix 2026-10-02);
 *   - the deletion valve: a removal of more than CALDAV_DELETE_MAX_SHARE of the
 *     account's rows in the window, when that is more than
 *     CALDAV_DELETE_VALVE_MIN_ROWS rows, is refused. A transient empty 207 would
 *     otherwise empty the window and resolve its attention items, with nothing to
 *     restore them. A refusal is logged and sent to Sentry once per account per
 *     process; the rows stay and age out of the window. (A user who really deleted
 *     most of a month keeps those rows until then: a known limit, in the plan.)
 *   - a row of a calendar the listing read but found no event in (an empty 207
 *     for that calendar) is removed only when the account's previous complete
 *     listing showed the same such rows gone. One transient empty 207 keeps them,
 *     whether the window has 3 rows or the account has a second calendar with
 *     events; a calendar really emptied loses its rows one sync later. A vanished
 *     row of a calendar that still lists events goes at once, as before. The wait
 *     is per process (a restart, or a listing that is not complete, starts it
 *     again), and is checked after the valve, so the valve's report is unchanged.
 * The removal and the resolution of the rows' open attention items are one
 * transaction, like the C2b removal.
 */

import { createHash } from "node:crypto";
import { caldavCalendarEnabled } from "../config.js";
import { INTERACTIVE_TX_OPTIONS, prisma } from "../db.js";
import { captureError } from "../sentry.js";
import { isCaldavProviderKey } from "./caldav/caldav-providers.js";
import { type CaldavWindow, overlapsWindow } from "./caldav/ical-events.js";
import type { CalendarWindowListing } from "./calendar-providers/types.js";
import { type CalendarProviderName, linkedSourceScope } from "./calendar-rows.js";

/** The largest share of an account's rows in the window one listing may remove. */
export const CALDAV_DELETE_MAX_SHARE = 0.5;
/** A removal of at most this many rows is never refused, whatever its share. */
export const CALDAV_DELETE_VALVE_MIN_ROWS = 5;
/** Accounts remembered as reported; past it the oldest is forgotten (and reported again). */
const MAX_TRACKED_VALVE_REPORTS = 10_000;

const reportedAccounts = new Set<string>();
/** Per account: a digest of the rows the last complete listing showed gone from empty calendars. */
const emptyCalendarRowsSeen = new Map<string, string>();

export function _resetDeletionValveForTests(): void {
  reportedAccounts.clear();
  emptyCalendarRowsSeen.clear();
}

export interface WindowRemoval {
  readonly removed: number;
  readonly resolved: number;
}

const NOTHING: WindowRemoval = { removed: 0, resolved: 0 };

interface WindowRow {
  readonly id: string;
  readonly externalId: string | null;
  readonly startTime: Date;
  readonly endTime: Date;
  readonly updatedAt: Date;
  readonly caldavCalendarKey: string | null;
}

interface ValveCounts {
  readonly gone: number;
  readonly inWindow: number;
}

/** The window's rows the listing shows to be gone (see the header). */
function vanishedRows(inWindow: readonly WindowRow[], listing: CalendarWindowListing): WindowRow[] {
  const present = new Set(listing.events.map((event) => event.externalId).filter(Boolean));
  const read = new Set(listing.calendarKeys ?? []);
  return inWindow
    .filter((row) => row.updatedAt.getTime() < listing.listedAt.getTime())
    .filter((row) => row.caldavCalendarKey !== null && read.has(row.caldavCalendarKey))
    .filter((row) => row.externalId !== null && !present.has(row.externalId));
}

/**
 * The calendars the listing read and found no event in. An event without a key
 * cannot be placed, so then every read calendar counts as empty (only delays).
 */
function emptyCalendars(listing: CalendarWindowListing): Set<string> {
  const read = listing.calendarKeys ?? [];
  if (listing.events.some((event) => !event.calendarKey)) return new Set(read);
  const listed = new Set(listing.events.map((event) => event.calendarKey));
  return new Set(read.filter((key) => !listed.has(key)));
}

/**
 * Whether the previous complete listing showed these same rows gone from empty
 * calendars. Consumes the entry when it did; otherwise records this listing's.
 */
function takeEmptyCalendarConfirmation(linkedAccountId: string, ids: readonly string[]): boolean {
  const digest = createHash("sha256")
    .update([...ids].sort().join("\n"))
    .digest("hex");
  const confirmed = emptyCalendarRowsSeen.get(linkedAccountId) === digest;
  emptyCalendarRowsSeen.delete(linkedAccountId);
  if (confirmed) return true;
  if (emptyCalendarRowsSeen.size >= MAX_TRACKED_VALVE_REPORTS) {
    const oldest = emptyCalendarRowsSeen.keys().next().value;
    if (oldest !== undefined) emptyCalendarRowsSeen.delete(oldest);
  }
  emptyCalendarRowsSeen.set(linkedAccountId, digest);
  return false;
}

/** True when removing `gone` of the account's `inWindow` rows is refused. */
export function isOverDeletionValve(gone: number, inWindow: number): boolean {
  return gone > CALDAV_DELETE_VALVE_MIN_ROWS && gone > CALDAV_DELETE_MAX_SHARE * inWindow;
}

function reportValve(
  provider: CalendarProviderName,
  userId: string,
  linkedAccountId: string,
  counts: ValveCounts,
): void {
  if (reportedAccounts.has(linkedAccountId)) return;
  if (reportedAccounts.size >= MAX_TRACKED_VALVE_REPORTS) {
    const oldest = reportedAccounts.values().next().value;
    if (oldest !== undefined) reportedAccounts.delete(oldest);
  }
  reportedAccounts.add(linkedAccountId);
  console.warn(
    `[CALENDAR] deletion valve: refused removing ${counts.gone} of ${counts.inWindow} rows in the window` +
      ` for ${userId}:${linkedAccountId} (rows kept; reported once per account per process)`,
  );
  captureError(new Error("CalDAV removal refused by the deletion valve"), {
    tags: { scope: "calendar.caldav.deletion_valve", provider },
    extra: { userId, linkedAccountId, vanished: counts.gone, inWindow: counts.inWindow },
  });
}

type Outcome =
  | (WindowRemoval & { readonly held: number })
  | { readonly refused: ValveCounts }
  | { readonly awaitingConfirmation: number };

async function removeInTransaction(
  provider: CalendarProviderName,
  userId: string,
  linkedAccountId: string,
  listing: CalendarWindowListing,
  now: Date,
): Promise<Outcome> {
  const window: CaldavWindow = {
    start: new Date(listing.window.timeMin),
    end: new Date(listing.window.timeMax),
  };
  return prisma.$transaction(async (tx) => {
    const candidates: WindowRow[] = await tx.calendarEvent.findMany({
      where: {
        ...linkedSourceScope(provider, userId, linkedAccountId),
        startTime: { lt: window.end },
        endTime: { gte: window.start },
      },
      select: {
        id: true,
        externalId: true,
        startTime: true,
        endTime: true,
        updatedAt: true,
        caldavCalendarKey: true,
      },
    });
    const inWindow = candidates.filter((row) => overlapsWindow(row.startTime, row.endTime, window));
    const goneRows = vanishedRows(inWindow, listing);
    const empty = emptyCalendars(listing);
    const waiting = goneRows
      .filter((row) => row.caldavCalendarKey !== null && empty.has(row.caldavCalendarKey))
      .map((row) => row.id);
    if (waiting.length === 0) emptyCalendarRowsSeen.delete(linkedAccountId);
    if (goneRows.length === 0) return { ...NOTHING, held: 0 };
    if (isOverDeletionValve(goneRows.length, inWindow.length)) {
      return { refused: { gone: goneRows.length, inWindow: inWindow.length } };
    }
    const confirmed =
      waiting.length === 0 || takeEmptyCalendarConfirmation(linkedAccountId, waiting);
    const held = new Set(confirmed ? [] : waiting);
    const gone = goneRows.map((row) => row.id).filter((id) => !held.has(id));
    if (gone.length === 0) return { awaitingConfirmation: held.size };
    const resolved = await tx.attentionItem.updateMany({
      where: {
        userId,
        source: "CALENDAR_EVENT",
        sourceId: { in: gone },
        status: { in: ["OPEN", "SNOOZED"] },
      },
      data: { status: "RESOLVED", resolvedAt: now },
    });
    const removed = await tx.calendarEvent.deleteMany({ where: { userId, id: { in: gone } } });
    return { removed: removed.count, resolved: resolved.count, held: held.size };
  }, INTERACTIVE_TX_OPTIONS);
}

/** See the header. Never throws for a guard that says no; a database failure propagates. */
export async function removeRowsMissingFromWindow(
  provider: CalendarProviderName,
  userId: string,
  linkedAccountId: string,
  listing: CalendarWindowListing,
  now: Date,
): Promise<WindowRemoval> {
  if (listing.complete !== true) {
    emptyCalendarRowsSeen.delete(linkedAccountId);
    return NOTHING;
  }
  if (!isCaldavProviderKey(provider) || !caldavCalendarEnabled()) return NOTHING;

  const outcome = await removeInTransaction(provider, userId, linkedAccountId, listing, now);
  if ("refused" in outcome) {
    reportValve(provider, userId, linkedAccountId, outcome.refused);
    return NOTHING;
  }
  if ("awaitingConfirmation" in outcome) {
    console.log(
      `[CALENDAR] empty calendar ${userId}:${linkedAccountId} rows=${outcome.awaitingConfirmation} kept until the next sync confirms it`,
    );
    return NOTHING;
  }
  if (outcome.removed > 0) {
    const held = outcome.held > 0 ? ` heldUntilConfirmed=${outcome.held}` : "";
    console.log(
      `[CALENDAR] vanished events removed ${userId}:${linkedAccountId} rows=${outcome.removed} attentionResolved=${outcome.resolved}${held}`,
    );
  }
  return { removed: outcome.removed, resolved: outcome.resolved };
}
