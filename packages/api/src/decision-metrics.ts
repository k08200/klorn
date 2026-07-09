/**
 * Decision-metrics reader — the read path over the DecisionLabel ledger.
 *
 * The ledger (decision-label.ts) writes {what we showed, what the user later
 * revealed they wanted}. This module turns those rows into per-user PUSH recall
 * and SILENT over-suppression — the two numbers the precision gate is measured
 * on — WITHOUT inventing certainty the data doesn't have.
 *
 * Honest-by-construction. A null outcome is never read as "the firewall was
 * right": silence ≠ agreement (a SILENT row the user never opened proves
 * nothing). So each headline number is a bound, not a point estimate:
 *
 *   - push.recallUpperBound — UPPER bound. Numerator counts shown-PUSH rows the
 *     user didn't pull down (presumed-correct, unconfirmed); denominator adds
 *     only the misses we can SEE (lower-tier rows the user escalated to PUSH).
 *     Silent misses (wanted PUSH, shown SILENT, never dug out) are invisible,
 *     so true recall is ≤ this.
 *   - silent.overSuppressionRate — LOWER bound. Counts only SILENT items the
 *     user actually rescued; mistaken-SILENT they never noticed is invisible,
 *     so true over-suppression is ≥ this.
 *
 * This is the "측정 not 주입" contract in code: surface what real overrides
 * prove, label the rest unconfirmed, never paper a clean accuracy % over silence.
 */

import { prisma } from "./db.js";
import type { AttentionSourceName } from "./decision-label.js";
import { TIERS, type Tier } from "./tiers.js";

/** One ledger row, narrowed to the fields the metrics need. */
export interface DecisionRow {
  /** Tier the firewall showed ("SILENT" | "QUEUE" | "PUSH" | "AUTO"). */
  shownTier: string;
  /** "OVERRIDE:<Tier>" | terminal status (e.g. "DISMISSED") | null (open). */
  outcome: string | null;
  /** "fast-path" | "sender-prior" | "llm" | "keyword-fallback" | null. */
  decidedBy?: string | null;
  /** "DIRECT" | "PROPAGATED" | null — which engagement grounding fed the judge. */
  engagementKind?: string | null;
}

export interface DecidedByMetric {
  decidedBy: string;
  total: number;
  corrections: number;
  /** corrections / total — high here means this path's calls get overruled. */
  correctionRate: number | null;
}

export interface DecisionMetrics {
  total: number;
  /** Rows the user acted on (outcome stamped). */
  acted: number;
  /** Rows still open (outcome null) — explicitly NOT counted as agreement. */
  open: number;
  /** Overrides that moved the tier (same-tier no-ops excluded). */
  corrections: number;
  /** corrections / total. */
  overrideRate: number | null;
  push: {
    shown: number;
    /** Shown PUSH, not pulled down — presumed correct, UNCONFIRMED. */
    keptPresumed: number;
    /** Shown PUSH, overridden to a lower tier — confirmed false PUSH. */
    overriddenDown: number;
    /** Shown below PUSH, escalated to PUSH — confirmed miss. */
    escalatedFromLower: number;
    /** UPPER bound: keptPresumed / (keptPresumed + escalatedFromLower). */
    recallUpperBound: number | null;
  };
  silent: {
    shown: number;
    /** Shown SILENT, overridden up — confirmed over-suppression. */
    rescued: number;
    /** LOWER bound: rescued / shown. */
    overSuppressionRate: number | null;
  };
  byDecidedBy: DecidedByMetric[];
}

const OVERRIDE_PREFIX = "OVERRIDE:";
const CONFIRM_PREFIX = "CONFIRM:";
const TIER_SET: ReadonlySet<string> = new Set(TIERS);

/** The tier a user moved an item to, or null if the outcome isn't a tier move. */
function overrideTarget(outcome: string | null): Tier | null {
  if (!outcome || !outcome.startsWith(OVERRIDE_PREFIX)) return null;
  const target = outcome.slice(OVERRIDE_PREFIX.length);
  return TIER_SET.has(target) ? (target as Tier) : null;
}

