/**
 * IP24 — interrupt precision within 24h: of the interrupts Klorn rang, how
 * many the user answered (or confirmed) within a day, next to the same number
 * for what Gmail's "High priority only" setting would have rung.
 *
 * Definitions (all over the DecisionLabel ledger, EMAIL rows judged in the
 * window, read inside a READ ONLY transaction):
 *  - Ring (Klorn): a row with `rangAt`, i.e. Klorn's mail interrupt got past
 *    every hold gate (noise policy, preferences and quiet hours, rate limit)
 *    and went to the user's channels. Stamped by the firewall PUSH/MEETING push,
 *    by the quiet-hours summary when held PUSH mail rings after quiet hours
 *    end, and by the urgent sweep's safety net (which also rings
 *    keyword-fallback QUEUE mail during a judge outage; those are counted, and
 *    shown apart as "other lane", as are rings whose lane a later re-judge
 *    changed). A held interrupt that never rang has no `rangAt`.
 *  - Ring (Gmail baseline): a row whose `gmailImportant` snapshot is true:
 *    Gmail had marked the inbox mail IMPORTANT when Klorn first judged it,
 *    within 6h of arrival (gmail-important-snapshot.ts).
 *  - Hit: answered in the 24h after the ring (in Klorn or in Gmail, the
 *    earlier of repliedAt / providerRepliedAt), or the user's explicit lane
 *    judgement put it in a lane that rings (CONFIRM:/OVERRIDE: PUSH or
 *    MEETING) in that window. Before the ring does not count: the ring did not
 *    cause it. The ring time is `rangAt` for Klorn and `judgedAt` for Gmail.
 *  - Denominator: rings at least 24h old (ring time <= min(until, now) - 24h).
 *  - IP24 = hits / rings, pooled, and per user; the median is over users with
 *    at least one ring. Always printed with N.
 *  - Guardrail, misses per 100 rings: rows at least 24h old that did not ring
 *    (Klorn: no `rangAt`; Gmail: `gmailImportant` false) but that the user put
 *    in a ringing lane (CONFIRM:/OVERRIDE: PUSH or MEETING, any time) or
 *    answered within 2h of the judgement.
 *  - Opened within 24h is shown apart and never counted as a hit: the
 *    notification itself causes the open.
 *
 * Comparison set: rows with a Gmail snapshot (`gmailImportant` not null), so
 * both sides measure the same mail: Gmail mail judged since migration
 * 20261112020000. Rings on other mail (IMAP, Outlook) are counted apart.
 *
 * Per user, "off-app delivery" marks a user an off-app channel (web push,
 * FCM, APNs, Telegram, a desktop receipt) took at least one push for in the
 * window (PushDeliveryLog, kept 90 days). A ring is Klorn's dispatch, not
 * proof it reached a device: a user with no channel can still ring, so the
 * off-app slice is printed beside the headline. The desktop apps' own banners
 * follow only the preferences gate, not the rate limit, and the server sees
 * none of them: a mail the rate limit held can still banner on a desktop with
 * no `rangAt`.
 *
 * Output is aggregates only: the SQL groups by user but never selects the id.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** One user's counts, as the SQL returns them. Carries no user id. */
export interface Ip24UserRow {
  klornRings: number;
  klornHits: number;
  klornOpened: number;
  klornMisses: number;
  gmailRings: number;
  gmailHits: number;
  gmailOpened: number;
  gmailMisses: number;
  /** Klorn rings (in the comparison) whose lane now is not PUSH or MEETING. */
  otherLaneRings: number;
  /**
   * Klorn rings on mail without a Gmail snapshot (IMAP, Outlook, or a row
   * created before the snapshot existed): outside the comparison.
   */
  nonGmailRings: number;
  offAppDelivery: boolean;
}

export interface Ip24UserPoint {
  ip24: number;
  n: number;
  offAppDelivery: boolean;
}

