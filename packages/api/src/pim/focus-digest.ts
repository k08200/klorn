/**
 * Focus-window digest (design 2026-08-21, derived from the "Focus Window"
 * expectation in third-party coverage): while a calendar block runs, the
 * notification gate (notification-prefs.ts) holds back non-urgent pushes;
 * when the block ENDS, this sweep releases ONE summary — "while you
 * focused: N queued, M filed" — instead of a drip of stale interrupts.
 *
 * Idempotent per event: the Notification dedupeKey `focus:<eventId>` plus
 * the create-catch-P2002 idiom means a scheduler restart or overlapping
 * tick can never double-notify.
 */

import { prisma } from "../db.js";
import { isUserInFocusBlock } from "../notify/notification-prefs.js";
import { sendPushNotification } from "../notify/push.js";
import { dedupeCalendarEvents } from "./calendar-dedupe.js";
import { calendarSourceScope } from "./calendar-scope.js";

/** Lookback slack: two ticks, so a slow tick never drops an ended block. */
export const FOCUS_DIGEST_LOOKBACK_MS = 3 * 60_000;

const DIGEST_TIERS = ["QUEUE", "INFO", "MEETING"] as const;

export async function sendFocusWindowDigests(now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - FOCUS_DIGEST_LOOKBACK_MS);
  const endedRows = await prisma.calendarEvent.findMany({
    where: {
      allDay: false,
      endTime: { gt: since, lte: now },
      user: { automationConfig: { focusWindowEnabled: true } },
      ...calendarSourceScope(),
    },
    // The identity fields let a block present in the primary and a linked
    // calendar (two rows, C2) produce one digest: its dedupeKey is per row id.
    select: {
      id: true,
      userId: true,
      startTime: true,
      endTime: true,
      provider: true,
      externalId: true,
      sourceAccountId: true,
    },
  });
  const ended = dedupeCalendarEvents(endedRows);
  let sent = 0;
  for (const event of ended) {
    try {
      // Back-to-back blocks: stay quiet until the LAST one ends.
      if (await isUserInFocusBlock(event.userId, now)) continue;

      const arrived = await prisma.attentionItem.count({
        where: {
          userId: event.userId,
          tier: { in: [...DIGEST_TIERS] },
          surfacedAt: { gte: event.startTime, lte: event.endTime },
        },
      });
      if (arrived === 0) continue;

      try {
        await prisma.notification.create({
          data: {
            userId: event.userId,
            type: "email",
            dedupeKey: `focus:${event.id}`,
            title: "While you focused",
            message: `${arrived} new item(s) arrived and were held — they're waiting in your lanes.`,
            link: "/",
          },
          select: { id: true },
        });
      } catch (err) {
        if ((err as { code?: string })?.code === "P2002") continue; // already sent
        throw err;
      }
      await sendPushNotification(
        event.userId,
        {
          title: "While you focused",
          body: `${arrived} new item(s) were held for you — nothing urgent slipped by.`,
        },
        "system",
      );
      sent++;
    } catch (err) {
      // One user's failure must not starve the rest of the sweep.
      console.warn(`[FOCUS] digest failed for user ${event.userId}:`, err);
    }
  }
  return sent;
}