/**
 * The tier a user EXPLICITLY affirmed, or null if the outcome isn't a confirm.
 * A confirm is the only positive ground truth in the ledger — the counterpart
 * to an override — so a confirmed row can be counted correct without inferring
 * anything from silence.
 */
function confirmedTier(outcome: string | null): Tier | null {
  if (!outcome || !outcome.startsWith(CONFIRM_PREFIX)) return null;
  const target = outcome.slice(CONFIRM_PREFIX.length);
  return TIER_SET.has(target) ? (target as Tier) : null;
}

const ratio = (num: number, denom: number): number | null => (denom === 0 ? null : num / denom);

interface Tally {
  acted: number;
  corrections: number;
  pushShown: number;
  pushKept: number;
  pushDown: number;
  escalated: number;
  silentShown: number;
  silentRescued: number;
}
type DecidedTally = Map<string, { total: number; corrections: number }>;

/** Accumulate one row into the running tallies. Mutates loop-local state only. */
function tallyRow(t: Tally, byDecided: DecidedTally, row: DecisionRow): void {
  const target = overrideTarget(row.outcome);
  const isCorrection = target !== null && target !== row.shownTier;
  if (row.outcome !== null) t.acted += 1;
  if (isCorrection) t.corrections += 1;

  if (row.shownTier === "PUSH") {
    t.pushShown += 1;
    // Pulled to a lower tier = confirmed false PUSH; null OR a same-tier
    // affirmation = kept (the user didn't reject the interrupt).
    if (target !== null && target !== "PUSH") t.pushDown += 1;
    else t.pushKept += 1;
  } else if (target === "PUSH") {
    t.escalated += 1; // confirmed miss: a lower tier the user escalated to PUSH
  }

  if (row.shownTier === "SILENT") {
    t.silentShown += 1;
    if (isCorrection) t.silentRescued += 1;
  }

  const key = row.decidedBy ?? "unknown";
  const agg = byDecided.get(key) ?? { total: 0, corrections: 0 };
  byDecided.set(key, {
    total: agg.total + 1,
    corrections: agg.corrections + (isCorrection ? 1 : 0),
  });
}

/** Pure: fold ledger rows into bounded recall / over-suppression metrics. */
export function summarizeDecisions(rows: readonly DecisionRow[]): DecisionMetrics {
  const t: Tally = {
    acted: 0,
    corrections: 0,
    pushShown: 0,
    pushKept: 0,
    pushDown: 0,
    escalated: 0,
    silentShown: 0,
    silentRescued: 0,
  };
  const byDecided: DecidedTally = new Map();
  for (const row of rows) tallyRow(t, byDecided, row);

  const byDecidedBy = [...byDecided.entries()]
    .map(([decidedBy, v]) => ({
      decidedBy,
      total: v.total,
      corrections: v.corrections,
      correctionRate: ratio(v.corrections, v.total),
    }))
    .sort((a, b) => b.total - a.total);

  return {
    total: rows.length,
    acted: t.acted,
    open: rows.length - t.acted,
    corrections: t.corrections,
    overrideRate: ratio(t.corrections, rows.length),
    push: {
      shown: t.pushShown,
      keptPresumed: t.pushKept,
      overriddenDown: t.pushDown,
      escalatedFromLower: t.escalated,
      recallUpperBound: ratio(t.pushKept, t.pushKept + t.escalated),
    },
    silent: {
      shown: t.silentShown,
      rescued: t.silentRescued,
      overSuppressionRate: ratio(t.silentRescued, t.silentShown),
    },
    byDecidedBy,
  };
}

/** Compact per-user headline, for the multi-user admin view. */
export interface UserDecisionSummary {
  userId: string;
  total: number;
  recallUpperBound: number | null;
  overSuppressionRate: number | null;
  overrideRate: number | null;
}

/**
 * Per-tier accuracy from CONFIRMED overrides only. A user override ("OVERRIDE:X"
 * to a different tier) is the ONLY ground truth in the ledger, so this reports
 * the confirmed-error picture across all four tiers — never inferring
 * correctness from a null/terminal outcome (honest-by-design, like the bounds
 * above). This is the accuracy instrument that SCALES: it grows automatically
 * with real user overrides, per-user, and needs no synthetic labels.
 */
