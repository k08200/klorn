/**
 * The ranked QUEUE order in SQL (docs/design/attention-engine-v3.md §3(5),
 * P3 PR2b), over the QUEUE lane view's `e` (EmailMessage) and `a`
 * (AttentionItem, LEFT JOINed, so NULL for mail the judge has not reached).
 * The same order as ranking.ts rankQueue; v3-ranked-queue-pg.test.ts pins the
 * two together:
 *  1. held first (heldAt within HELD_WINDOW_MS, still OPEN and QUEUE, no human
 *     or agent lane), but only from a sender known above the unknown prior: a
 *     stranger whose mail spent the budget ranks by score like any QUEUE mail,
 *     so strangers cannot flood the top of the list;
 *  2. held among themselves: importance desc, then held earliest first;
 *  3. the rest: importance × deadline proximity, desc;
 *  4. ties: the newer mail, then id ascending.
 */

import { Prisma } from "@prisma/client";
import { IMPORTANCE_PRIOR } from "./importance.js";
import { DEADLINE_HORIZON_MS, HELD_WINDOW_MS } from "./ranking.js";

const IMPORTANCE = Prisma.sql`COALESCE(a."v3Importance", ${IMPORTANCE_PRIOR.unknown}::double precision)`;
/** A timestamp parameter in the columns' form (TIMESTAMP(3) holding UTC). */
const utc = (at: Date) => Prisma.sql`(${at}::timestamptz AT TIME ZONE 'UTC')`;

/** item-wire.ts isShownHeld, plus a sender known above the unknown prior. */
function held(now: Date): Prisma.Sql {
  const since = new Date(now.getTime() - HELD_WINDOW_MS);
  return Prisma.sql`COALESCE(a."heldAt" IS NOT NULL AND a."heldAt" > ${utc(since)} AND a."tier" = 'QUEUE' AND a."status" = 'OPEN' AND a."isManualOverride" = false AND a."agentTierSetAt" IS NULL AND ${IMPORTANCE} > ${IMPORTANCE_PRIOR.unknown}::double precision, false)`;
}

/** ranking.ts deadlineProximity: 1 with no deadline, rising to 2 as it comes due. */
function proximity(now: Date): Prisma.Sql {
  const horizon = Prisma.sql`${DEADLINE_HORIZON_MS}::double precision`;
  const remainingMs = Prisma.sql`GREATEST(0, EXTRACT(EPOCH FROM (a."v3Due" - ${utc(now)}))::double precision * 1000)`;
  return Prisma.sql`CASE WHEN a."v3Due" IS NULL THEN 1 ELSE 1 + GREATEST(0, (${horizon} - ${remainingMs}) / ${horizon}) END`;
}

/** ORDER BY body for a flat QUEUE page (and the neighbours' row numbers). */
export function rankedOrderSql(now: Date): Prisma.Sql {
  const isHeld = held(now);
  return Prisma.sql`${isHeld} DESC,
    CASE WHEN ${isHeld} THEN ${IMPORTANCE} END DESC NULLS LAST,
    CASE WHEN ${isHeld} THEN a."heldAt" END ASC NULLS LAST,
    CASE WHEN ${isHeld} THEN NULL ELSE ${IMPORTANCE} * ${proximity(now)} END DESC NULLS LAST,
    e."receivedAt" DESC, e."id" ASC`;
}

/** The rank keys as columns, for a grouped (thread) page's inner select. */
export function rankKeyColumnsSql(now: Date): Prisma.Sql {
  return Prisma.sql`,
    ${held(now)} AS "rkHeld",
    ${IMPORTANCE} AS "rkImportance",
    a."heldAt" AS "rkHeldAt",
    ${IMPORTANCE} * ${proximity(now)} AS "rkScore"`;
}

/** ORDER BY body over rankKeyColumnsSql's aliases plus "receivedAt" and id. */
export const RANKED_GROUPED_ORDER = Prisma.sql`"rkHeld" DESC,
    CASE WHEN "rkHeld" THEN "rkImportance" END DESC NULLS LAST,
    CASE WHEN "rkHeld" THEN "rkHeldAt" END ASC NULLS LAST,
    CASE WHEN "rkHeld" THEN NULL ELSE "rkScore" END DESC NULLS LAST,
    "receivedAt" DESC, id ASC`;
