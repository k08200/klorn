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
 * Which of the caller's accounts a lane query is scoped to. `unknown` is an id
 * that is not one of the caller's linked inboxes: it matches nothing, and the
 * callers answer it with an explicit empty result without querying mail.
 */
export type InboxScope =
  | { kind: "all" }
  | { kind: "primary" }
  | { kind: "linked"; id: string }
  | { kind: "unknown" };

/** Resolve the list API's `inbox` value, checking a linked id against its owner. */
export async function resolveInboxScope(
  userId: string,
  inbox: string | undefined,
): Promise<InboxScope> {
  if (!inbox || inbox === "all") return { kind: "all" };
  if (inbox === "primary") return { kind: "primary" };
  const account = await prisma.linkedInboxAccount.findFirst({
    where: { id: inbox, userId },
    select: { id: true },
  });
  return account ? { kind: "linked", id: account.id } : { kind: "unknown" };
}

function inboxSql(scope: InboxScope): Prisma.Sql {
  if (scope.kind === "primary") return Prisma.sql`AND e."linkedInboxAccountId" IS NULL`;
  if (scope.kind === "linked") return Prisma.sql`AND e."linkedInboxAccountId" = ${scope.id}`;
  return Prisma.empty;
}

/** The mail's own AttentionItem: same owner on both sides, at most one row. */
const LANE_JOIN_ON = Prisma.sql`a."sourceId" = e."id" AND a."userId" = e."userId" AND a."source" = 'EMAIL'`;

/**
 * Join and predicate for one lane. QUEUE is the visible default, so it also
 * holds mail the judge has not reached (no AttentionItem row): a LEFT JOIN
 * keeps those rows, and they carry no lane on the wire. Every other lane is
 * judged mail only.
 */
function laneSql(lane: LiveTier): { join: Prisma.Sql; predicate: Prisma.Sql } {
  if (lane === "QUEUE") {
    return {
      join: Prisma.sql`LEFT JOIN "AttentionItem" a ON ${LANE_JOIN_ON}`,
      predicate: Prisma.sql`AND (a."id" IS NULL OR a."tier" IS NULL OR a."tier" NOT IN (${Prisma.join(NON_QUEUE_STORED_TIERS)}))`,
    };
  }
  return {
    join: Prisma.sql`INNER JOIN "AttentionItem" a ON ${LANE_JOIN_ON}`,
    predicate: Prisma.sql`AND a."tier" IN (${Prisma.join([...STORED_TIERS[lane]])})`,
  };
}

/** The legacy `filter` values a lane page can be narrowed by. */
// A Map, not an object: `filter` comes from the query string, and an object
// lookup would also answer for inherited keys ("constructor", "__proto__").
const LANE_PAGE_FILTERS: ReadonlyMap<string, Prisma.Sql> = new Map([
  ["unread", Prisma.sql`AND e."isRead" = false`],
  ["urgent", Prisma.sql`AND e."priority" = 'URGENT'`],
  ["reply-needed", Prisma.sql`AND e."needsReply" = true`],
  [
    "attachments",
    Prisma.sql`AND EXISTS (SELECT 1 FROM "EmailAttachment" x WHERE x."emailId" = e."id")`,
  ],
]);

/** False for a `filter` the lane page cannot apply (candidates); absent is fine. */
export function isLanePageFilter(filter: string | undefined): boolean {
  return !filter || LANE_PAGE_FILTERS.has(filter);
}

/** `%term%` with LIKE's own wildcards escaped, as Prisma's `contains` does. */
function containsPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** The same fields as the list's Prisma search (emailSearchOr in routes/email.ts). */
function searchSql(search: string | undefined): Prisma.Sql {
  if (!search) return Prisma.empty;
  const like = containsPattern(search);
  return Prisma.sql`AND (
    e."subject" ILIKE ${like} OR e."from" ILIKE ${like} OR e."snippet" ILIKE ${like}
    OR e."body" ILIKE ${like} OR e."summary" ILIKE ${like}
    OR EXISTS (
      SELECT 1 FROM "EmailAttachment" x
      WHERE x."emailId" = e."id"
        AND (x."filename" ILIKE ${like} OR x."summary" ILIKE ${like} OR x."contentText" ILIKE ${like})
    )
  )`;
}

export interface LanePageQuery {
  userId: string;
  lane: LiveTier;
  scope: InboxScope;
  filter?: string;
  category?: string;
  search?: string;
  skip: number;
  take: number;
}

/**
 * One page of a lane: mail ids newest first, and how many there are in all.
 *
 * The lane lives on AttentionItem, which has no Prisma relation to
 * EmailMessage, so the page is a join rather than an id list — no cap on how
 * far back a lane reaches, and `total` is the same count the lane control
 * shows. Every value is a bound parameter and the user id is on both sides of
 * the join. Unlike the chip lookup above this is control flow: a failure
 * throws, so the caller never serves an unfiltered list as if it were the lane.
 */
export async function pageEmailIdsInLane(
  query: LanePageQuery,
): Promise<{ ids: string[]; total: number }> {
  if (query.scope.kind === "unknown") return { ids: [], total: 0 };
  const { join, predicate } = laneSql(query.lane);
  const from = Prisma.sql`FROM "EmailMessage" e
    ${join}
    WHERE e."userId" = ${query.userId}
      ${predicate}
      ${inboxSql(query.scope)}
      ${(query.filter && LANE_PAGE_FILTERS.get(query.filter)) || Prisma.empty}
      ${query.category ? Prisma.sql`AND e."category" = ${query.category}` : Prisma.empty}
      ${searchSql(query.search)}`;
  const [rows, totals] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT e."id" AS id
      ${from}
      ORDER BY e."receivedAt" DESC, e."id" DESC
      LIMIT ${query.take} OFFSET ${query.skip}`),
    prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS total
      ${from}`),
  ]);
  return { ids: rows.map((row) => row.id), total: Number(totals[0]?.total ?? 0) };
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
 * and, optionally, to one of their accounts. It starts from the mail and joins
 * the lane on, so every mail is counted exactly once: one the judge has not
 * reached groups under a null tier, which folds to QUEUE — the lanes therefore
 * sum to All, and each lane's total is its list's total. Every value is a
 * bound parameter; the user id on both sides of the join is the ownership guard.
 */
export async function countEmailsByLane(
  userId: string,
  scope: InboxScope,
): Promise<EmailLaneCounts> {
  if (scope.kind === "unknown") return emptyLaneCounts();
  const rows = await prisma.$queryRaw<
    Array<{ tier: string | null; total: number; unread: number }>
  >(Prisma.sql`
    SELECT a."tier" AS tier,
           COUNT(*)::int AS total,
           (COUNT(*) FILTER (WHERE e."isRead" = false))::int AS unread
    FROM "EmailMessage" e
    LEFT JOIN "AttentionItem" a ON ${LANE_JOIN_ON}
    WHERE e."userId" = ${userId}
      ${inboxSql(scope)}
    GROUP BY a."tier"
  `);
  return foldLaneCounts(rows);
}