export interface TierConfusion {
  tier: Tier;
  /** Rows shown this tier. */
  shown: number;
  /** Shown this tier, then overridden to a DIFFERENT tier — confirmed wrong. */
  overriddenAway: number;
  /** Shown this tier and EXPLICITLY confirmed at it — confirmed right (positive ground truth). */
  confirmedCorrect: number;
  /** Confirmed-error LOWER bound: overriddenAway / shown (unconfirmed rows never counted correct). */
  correctionRate: number | null;
  /**
   * Confirmed-error POINT ESTIMATE over rows the user actually labelled:
   * overriddenAway / (overriddenAway + confirmedCorrect). null when the tier has
   * zero explicit labels — an honest "unknown", distinct from a 0 over `shown`
   * (which folds in silence). This is the number worth trending after onboarding
   * seeds confirmations; correctionRate stays the conservative floor.
   */
  confirmedErrorRate: number | null;
  /** Where the user moved shown-this-tier items (confirmed overrides only). */
  movedTo: Partial<Record<Tier, number>>;
}

export interface ConfusionReport {
  total: number;
  /** Tier-moving overrides across all tiers — the negative ground-truth cells. */
  confirmedOverrides: number;
  /** Explicit same-tier confirmations across all tiers — the positive ground-truth cells. */
  confirmedCorrect: number;
  perTier: TierConfusion[];
  /** shownTier → revealedTier counts, confirmed overrides only. */
  matrix: Partial<Record<Tier, Partial<Record<Tier, number>>>>;
}

/**
 * Rollout instrumentation for CONTACT_ENGAGEMENT_IN_JUDGE: how often the learned-
 * engagement grounding actually fed a decision, split by kind, and whether those
 * decisions get corrected. Honest like the rest of this module — correctionRate
 * counts only confirmed tier-moving overrides; unconfirmed rows aren't "right".
 *
 * Reading it after the flip: a LOW correctionRate on grounded rows (vs the
 * overall overrideRate) means the signal is aligned with the user; a HIGH one
 * means it's steering wrong. `total` staying 0 after the flip means the signal
 * never fires (no engagement history yet) — nothing to trust either way.
 */
export interface EngagementGroundingMetric {
  /** Decisions where any engagement grounding fired (engagementKind non-null). */
  total: number;
  /** Measured direct engagement (replies to this sender). */
  direct: number;
  /** Inferred from an engaged org peer. */
  propagated: number;
  /** shownTier distribution of grounded decisions. */
  byTier: Partial<Record<Tier, number>>;
  /** Grounded rows the user acted on (outcome stamped). */
  acted: number;
  /** Grounded rows overridden to a different tier — confirmed steered-wrong. */
  corrections: number;
  /** corrections / acted — LOWER is better (grounding matched the user). */
  correctionRate: number | null;
}

