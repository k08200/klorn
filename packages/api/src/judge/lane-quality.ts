/**
 * Lane-quality report — what users actually did with the mail in each lane.
 *
 * Reads the DecisionLabel ledger only: the shown lane (shownTier), the path
 * that decided it (decidedBy), the engagement columns stampDecisionOutcome
 * fills (openedAt, repliedAt, …), the provider-side columns sync fills
 * (providerRepliedAt, providerArchivedAt) and the explicit lane judgements in
 * `outcome` (OVERRIDE:/CONFIRM:). Answers "is PUSH mail acted on?" and "is SILENT mail
 * ever opened?" — not "was the lane right?" (that is decision-metrics, from
 * confirmed overrides only).
 *
 * Read-only by construction: the queries run inside a READ ONLY transaction,
 * so the database itself refuses a write. Safe against prod.
 *
 * Caveats the numbers carry:
 *  - Engagement stamping started with migration 20261108120000. Rows judged
 *    before it have no signals, so pass a window that starts after deploy.
 *  - "Replied within 24h" counts only rows judged at least 24h before
 *    min(`until`, now) (the denominator is `matured`), so a fresh row isn't
 *    counted as unreplied.
 *  - A re-judge rewrites shownTier/decidedBy in place, so a re-judged row is
 *    reported under its latest lane.
 *  - The main table counts only actions taken in Klorn. Web AI-draft replies
 *    (POST /send with inReplyToEmailId) count from #1656 on; ones sent before
 *    it are missing.
 *  - The provider table counts what sync saw the user do in Gmail itself, from
 *    migration 20261110000000 on (rows judged before it can still be stamped
 *    by a later action), and only where Klorn recorded no signal of that kind:
 *    it is what a Klorn-only count misses, so "in Klorn" + "provider only" =
 *    "either". This also keeps a Klorn reply or archive that sync happened to
 *    see first from counting twice.
 *      - Gmail only: Outlook and IMAP have no Sent scan or INBOX diff yet. The
 *        denominators still include their mail, so a user with mixed
 *        accounts shows lower provider shares.
 *      - Replied: the user's own send (Sent-folder scan, no Klorn origin) in
 *        the mail's thread, stamped on the newest mail that arrived before it,
 *        at its sentAt, and never before the judgement. The scan reads the
 *        newest Sent page every 30 minutes, so a burst of more than one page
 *        between scans is missed. A forward kept in the thread counts as a
 *        reply. The scheduler runs the scan before the reconcile in the same
 *        tick, so a reply then archive is seen as both; a reconcile started
 *        from Klorn (POST /sync, /reconcile) can remove the mail first and
 *        lose the reply. A sender who joins the thread can be the newest mail
 *        a reply is stamped on.
 *      - Archived: the mail left the INBOX outside Klorn (archive, a label
 *        move or trash; spam and mail gone for good are skipped), stamped when
 *        the 30-minute reconcile saw it. Gmail's own Snooze also takes mail
 *        out of the INBOX and may be counted, and so may a Subscriptions
 *        sender-wide archive that a reconcile caught mid-run (Klorn does not
 *        stamp those). At most 100 per account per reconcile are checked; a
 *        larger mass archive is under-counted.
 *      - Read in Gmail is not counted: the provider marks mail read on preview
 *        and on "mark all as read", so it is not an open.
 *  - The "either" columns count a row once if either source has the signal;
 *    replied<24h there uses the earlier of the two reply times.
 *  - "Opened" means the reader showed the mail: the Mac app also shows the
 *    mail its arrow keys land on. A mail read only through the thread view
 *    (GET /api/email/thread/:threadId) is not counted. Mobile builds from before ?purpose=attachments
 *    count the Files tab's background reads (up to 8 mails) as opens.
 *  - Archive and trash both count as archived. An undone archive keeps the
 *    stamp on the original row (the restored mail is a new row).
 */

import type { LiveTier } from "@klorn/contract";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import type { AttentionSourceName } from "./decision-label.js";
import { toLiveTier } from "./tiers.js";

/** The five lanes, loudest first. Every report lists all five, even empty. */
export const REPORT_LANES = [
  "PUSH",
  "MEETING",
  "QUEUE",
  "INFO",
  "SILENT",
] as const satisfies readonly LiveTier[];

