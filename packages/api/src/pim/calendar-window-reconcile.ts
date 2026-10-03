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
 * The removal and the resolution of the rows' open attention items are one
 * transaction, like the C2b removal.
 */

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

export function _resetDeletionValveForTests(): void {
  reportedAccounts.clear();
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

/** The ids of the window's rows the listing shows to be gone (see the header). */
function vanishedRows(inWindow: readonly WindowRow[], listing: CalendarWindowListing): string[] {
  const present = new Set(listing.events.map((event) => event.externalId).filter(Boolean));
  const read = new Set(listing.calendarKeys ?? []);
  return inWindow
    .filter((row) => row.updatedAt.getTime() < listing.listedAt.getTime())
    .filter((row) => row.caldavCalendarKey !== null && read.has(row.caldavCalendarKey))
    .filter((row) => row.externalId !== null && !present.has(row.externalId))
    .map((row) => row.id);
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

type Outcome = WindowRemoval | { readonly refused: ValveCounts };

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
    const gone = vanishedRows(inWindow, listing);
    if (gone.length === 0) return NOTHING;
    if (isOverDeletionValve(gone.length, inWindow.length)) {
      return { refused: { gone: gone.length, inWindow: inWindow.length } };
    }
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
    return { removed: removed.count, resolved: resolved.count };
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
  if (listing.complete !== true) return NOTHING;
  if (!isCaldavProviderKey(provider) || !caldavCalendarEnabled()) return NOTHING;

  const outcome = await removeInTransaction(provider, userId, linkedAccountId, listing, now);
  if ("refused" in outcome) {
    reportValve(provider, userId, linkedAccountId, outcome.refused);
    return NOTHING;
  }
  if (outcome.removed > 0) {
    console.log(
      `[CALENDAR] vanished events removed ${userId}:${linkedAccountId} rows=${outcome.removed} attentionResolved=${outcome.resolved}`,
    );
  }
  return outcome;
}
