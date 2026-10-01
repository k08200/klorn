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
 *     concurrent sync just wrote is never taken for a vanished one.
 * The removal and the resolution of the rows' open attention items are one
 * transaction, like the C2b removal.
 */

import { caldavCalendarEnabled } from "../config.js";
import { INTERACTIVE_TX_OPTIONS, prisma } from "../db.js";
import { isCaldavProviderKey } from "./caldav/caldav-providers.js";
import { overlapsWindow } from "./caldav/ical-events.js";
import type { CalendarWindowListing } from "./calendar-providers/types.js";
import { type CalendarProviderName, linkedSourceScope } from "./calendar-rows.js";

export interface WindowRemoval {
  readonly removed: number;
  readonly resolved: number;
}

const NOTHING: WindowRemoval = { removed: 0, resolved: 0 };

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

  const window = { start: new Date(listing.window.timeMin), end: new Date(listing.window.timeMax) };
  const present = new Set(listing.events.map((event) => event.externalId).filter(Boolean));

  const removal = await prisma.$transaction(async (tx) => {
    const candidates = await tx.calendarEvent.findMany({
      where: {
        ...linkedSourceScope(provider, userId, linkedAccountId),
        startTime: { lt: window.end },
        endTime: { gte: window.start },
        updatedAt: { lt: listing.listedAt },
      },
      select: { id: true, externalId: true, startTime: true, endTime: true },
    });
    const gone = candidates
      .filter((row) => row.externalId !== null && !present.has(row.externalId))
      .filter((row) => overlapsWindow(row.startTime, row.endTime, window))
      .map((row) => row.id);
    if (gone.length === 0) return NOTHING;

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

  if (removal.removed > 0) {
    console.log(
      `[CALENDAR] vanished events removed ${userId}:${linkedAccountId} rows=${removal.removed} attentionResolved=${removal.resolved}`,
    );
  }
  return removal;
}