/** One side (Klorn or the Gmail baseline). Rates are null when N is 0. */
export interface Ip24Side {
  rings: number;
  hits: number;
  ip24: number | null;
  users: number;
  medianIp24: number | null;
  /** Users with at least one ring, best first. No ids. */
  perUser: Ip24UserPoint[];
  opened: number;
  openedShare: number | null;
  misses: number;
  missesPer100Rings: number | null;
}

/** The Klorn side over users an off-app channel took a push for. */
export interface Ip24OffAppSlice {
  users: number;
  rings: number;
  hits: number;
  ip24: number | null;
  medianIp24: number | null;
}

export interface Ip24Report {
  window: { since: string; until: string; matureBefore: string };
  klorn: Ip24Side & { offApp: Ip24OffAppSlice };
  gmail: Ip24Side;
  notCompared: { otherLaneRings: number; nonGmailRings: number };
}

type SideKeys = {
  rings: keyof Ip24UserRow;
  hits: keyof Ip24UserRow;
  opened: keyof Ip24UserRow;
  misses: keyof Ip24UserRow;
};

const KLORN: SideKeys = {
  rings: "klornRings",
  hits: "klornHits",
  opened: "klornOpened",
  misses: "klornMisses",
};
const GMAIL: SideKeys = {
  rings: "gmailRings",
  hits: "gmailHits",
  opened: "gmailOpened",
  misses: "gmailMisses",
};

function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** The middle value (the mean of the two middles for an even count), or null. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const sum = (rows: readonly Ip24UserRow[], key: keyof Ip24UserRow): number =>
  rows.reduce((total, row) => total + Number(row[key]), 0);

function buildSide(rows: readonly Ip24UserRow[], keys: SideKeys): Ip24Side {
  const rings = sum(rows, keys.rings);
  const hits = sum(rows, keys.hits);
  const opened = sum(rows, keys.opened);
  const misses = sum(rows, keys.misses);
  const perUser = rows
    .filter((row) => Number(row[keys.rings]) > 0)
    .map((row) => ({
      ip24: Number(row[keys.hits]) / Number(row[keys.rings]),
      n: Number(row[keys.rings]),
      offAppDelivery: row.offAppDelivery === true,
    }))
    .sort((a, b) => b.ip24 - a.ip24 || b.n - a.n);
  const missRate = ratio(misses, rings);
  return {
    rings,
    hits,
    ip24: ratio(hits, rings),
    users: perUser.length,
    medianIp24: median(perUser.map((p) => p.ip24)),
    perUser,
    opened,
    openedShare: ratio(opened, rings),
    misses,
    missesPer100Rings: missRate === null ? null : missRate * 100,
  };
}

/** Per-user counts → the report. Pure. */
export function buildIp24Report(
  rows: readonly Ip24UserRow[],
  meta: { since: Date; until: Date; matureBefore: Date },
): Ip24Report {
  const klorn = buildSide(rows, KLORN);
  const reached = buildSide(
    rows.filter((row) => row.offAppDelivery === true),
    KLORN,
  );
  return {
    window: {
      since: meta.since.toISOString(),
      until: meta.until.toISOString(),
      matureBefore: meta.matureBefore.toISOString(),
    },
    klorn: {
      ...klorn,
      offApp: {
        users: reached.users,
        rings: reached.rings,
        hits: reached.hits,
        ip24: reached.ip24,
        medianIp24: reached.medianIp24,
      },
    },
    gmail: buildSide(rows, GMAIL),
    notCompared: {
      otherLaneRings: sum(rows, "otherLaneRings"),
      nonGmailRings: sum(rows, "nonGmailRings"),
    },
  };
}

export interface Ip24Query {
  since: Date;
  until: Date;
  /**
   * Limit to these users (the CLI's --user, and test isolation). An empty list
   * means no users, never "everyone".
   */
  userIds?: readonly string[];
}

/** Rings at least 24h old: ring time at or before this instant. */
export function matureBeforeOf(until: Date, now: Date = new Date()): Date {
  return new Date(Math.min(until.getTime(), now.getTime()) - DAY_MS);
}