const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Raw counters for one (lane, decidedBy) cell — what the SQL returns. */
export interface LaneCounts {
  judged: number;
  /** Rows judged ≥24h before the window end: the replied-within-24h denominator. */
  matured: number;
  anyOutcome: number;
  opened: number;
  replied24h: number;
  archived: number;
  dismissed: number;
  snoozed: number;
  starred: number;
  unsubscribed: number;
  overridden: number;
  confirmed: number;
  /**
   * Matured rows answered from Gmail itself within 24h that Klorn did not see
   * answered within 24h: what a Klorn-only count misses.
   */
  providerOnlyReplied24h: number;
  /** Rows that left the Gmail INBOX outside Klorn and that Klorn never archived. */
  providerOnlyArchived: number;
  /** Matured rows answered within 24h from either source (the earlier reply). */
  replied24hEither: number;
  /** Rows archived from either source. */
  archivedEither: number;
  /** Rows with any Klorn signal or any provider signal. */
  anyEither: number;
}

export interface LaneCountRow extends LaneCounts {
  shownTier: string;
  decidedBy: string;
}

export interface OverrideFlowRow {
  fromTier: string;
  toTier: string;
  count: number;
}

/** Shares are null when their denominator is 0 — never a fake 0%. */
export interface LaneShares {
  anyOutcome: number | null;
  opened: number | null;
  replied24h: number | null;
  archived: number | null;
  dismissed: number | null;
  snoozed: number | null;
  starred: number | null;
  unsubscribed: number | null;
  providerOnlyReplied24h: number | null;
  providerOnlyArchived: number | null;
  replied24hEither: number | null;
  archivedEither: number | null;
  anyEither: number | null;
}

export interface LaneStats extends LaneCounts {
  lane: LiveTier;
  shares: LaneShares;
}

export interface LaneDecidedByStats extends LaneStats {
  decidedBy: string;
}

export interface OverrideFlow {
  from: LiveTier;
  to: LiveTier;
  count: number;
}

export interface LaneQualityReport {
  window: { since: string; until: string };
  source: AttentionSourceName;
  lanes: LaneStats[];
  byDecidedBy: LaneDecidedByStats[];
  overrideFlows: OverrideFlow[];
}

const COUNT_KEYS = [
  "judged",
  "matured",
  "anyOutcome",
  "opened",
  "replied24h",
  "archived",
  "dismissed",
  "snoozed",
  "starred",
  "unsubscribed",
  "overridden",
  "confirmed",
  "providerOnlyReplied24h",
  "providerOnlyArchived",
  "replied24hEither",
  "archivedEither",
  "anyEither",
] as const satisfies readonly (keyof LaneCounts)[];

function emptyCounts(): LaneCounts {
  return Object.fromEntries(COUNT_KEYS.map((k) => [k, 0])) as unknown as LaneCounts;
}

function addCounts(a: LaneCounts, b: LaneCounts): LaneCounts {
  return Object.fromEntries(
    COUNT_KEYS.map((k) => [k, a[k] + Number(b[k])]),
  ) as unknown as LaneCounts;
}

