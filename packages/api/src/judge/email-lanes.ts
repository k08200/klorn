/**
 * Batched AttentionItem→lane join for mail-list rows. The web inbox renders
 * the lane as a chip next to the sender (the desktop shell's row-signal
 * doctrine, #1267): chips are observability, not control flow — a lookup
 * failure renders no chips and never 500s the inbox, and a row with no
 * AttentionItem gets no lane rather than a guessed one.
 */

import type { LiveTier } from "@klorn/contract";
import { prisma } from "../db.js";
import { captureError } from "../sentry.js";
import { toLiveTier } from "./tiers.js";

/**
 * Map each email id on a list page to its normalized lane. Deliberately no
 * `status` filter (briefing.ts precedent): the tier is the classification of
 * the email, still true after the item is resolved or snoozed.
 */
export async function listLaneTiersByEmail(
  userId: string,
  emailIds: string[],
): Promise<Map<string, LiveTier>> {
  if (emailIds.length === 0) return new Map();
  try {
    const rows = (await prisma.attentionItem.findMany({
      where: { userId, source: "EMAIL", sourceId: { in: emailIds } },
      select: { sourceId: true, tier: true },
    })) as Array<{ sourceId: string; tier: string | null }>;
    const laneBySourceId = new Map<string, LiveTier>();
    for (const row of rows) {
      // AUTO is retired v1 vocabulary and must never reach a user-facing
      // chip; toLiveTier folds it into QUEUE, the visible default.
      laneBySourceId.set(row.sourceId, toLiveTier(row.tier));
    }
    return laneBySourceId;
  } catch (err) {
    captureError(err, { tags: { scope: "email.lane_lookup" }, extra: { userId } });
    return new Map();
  }
}