function ip24Sql(query: Ip24Query, matureBefore: Date): Prisma.Sql {
  const only = (column: Prisma.Sql) =>
    query.userIds
      ? Prisma.sql`AND ${column} IN (${Prisma.join([...query.userIds])})`
      : Prisma.empty;
  // The user's lane judgement put the mail in a lane that rings.
  const ringLane = Prisma.sql`d."outcome" IN ('CONFIRM:PUSH', 'OVERRIDE:PUSH', 'CONFIRM:MEETING', 'OVERRIDE:MEETING')`;
  const replied = Prisma.sql`LEAST(d."repliedAt", d."providerRepliedAt")`;
  // In the 24h after the ring, never before it.
  const within24h = (at: Prisma.Sql, ringAt: Prisma.Sql) =>
    Prisma.sql`${at} BETWEEN ${ringAt} AND ${ringAt} + INTERVAL '24 hours'`;
  const hitBy = (ringAt: Prisma.Sql) => Prisma.sql`COALESCE(${within24h(replied, ringAt)}
      OR (${ringLane} AND ${within24h(Prisma.sql`d."outcomeAt"`, ringAt)}), false)`;
  const openedBy = (ringAt: Prisma.Sql) =>
    Prisma.sql`COALESCE(${within24h(Prisma.sql`d."openedAt"`, ringAt)}, false)`;
  const missed = Prisma.sql`COALESCE(${ringLane}
      OR ${replied} <= d."judgedAt" + INTERVAL '2 hours', false)`;
  const compared = Prisma.sql`d."gmailImportant" IS NOT NULL`;
  const klornRing = Prisma.sql`${compared} AND d."rangAt" <= ${matureBefore}`;
  const gmailRing = Prisma.sql`d."gmailImportant" = true AND d."judgedAt" <= ${matureBefore}`;
  const matured = Prisma.sql`d."judgedAt" <= ${matureBefore}`;

  return Prisma.sql`
    WITH reached AS (
      SELECT DISTINCT p."userId"
      FROM "PushDeliveryLog" p
      WHERE p."createdAt" >= ${query.since} AND p."createdAt" < ${query.until}
        AND (p."status" IN ('ACCEPTED', 'REPORTED') OR p."receivedAt" IS NOT NULL)
        ${only(Prisma.sql`p."userId"`)}
    )
    SELECT
      COUNT(*) FILTER (WHERE ${klornRing})::int AS "klornRings",
      COUNT(*) FILTER (WHERE ${klornRing} AND ${hitBy(Prisma.sql`d."rangAt"`)})::int AS "klornHits",
      COUNT(*) FILTER (WHERE ${klornRing}
        AND ${openedBy(Prisma.sql`d."rangAt"`)})::int AS "klornOpened",
      COUNT(*) FILTER (WHERE ${compared} AND d."rangAt" IS NULL AND ${matured}
        AND ${missed})::int AS "klornMisses",
      COUNT(*) FILTER (WHERE ${gmailRing})::int AS "gmailRings",
      COUNT(*) FILTER (WHERE ${gmailRing} AND ${hitBy(Prisma.sql`d."judgedAt"`)})::int AS "gmailHits",
      COUNT(*) FILTER (WHERE ${gmailRing}
        AND ${openedBy(Prisma.sql`d."judgedAt"`)})::int AS "gmailOpened",
      COUNT(*) FILTER (WHERE d."gmailImportant" = false AND ${matured}
        AND ${missed})::int AS "gmailMisses",
      COUNT(*) FILTER (WHERE ${klornRing}
        AND d."shownTier" NOT IN ('PUSH', 'MEETING'))::int AS "otherLaneRings",
      COUNT(*) FILTER (WHERE d."gmailImportant" IS NULL
        AND d."rangAt" <= ${matureBefore})::int AS "nonGmailRings",
      BOOL_OR(r."userId" IS NOT NULL) AS "offAppDelivery"
    FROM "DecisionLabel" d
    LEFT JOIN reached r ON r."userId" = d."userId"
    WHERE d."source" = CAST('EMAIL' AS "AttentionSource")
      AND d."judgedAt" >= ${query.since}
      AND d."judgedAt" < ${query.until}
      ${only(Prisma.sql`d."userId"`)}
    GROUP BY d."userId"`;
}

