/**
 * Unlinking a calendar account (step C2 gate b of
 * docs/providers/unified-platform-plan.md). `/api/calendar` has no source
 * filter, so the events synced from an account must go with it; otherwise a
 * disconnected work calendar keeps showing up.
 */

import { INTERACTIVE_TX_OPTIONS, prisma } from "../db.js";

/**
 * Delete one linked calendar account and everything synced from it, in a single
 * transaction: the CalendarEvent rows tagged with the account and the
 * AttentionItems mirrored from them (AttentionItem has no foreign key to an
 * event). Scoped by userId throughout, so a caller can only remove its own
 * account, and to GOOGLE accounts, the provider this surface serves. Returns false, having deleted nothing, when the account is not the
 * user's.
 *
 * The events and their attention items go BEFORE the account. The database
 * cascades events when the account row is deleted (see the C2 migration), so
 * deleting the account first would leave nothing to look the AttentionItems up
 * by; a real-database check caught exactly that.
 */
export async function unlinkCalendarAccount(
  userId: string,
  linkedAccountId: string,
): Promise<boolean> {
  // Interactive because the AttentionItem delete needs the event ids; the
  // pool-sized options are the repo's rule for interactive transactions (#845).
  return prisma.$transaction(async (tx) => {
    // GOOGLE only, like the route's own list: this is the Google linked-calendars
    // surface, so it can never remove another provider's account by id.
    const account = await tx.linkedCalendarAccount.findFirst({
      where: { id: linkedAccountId, userId, provider: "GOOGLE" },
      select: { id: true },
    });
    if (!account) return false;

    const events = await tx.calendarEvent.findMany({
      where: { userId, sourceAccountId: linkedAccountId },
      select: { id: true },
    });
    if (events.length > 0) {
      await tx.attentionItem.deleteMany({
        where: {
          userId,
          source: "CALENDAR_EVENT",
          sourceId: { in: events.map((event) => event.id) },
        },
      });
    }
    await tx.calendarEvent.deleteMany({ where: { userId, sourceAccountId: linkedAccountId } });

    // The count, not the lookup above, decides: a concurrent unlink that got
    // here second deleted nothing and answers "not found".
    const removed = await tx.linkedCalendarAccount.deleteMany({
      where: { id: linkedAccountId, userId, provider: "GOOGLE" },
    });
    return removed.count > 0;
  }, INTERACTIVE_TX_OPTIONS);
}
