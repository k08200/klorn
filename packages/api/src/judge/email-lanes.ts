/**
 * Batched AttentionItem→lane join for mail-list rows. The web inbox renders
 * the lane as a chip next to the sender (the desktop shell's row-signal
 * doctrine, #1267): chips are observability, not control flow — a lookup
 * failure renders no chips and never 500s the inbox, and a row with no
 * AttentionItem gets no lane rather than a guessed one.
 */

import type { EmailLaneCounts, LiveTier } from "@klorn/contract";
import { Prisma } from "@prisma/client";
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

/** What Mail's lane control can ask for: one live lane, or every lane. */
export const LANE_FILTERS = ["PUSH", "MEETING", "QUEUE", "INFO", "SILENT", "ALL"] as const;
export type LaneFilter = (typeof LANE_FILTERS)[number];

/** A `?tier=` value as a lane filter; null when it is not one (retired AUTO / CALL included). */
export function parseLaneFilter(value: unknown): LaneFilter | null {
  return (LANE_FILTERS as readonly unknown[]).includes(value) ? (value as LaneFilter) : null;
}

/**
 * Stored `AttentionItem.tier` values per live lane, mirroring `toLiveTier`:
 * CALL reads as PUSH, and everything not listed here — QUEUE, the retired
 * AUTO, null, an unknown string — reads as QUEUE.
 */
const STORED_TIERS: Record<Exclude<LiveTier, "QUEUE">, readonly string[]> = {
  PUSH: ["PUSH", "CALL"],
  MEETING: ["MEETING"],
  INFO: ["INFO"],
  SILENT: ["SILENT"],
};
const NON_QUEUE_STORED_TIERS = Object.values(STORED_TIERS).flat();

/**
 * How many of a lane's newest items the list filter considers. The lane lives
 * on AttentionItem, which has no relation to EmailMessage, so the filter is an
 * id list; this keeps it far below the driver's bind-parameter limit. A lane
 * view therefore reaches back 5,000 mails (100 pages) — older mail stays
 * reachable through "All" and search.
 */
export const LANE_FILTER_WINDOW = 5000;

/**
 * The mail ids in a lane, newest first, for the list filter. Unlike the chip
 * lookup above this is control flow: a failure throws, so the caller never
 * serves an unfiltered list as if it were the lane.
 */
export async function listEmailIdsInLane(userId: string, lane: LiveTier): Promise<string[]> {
  const tierWhere =
    lane === "QUEUE"
      ? { OR: [{ tier: null }, { tier: { notIn: NON_QUEUE_STORED_TIERS } }] }
      : { tier: { in: [...STORED_TIERS[lane]] } };
  const rows = await prisma.attentionItem.findMany({
    where: { userId, source: "EMAIL", ...tierWhere },
    select: { sourceId: true },
    orderBy: { surfacedAt: "desc" },
    take: LANE_FILTER_WINDOW,
  });
  return rows.map((row) => row.sourceId);
}

export function emptyLaneCounts(): EmailLaneCounts {
  return {
    PUSH: { total: 0, unread: 0 },
    MEETING: { total: 0, unread: 0 },
    QUEUE: { total: 0, unread: 0 },
    INFO: { total: 0, unread: 0 },
    SILENT: { total: 0, unread: 0 },
  };
}

/** Fold per-stored-value rows into the five live lanes. */
export function foldLaneCounts(
  rows: ReadonlyArray<{ tier: string | null; total: number; unread: number }>,
): EmailLaneCounts {
  const counts = emptyLaneCounts();
  for (const row of rows) {
    const lane = toLiveTier(row.tier);
    counts[lane] = {
      total: counts[lane].total + Number(row.total),
      unread: counts[lane].unread + Number(row.unread),
    };
  }
  return counts;
}

/**
 * Mail per lane (total and unread) in one grouped query, scoped to the caller
 * and, optionally, to one connected account — the same `inbox` values as the
 * list: absent / "all", "primary", or a linked inbox id. Every value is a bound
 * parameter; the user id on both sides of the join is the ownership guard.
 */
export async function countEmailsByLane(
  userId: string,
  inbox: string | undefined,
): Promise<EmailLaneCounts> {
  const inboxScope =
    inbox === "primary"
      ? Prisma.sql`AND e."linkedInboxAccountId" IS NULL`
      : inbox && inbox !== "all"
        ? Prisma.sql`AND e."linkedInboxAccountId" = ${inbox}`
        : Prisma.empty;
  const rows = await prisma.$queryRaw<
    Array<{ tier: string | null; total: number; unread: number }>
  >(Prisma.sql`
    SELECT a."tier" AS tier,
           COUNT(*)::int AS total,
           (COUNT(*) FILTER (WHERE e."isRead" = false))::int AS unread
    FROM "AttentionItem" a
    JOIN "EmailMessage" e ON e."id" = a."sourceId" AND e."userId" = a."userId"
    WHERE a."userId" = ${userId}
      AND a."source" = 'EMAIL'
      ${inboxScope}
    GROUP BY a."tier"
  `);
  return foldLaneCounts(rows);
}
