/**
 * The kill switch for attention items that mirror a calendar event.
 *
 * `judge/attention-mirror.ts` copies an event's title into a `CALENDAR_EVENT`
 * AttentionItem. A reader that shows open items of every source (the briefing's
 * "needs attention") would keep showing that title after the event itself was
 * hidden by `calendarSourceScope()`: with an Outlook flag off, or the linked sync
 * never on, a work meeting's name would still reach the screen and the model. So a
 * reader of such items passes them through here and drops the ones whose event is
 * not visible.
 *
 * One batch lookup for the whole list (none when no item is calendar-sourced),
 * scoped to the user and, through `calendarSourceScope()`, to the rows
 * `isCalendarRowVisible` would accept. An item whose event no longer exists drops
 * out as well, as it does in the inbox summary (pim/inbox-summary.ts). Primary
 * Google and LOCAL rows are always visible, so items of those events, and items of
 * every other source, pass through unchanged and in order.
 */

import { prisma } from "../db.js";
import { calendarSourceScope } from "./calendar-scope.js";

const CALENDAR_EVENT_SOURCE = "CALENDAR_EVENT";

interface AttentionRef {
  readonly source: string;
  readonly sourceId: string;
}

export async function withoutHiddenCalendarItems<T extends AttentionRef>(
  userId: string,
  items: readonly T[],
): Promise<T[]> {
  const eventIds = [
    ...new Set(
      items.filter((item) => item.source === CALENDAR_EVENT_SOURCE).map((item) => item.sourceId),
    ),
  ];
  if (eventIds.length === 0) return [...items];

  const visible = await prisma.calendarEvent.findMany({
    where: { userId, id: { in: eventIds }, ...calendarSourceScope() },
    select: { id: true },
  });
  const visibleIds = new Set(visible.map((row) => row.id));
  return items.filter(
    (item) => item.source !== CALENDAR_EVENT_SOURCE || visibleIds.has(item.sourceId),
  );
}