function share(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

function sharesOf(c: LaneCounts): LaneShares {
  return {
    anyOutcome: share(c.anyOutcome, c.judged),
    opened: share(c.opened, c.judged),
    replied24h: share(c.replied24h, c.matured),
    archived: share(c.archived, c.judged),
    dismissed: share(c.dismissed, c.judged),
    snoozed: share(c.snoozed, c.judged),
    starred: share(c.starred, c.judged),
    unsubscribed: share(c.unsubscribed, c.judged),
    providerOnlyReplied24h: share(c.providerOnlyReplied24h, c.matured),
    providerOnlyArchived: share(c.providerOnlyArchived, c.judged),
    replied24hEither: share(c.replied24hEither, c.matured),
    archivedEither: share(c.archivedEither, c.judged),
    anyEither: share(c.anyEither, c.judged),
  };
}

const laneOrder = (lane: LiveTier): number => REPORT_LANES.indexOf(lane);

/**
 * Fold raw (storage-tier, decidedBy) counts into the five live lanes. Legacy
 * AUTO folds into QUEUE and CALL into PUSH, exactly as every user-facing read
 * does, so the report's lanes are the ones the user saw. Pure.
 */
export function buildLaneQualityReport(
  rows: readonly LaneCountRow[],
  flowRows: readonly OverrideFlowRow[],
  meta: { since: Date; until: Date; source: AttentionSourceName },
): LaneQualityReport {
  const byLane = new Map<LiveTier, LaneCounts>(REPORT_LANES.map((l) => [l, emptyCounts()]));
  const byCell = new Map<string, { lane: LiveTier; decidedBy: string; counts: LaneCounts }>();

  for (const row of rows) {
    const lane = toLiveTier(row.shownTier);
    byLane.set(lane, addCounts(byLane.get(lane) ?? emptyCounts(), row));
    const key = `${lane}\u0000${row.decidedBy}`;
    const cell = byCell.get(key) ?? { lane, decidedBy: row.decidedBy, counts: emptyCounts() };
    byCell.set(key, { ...cell, counts: addCounts(cell.counts, row) });
  }

  const lanes = REPORT_LANES.map((lane) => {
    const counts = byLane.get(lane) ?? emptyCounts();
    return { lane, ...counts, shares: sharesOf(counts) };
  });

  const byDecidedBy = [...byCell.values()]
    .map(({ lane, decidedBy, counts }) => ({
      lane,
      decidedBy,
      ...counts,
      shares: sharesOf(counts),
    }))
    .sort((a, b) => laneOrder(a.lane) - laneOrder(b.lane) || b.judged - a.judged);

  const flows = new Map<string, OverrideFlow>();
  for (const row of flowRows) {
    const from = toLiveTier(row.fromTier);
    const to = toLiveTier(row.toTier);
    const key = `${from}>${to}`;
    const prev = flows.get(key);
    flows.set(key, { from, to, count: (prev?.count ?? 0) + Number(row.count) });
  }
  const overrideFlows = [...flows.values()].sort(
    (a, b) => b.count - a.count || laneOrder(a.from) - laneOrder(b.from),
  );

  return {
    window: { since: meta.since.toISOString(), until: meta.until.toISOString() },
    source: meta.source,
    lanes,
    byDecidedBy,
    overrideFlows,
  };
}

export interface LaneQualityQuery {
  since: Date;
  until: Date;
  userId?: string;
  source?: AttentionSourceName;
}

/**
 * Run the two ledger queries inside one READ ONLY transaction and build the
 * report. All values are bound parameters — no string-built SQL.
 */
export async function queryLaneQuality(query: LaneQualityQuery): Promise<LaneQualityReport> {
  const source = query.source ?? "EMAIL";
  // A future --until must not count a row whose 24h window hasn't closed yet.
  const matureCutoff = new Date(Math.min(query.until.getTime(), Date.now()) - REPLY_WINDOW_MS);
  const scope = Prisma.sql`
    "source" = CAST(${source} AS "AttentionSource")
    AND "judgedAt" >= ${query.since}
    AND "judgedAt" < ${query.until}
    ${query.userId ? Prisma.sql`AND "userId" = ${query.userId}` : Prisma.empty}`;

  // Any signal recorded in Klorn (any engagement column or a lane judgement).
  const klornSignal = Prisma.sql`("outcome" IS NOT NULL OR "openedAt" IS NOT NULL
             OR "repliedAt" IS NOT NULL OR "archivedAt" IS NOT NULL
             OR "dismissedAt" IS NOT NULL OR "snoozedAt" IS NOT NULL
             OR "starredAt" IS NOT NULL OR "unsubscribedAt" IS NOT NULL)`;
  const klornReplied24h = Prisma.sql`COALESCE("repliedAt" <= "judgedAt" + INTERVAL '24 hours', false)`;

  const countsSql = Prisma.sql`
    SELECT "shownTier",
           COALESCE("decidedBy", 'unknown') AS "decidedBy",
           COUNT(*)::int AS "judged",
           COUNT(*) FILTER (WHERE "judgedAt" <= ${matureCutoff})::int AS "matured",
           COUNT(*) FILTER (WHERE ${klornSignal})::int AS "anyOutcome",
           COUNT(*) FILTER (WHERE "openedAt" IS NOT NULL)::int AS "opened",
           COUNT(*) FILTER (WHERE "judgedAt" <= ${matureCutoff}
             AND ${klornReplied24h})::int AS "replied24h",
           COUNT(*) FILTER (WHERE "archivedAt" IS NOT NULL)::int AS "archived",
           COUNT(*) FILTER (WHERE "dismissedAt" IS NOT NULL)::int AS "dismissed",
           COUNT(*) FILTER (WHERE "snoozedAt" IS NOT NULL)::int AS "snoozed",
           COUNT(*) FILTER (WHERE "starredAt" IS NOT NULL)::int AS "starred",
           COUNT(*) FILTER (WHERE "unsubscribedAt" IS NOT NULL)::int AS "unsubscribed",
           COUNT(*) FILTER (WHERE starts_with("outcome", 'OVERRIDE:'))::int AS "overridden",
           COUNT(*) FILTER (WHERE starts_with("outcome", 'CONFIRM:'))::int AS "confirmed",
           COUNT(*) FILTER (WHERE "judgedAt" <= ${matureCutoff}
             AND "providerRepliedAt" <= "judgedAt" + INTERVAL '24 hours'
             AND NOT ${klornReplied24h})::int AS "providerOnlyReplied24h",
           COUNT(*) FILTER (WHERE "providerArchivedAt" IS NOT NULL
             AND "archivedAt" IS NULL)::int AS "providerOnlyArchived",
           COUNT(*) FILTER (WHERE "judgedAt" <= ${matureCutoff}
             AND LEAST("repliedAt", "providerRepliedAt") <= "judgedAt" + INTERVAL '24 hours')::int
             AS "replied24hEither",
           COUNT(*) FILTER (WHERE "archivedAt" IS NOT NULL
             OR "providerArchivedAt" IS NOT NULL)::int AS "archivedEither",
           COUNT(*) FILTER (WHERE ${klornSignal}
             OR "providerRepliedAt" IS NOT NULL OR "providerArchivedAt" IS NOT NULL)::int
             AS "anyEither"
    FROM "DecisionLabel"
    WHERE ${scope}
    GROUP BY 1, 2`;

  const flowsSql = Prisma.sql`
    SELECT "shownTier" AS "fromTier",
           substr("outcome", length('OVERRIDE:') + 1) AS "toTier",
           COUNT(*)::int AS "count"
    FROM "DecisionLabel"
    WHERE ${scope} AND starts_with("outcome", 'OVERRIDE:')
    GROUP BY 1, 2`;

  const [, , rows, flowRows] = await prisma.$transaction([
    prisma.$executeRaw`SET TRANSACTION READ ONLY`,
    // A report must never hold prod connections for long: give up instead.
    prisma.$executeRaw`SET LOCAL statement_timeout = '60s'`,
    prisma.$queryRaw<LaneCountRow[]>(countsSql),
    prisma.$queryRaw<OverrideFlowRow[]>(flowsSql),
  ]);
  return buildLaneQualityReport(rows, flowRows, { since: query.since, until: query.until, source });
}

function pct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

const TABLE_HEADER = [
  "lane",
  "judged",
  "any",
  "opened",
  "replied<24h",
  "archived",
  "dismissed",
  "snoozed",
  "starred",
  "unsub",
  "override",
  "confirm",
];

function statsCells(s: LaneStats): string[] {
  return [
    String(s.judged),
    pct(s.shares.anyOutcome),
    pct(s.shares.opened),
    `${pct(s.shares.replied24h)} (n=${s.matured})`,
    pct(s.shares.archived),
    pct(s.shares.dismissed),
    pct(s.shares.snoozed),
    pct(s.shares.starred),
    pct(s.shares.unsubscribed),
    String(s.overridden),
    String(s.confirmed),
  ];
}

const PROVIDER_HEADER = [
  "lane",
  "judged",
  "replied<24h (only)",
  "archived (only)",
  "replied<24h (either)",
  "archived (either)",
  "any (either)",
];

function providerCells(s: LaneStats): string[] {
  return [
    s.lane,
    String(s.judged),
    `${pct(s.shares.providerOnlyReplied24h)} (n=${s.matured})`,
    pct(s.shares.providerOnlyArchived),
    `${pct(s.shares.replied24hEither)} (n=${s.matured})`,
    pct(s.shares.archivedEither),
    pct(s.shares.anyEither),
  ];
}

function renderTable(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((cell, i) => cell.padEnd(widths[i])).join("  ")).join("\n");
}

/** Plain-text rendering for the CLI. Pure. */
export function renderLaneQualityReport(report: LaneQualityReport): string {
  const laneTable = renderTable([
    TABLE_HEADER,
    ...report.lanes.map((s) => [s.lane, ...statsCells(s)]),
  ]);
  const providerTable = renderTable([PROVIDER_HEADER, ...report.lanes.map(providerCells)]);
  const decidedByTable = renderTable([
    ["lane / decidedBy", ...TABLE_HEADER.slice(1)],
    ...report.byDecidedBy.map((s) => [`${s.lane} / ${s.decidedBy}`, ...statsCells(s)]),
  ]);
  const flows =
    report.overrideFlows.length === 0
      ? "  (none)"
      : report.overrideFlows.map((f) => `  ${f.from} → ${f.to}: ${f.count}`).join("\n");
  return [
    `Lane quality — ${report.source}, judged ${report.window.since} … ${report.window.until}`,
    "",
    "In Klorn:",
    laneTable,
    "",
    "In the mail provider only (Gmail, seen by sync; Klorn recorded none), and either source:",
    providerTable,
    "",
    "By decidedBy (in Klorn):",
    decidedByTable,
    "",
    "Override flows (shown → moved to):",
    flows,
  ].join("\n");
}