/**
 * The per-user counts, inside a READ ONLY transaction (the database refuses a
 * write) with a statement timeout. All values are bound parameters. The rows
 * carry no user id.
 */
export async function queryIp24UserRows(
  query: Ip24Query,
  matureBefore: Date = matureBeforeOf(query.until),
): Promise<Ip24UserRow[]> {
  if (query.userIds?.length === 0) return [];
  const sql = ip24Sql(query, matureBefore);
  const [, , rows] = await prisma.$transaction([
    prisma.$executeRaw`SET TRANSACTION READ ONLY`,
    prisma.$executeRaw`SET LOCAL statement_timeout = '60s'`,
    prisma.$queryRaw<Ip24UserRow[]>(sql),
  ]);
  return rows;
}

export async function queryIp24(query: Ip24Query): Promise<Ip24Report> {
  // One cutoff for the SQL and the printed window.
  const matureBefore = matureBeforeOf(query.until);
  const rows = await queryIp24UserRows(query, matureBefore);
  return buildIp24Report(rows, { ...query, matureBefore });
}

function pct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function sideLines(label: string, side: Ip24Side): string[] {
  const per100 = side.missesPer100Rings === null ? "—" : side.missesPer100Rings.toFixed(1);
  return [
    `${label}: N=${side.rings}`,
    `  IP24 pooled            ${pct(side.ip24)} (${side.hits}/${side.rings})`,
    `  IP24 per user          median ${pct(side.medianIp24)} over ${side.users} users`,
    `  opened <24h (apart)    ${pct(side.openedShare)} (${side.opened}/${side.rings})`,
    `  misses (guardrail)     ${per100} per 100 rings (${side.misses})`,
  ];
}

function distribution(side: Ip24Side, withReach: boolean): string[] {
  if (side.perUser.length === 0) return ["  (none)"];
  return side.perUser.map((p) => {
    const reach = withReach ? ` off-app: ${p.offAppDelivery ? "yes" : "no"}` : "";
    return `  ${pct(p.ip24)} (n=${p.n})${reach}`;
  });
}

/** Plain-text rendering for the CLI. Aggregates only, no ids. Pure. */
export function renderIp24Report(report: Ip24Report): string {
  const { klorn, gmail, window } = report;
  return [
    `IP24 — EMAIL decisions judged ${window.since} … ${window.until}`,
    `Rings counted when at least 24h old (rang at or before ${window.matureBefore}).`,
    "Compared on Gmail mail with an IMPORTANT snapshot (judged since migration 20261112020000).",
    "",
    ...sideLines("Klorn rings (interrupt fired)", klorn),
    `  users an off-app channel took a push for: N=${klorn.offApp.rings}, pooled ${pct(klorn.offApp.ip24)} (${klorn.offApp.hits}/${klorn.offApp.rings}), median ${pct(klorn.offApp.medianIp24)} over ${klorn.offApp.users} users`,
    "",
    ...sideLines("Gmail IMPORTANT baseline (High priority only)", gmail),
    "",
    "Per user, Klorn (no ids, best first):",
    ...distribution(klorn, true),
    "",
    "Per user, Gmail baseline (no ids, best first):",
    ...distribution(gmail, false),
    "",
    "Outside the comparison, and lanes:",
    `  Klorn rings on mail without a Gmail snapshot (IMAP, Outlook, judged before it): ${report.notCompared.nonGmailRings}`,
    `  Klorn rings above whose lane now is not PUSH/MEETING (keyword fallback, re-judged): ${report.notCompared.otherLaneRings}`,
  ].join("\n");
}