export interface DecisionMetricsReport {
  /** How many days back the ledger was read (the recall/over-suppression window). */
  windowDays: number;
  overall: DecisionMetrics;
  /** Full per-tier confusion from confirmed overrides (all 4 tiers). */
  confusion: ConfusionReport;
  /** CONTACT_ENGAGEMENT_IN_JUDGE rollout footprint (0 until the flag fires). */
  engagementGrounding: EngagementGroundingMetric;
  perUser: UserDecisionSummary[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 90;
const MAX_WINDOW_DAYS = 365;
// Hard cap on rows pulled into memory per metrics read. The trailing window
// bounds the DATE range but NOT the row count — at high fleet override volume a
// 90-day window can be 100k+ labels, which this path (HTTP-reachable AND run
// unattended daily, then duplicated per-user by summarizePerUser) would
// otherwise materialize whole. Cap to the most recent N; a metrics window is a
// diagnostic, not an exact audit, so "recent N" is the right bound.
const FLEET_METRICS_ROW_CAP = 50_000;

type LedgerRow = DecisionRow & { userId: string };

function summarizePerUser(rows: readonly LedgerRow[]): UserDecisionSummary[] {
  const byUser = new Map<string, LedgerRow[]>();
  for (const row of rows) {
    const list = byUser.get(row.userId) ?? [];
    list.push(row);
    byUser.set(row.userId, list);
  }
  return [...byUser.entries()]
    .map(([userId, userRows]) => {
      const m = summarizeDecisions(userRows);
      return {
        userId,
        total: m.total,
        recallUpperBound: m.push.recallUpperBound,
        overSuppressionRate: m.silent.overSuppressionRate,
        overrideRate: m.overrideRate,
      };
    })
    .sort((a, b) => b.total - a.total);
}

/**
 * Pure: fold ledger rows into the per-tier confusion from confirmed overrides.
 * Uses only the ground-truth signal (a tier-moving override); null/terminal
 * outcomes are unconfirmed and never counted as correct or incorrect.
 */
export function summarizeConfusion(rows: readonly DecisionRow[]): ConfusionReport {
  const shown = new Map<Tier, number>();
  const movedTo = new Map<Tier, Map<Tier, number>>();
  const confirmed = new Map<Tier, number>();
  let confirmedOverrides = 0;
  let confirmedCorrectTotal = 0;

  for (const row of rows) {
    if (!TIER_SET.has(row.shownTier)) continue; // skip legacy/garbage tiers
    const from = row.shownTier as Tier;
    shown.set(from, (shown.get(from) ?? 0) + 1);
    const target = overrideTarget(row.outcome);
    if (target !== null && target !== from) {
      confirmedOverrides += 1;
      const inner = movedTo.get(from) ?? new Map<Tier, number>();
      inner.set(target, (inner.get(target) ?? 0) + 1);
      movedTo.set(from, inner);
      continue; // an override is never also a confirm
    }
    // Positive ground truth: an explicit confirm of the tier we showed. A
    // confirm naming a DIFFERENT tier is contradictory (a confirm doesn't move
    // the tier) and is ignored — counted neither right nor wrong.
    if (confirmedTier(row.outcome) === from) {
      confirmed.set(from, (confirmed.get(from) ?? 0) + 1);
      confirmedCorrectTotal += 1;
    }
  }

  const perTier: TierConfusion[] = TIERS.map((tier) => {
    const s = shown.get(tier) ?? 0;
    const moved = movedTo.get(tier);
    const overriddenAway = moved ? [...moved.values()].reduce((a, b) => a + b, 0) : 0;
    const confirmedCorrect = confirmed.get(tier) ?? 0;
    const labelled = overriddenAway + confirmedCorrect;
    const movedToObj: Partial<Record<Tier, number>> = {};
    if (moved) for (const [t, n] of moved) movedToObj[t] = n;
    return {
      tier,
      shown: s,
      overriddenAway,
      confirmedCorrect,
      correctionRate: ratio(overriddenAway, s),
      confirmedErrorRate: ratio(overriddenAway, labelled),
      movedTo: movedToObj,
    };
  });

  const matrix: Partial<Record<Tier, Partial<Record<Tier, number>>>> = {};
  for (const [from, inner] of movedTo) {
    const obj: Partial<Record<Tier, number>> = {};
    for (const [to, n] of inner) obj[to] = n;
    matrix[from] = obj;
  }

  return {
    total: rows.length,
    confirmedOverrides,
    confirmedCorrect: confirmedCorrectTotal,
    perTier,
    matrix,
  };
}

/**
 * Pure: fold ledger rows into the engagement-grounding rollout footprint. Counts
 * only rows where the grounding actually fired (engagementKind non-null), so it
 * stays all-zero until CONTACT_ENGAGEMENT_IN_JUDGE is flipped and a sender with
 * real engagement history is judged. correctionRate uses confirmed tier-moving
 * overrides only (same honesty contract as summarizeDecisions).
 */
export function summarizeEngagementGrounding(
  rows: readonly DecisionRow[],
): EngagementGroundingMetric {
  const byTier: Partial<Record<Tier, number>> = {};
  let total = 0;
  let direct = 0;
  let propagated = 0;
  let acted = 0;
  let corrections = 0;

  for (const row of rows) {
    const kind = row.engagementKind;
    if (kind !== "DIRECT" && kind !== "PROPAGATED") continue;
    total += 1;
    if (kind === "DIRECT") direct += 1;
    else propagated += 1;
    if (TIER_SET.has(row.shownTier)) {
      const tier = row.shownTier as Tier;
      byTier[tier] = (byTier[tier] ?? 0) + 1;
    }
    if (row.outcome !== null) acted += 1;
    const target = overrideTarget(row.outcome);
    if (target !== null && target !== row.shownTier) corrections += 1;
  }

  return {
    total,
    direct,
    propagated,
    byTier,
    acted,
    corrections,
    correctionRate: ratio(corrections, acted),
  };
}

/**
 * Compact headline for a daily drift snapshot — the bounded numbers worth
 * trending over time, without the per-path breakdown.
 */
export interface DecisionDailySummary {
  total: number;
  acted: number;
  recallUpperBound: number | null;
  overSuppressionRate: number | null;
  overrideRate: number | null;
  pushShown: number;
  silentShown: number;
}

export function dailySummaryOf(m: DecisionMetrics): DecisionDailySummary {
  return {
    total: m.total,
    acted: m.acted,
    recallUpperBound: m.push.recallUpperBound,
    overSuppressionRate: m.silent.overSuppressionRate,
    overrideRate: m.overrideRate,
    pushShown: m.push.shown,
    silentShown: m.silent.shown,
  };
}

/**
 * Windowed ledger summary keyed by judgement time — for the daily drift
 * tripwire (calibration-snapshot). Read-only. A decision judged in the window
 * carries whatever outcome it has now, even if the user's override landed later.
 */
export async function getDecisionDailySummary(
  userId: string,
  since: Date,
  until: Date,
  source: AttentionSourceName = "EMAIL",
): Promise<DecisionDailySummary> {
  const rows = (await prisma.decisionLabel.findMany({
    where: { userId, source, judgedAt: { gte: since, lt: until } },
    select: { shownTier: true, outcome: true, decidedBy: true },
  })) as DecisionRow[];
  return dailySummaryOf(summarizeDecisions(rows));
}

/**
 * Read one source's ledger (default EMAIL) and compute metrics, optionally for
 * one user. Read-only; safe to call from an admin route. Bounded BOTH by a
 * trailing window (default 90d, capped 365d) AND a hard row cap
 * (FLEET_METRICS_ROW_CAP): the window alone bounds the date range but not the
 * row count, so the cap keeps memory bounded (most-recent-N) as the ledger grows.
 */
export async function getDecisionMetrics(
  opts: { userId?: string; sinceDays?: number; source?: AttentionSourceName } = {},
): Promise<DecisionMetricsReport> {
  const windowDays = Math.min(
    MAX_WINDOW_DAYS,
    Math.max(1, Math.floor(opts.sinceDays ?? DEFAULT_WINDOW_DAYS)),
  );
  const since = new Date(Date.now() - windowDays * DAY_MS);
  const rows = (await prisma.decisionLabel.findMany({
    where: {
      source: opts.source ?? "EMAIL",
      judgedAt: { gte: since },
      ...(opts.userId ? { userId: opts.userId } : {}),
    },
    select: {
      userId: true,
      shownTier: true,
      outcome: true,
      decidedBy: true,
      engagementKind: true,
    },
    // Most-recent-first + a hard row cap so memory is bounded by the cap, not by
    // ledger volume. Served by @@index([source, judgedAt]) (userId-less) and
    // @@index([userId, shownTier, judgedAt]) (per-user).
    orderBy: { judgedAt: "desc" },
    take: FLEET_METRICS_ROW_CAP,
  })) as LedgerRow[];

  if (rows.length === FLEET_METRICS_ROW_CAP) {
    console.warn(
      `[decision-metrics] hit the ${FLEET_METRICS_ROW_CAP}-row cap in a ${windowDays}d window` +
        `${opts.userId ? ` (user ${opts.userId})` : " (fleet-wide)"} — metrics reflect only the most recent ${FLEET_METRICS_ROW_CAP} labels`,
    );
  }

  return {
    windowDays,
    overall: summarizeDecisions(rows),
    confusion: summarizeConfusion(rows),
    engagementGrounding: summarizeEngagementGrounding(rows),
    perUser: summarizePerUser(rows),
  };
}
