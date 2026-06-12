/**
 * Daily classification-quality snapshot — the override rate, online.
 *
 * scripts/calibration.ts computes these KPIs but only when a human runs it.
 * This module persists the same window math as one CalibrationSnapshot row
 * per user per UTC day (written by the automation scheduler), so
 * /api/admin/calibration can trend:
 *
 *   - manualOverrides:    tier moves stamped with MANUAL_OVERRIDE_PREFIX —
 *                         the strongest "the firewall was wrong" signal
 *   - feedbackOverrides:  DISMISSED/IGNORED FeedbackEvents (same proxy the
 *                         CLI report uses)
 *   - judgeSourceCounts:  which judge path produced each EMAIL tier
 *                         (fast-path / sender-prior / llm / keyword-fallback)
 *                         — a rising keyword-fallback share is the silent
 *                         quality cliff of a rate-limited/down LLM provider
 *   - perTier + drift:    confidence distribution and window-over-window
 *                         tier-distribution shift, as in the CLI
 *
 * The payload math is pure (buildSnapshotPayload) so it unit-tests without
 * a DB; the runner isolates per-user failures.
 */

import {
  type AttentionRow,
  computeDriftSignal,
  computeOverrideRate,
  computePerTier,
  type DriftSignal,
  isTier,
  type OverrideStats,
  TIERS,
  type Tier,
  type TierStats,
} from "./calibration.js";
// Type-only: the implementation is dynamically imported in the Sunday
// branch so the daily snapshot path never loads the LLM provider stack.
import type { CorrectionEvalPayload } from "./correction-eval.js";
import { prisma } from "./db.js";
import { captureError } from "./sentry.js";
import { isManualOverrideReason } from "./tiers.js";

const WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export const JUDGE_SOURCES = [
  "fast-path",
  "sender-prior",
  "llm",
  "keyword-fallback",
  "unknown",
] as const;
export type JudgeSource = (typeof JUDGE_SOURCES)[number];
export type JudgeSourceCounts = Record<JudgeSource, number>;

interface OverallOverrides {
  count: number;
  total: number;
  rate: number;
}

export interface CalibrationSnapshotPayload {
  windowDays: number;
  windowEnd: string;
  /** All rows in the window, including legacy rows without a tier. */
  totalItems: number;
  perTier: Record<Tier, TierStats | null>;
  feedbackOverrideRate: Record<Tier, OverrideStats>;
  feedbackOverrides: OverallOverrides;
  manualOverrides: OverallOverrides;
  judgeSourceCounts: JudgeSourceCounts;
  driftSignal: DriftSignal;
  /**
   * Weekly counterfactual accuracy on real overrides (correction-eval.ts).
   * Merged in on Sundays; preserved by the daily upsert in between.
   */
  correctionEval?: CorrectionEvalPayload;
}

/** Snapshot row — AttentionRow plus the fields the new KPIs need. */
export interface SnapshotSourceRow extends AttentionRow {
  tierReason: string | null;
  evidence: unknown;
}

/**
 * Which judge path produced this row's tier, read back from the
 * "Judged by" fact that attention-mirror stamps into evidence.
 */
function judgeSourceOf(evidence: unknown): JudgeSource {
  const facts = (evidence as { facts?: Array<{ label?: unknown; value?: unknown }> } | null)?.facts;
  if (!Array.isArray(facts)) return "unknown";
  const fact = facts.find((f) => f?.label === "Judged by");
  const value = typeof fact?.value === "string" ? fact.value : "";
  return (JUDGE_SOURCES as readonly string[]).includes(value) ? (value as JudgeSource) : "unknown";
}

function rate(count: number, total: number): number {
  return total === 0 ? 0 : Number((count / total).toFixed(4));
}

export function buildSnapshotPayload(args: {
  thisRows: SnapshotSourceRow[];
  previousRows: AttentionRow[];
  feedbackOverrideIds: Set<string>;
  windowDays: number;
  now: Date;
}): CalibrationSnapshotPayload {
  const { thisRows, previousRows, feedbackOverrideIds, windowDays, now } = args;

  const tierRows = thisRows.filter((r) => isTier(r.tier));
  const manualCount = tierRows.filter((r) => isManualOverrideReason(r.tierReason)).length;

  const feedbackOverrideRate = computeOverrideRate(thisRows, feedbackOverrideIds);
  let feedbackCount = 0;
  for (const tier of TIERS) feedbackCount += feedbackOverrideRate[tier].overridden;

  const judgeSourceCounts: JudgeSourceCounts = {
    "fast-path": 0,
    "sender-prior": 0,
    llm: 0,
    "keyword-fallback": 0,
    unknown: 0,
  };
  for (const row of thisRows) {
    if (row.source !== "EMAIL") continue;
    judgeSourceCounts[judgeSourceOf(row.evidence)] += 1;
  }

  return {
    windowDays,
    windowEnd: now.toISOString(),
    totalItems: thisRows.length,
    perTier: computePerTier(thisRows),
    feedbackOverrideRate,
    feedbackOverrides: {
      count: feedbackCount,
      total: tierRows.length,
      rate: rate(feedbackCount, tierRows.length),
    },
    manualOverrides: {
      count: manualCount,
      total: tierRows.length,
      rate: rate(manualCount, tierRows.length),
    },
    judgeSourceCounts,
    driftSignal: computeDriftSignal(thisRows, previousRows),
  };
}

async function fetchRows(userId: string, since: Date, until: Date): Promise<SnapshotSourceRow[]> {
  // schema.tier is String? (not enum) — unknown-cast so Prisma's generated
  // types don't narrow it away (same pattern as scripts/calibration.ts).
  return await (
    prisma.attentionItem as unknown as {
      findMany: (args: unknown) => Promise<SnapshotSourceRow[]>;
    }
  ).findMany({
    where: { userId, createdAt: { gte: since, lt: until } },
    select: {
      id: true,
      source: true,
      sourceId: true,
      tier: true,
      tierReason: true,
      confidence: true,
      createdAt: true,
      evidence: true,
    },
  });
}

async function fetchFeedbackOverrideIds(
  userId: string,
  since: Date,
  until: Date,
): Promise<Set<string>> {
  const events = await prisma.feedbackEvent.findMany({
    where: {
      userId,
      source: "ATTENTION_ITEM",
      signal: { in: ["DISMISSED", "IGNORED"] },
      createdAt: { gte: since, lt: until },
    },
    select: { sourceId: true },
  });
  return new Set(events.map((e) => e.sourceId));
}

/** Compute and upsert one user's snapshot for the UTC day containing `now`. */
export async function snapshotUserCalibration(
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  const windowStart = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const previousStart = new Date(now.getTime() - 2 * WINDOW_DAYS * DAY_MS);

  const [thisRows, previousRows, feedbackOverrideIds] = await Promise.all([
    fetchRows(userId, windowStart, now),
    fetchRows(userId, previousStart, windowStart),
    fetchFeedbackOverrideIds(userId, windowStart, now),
  ]);

  const payload = buildSnapshotPayload({
    thisRows,
    previousRows,
    feedbackOverrideIds,
    windowDays: WINDOW_DAYS,
    now,
  });

  const dayKey = now.toISOString().slice(0, 10);
  // A same-day re-run must not wipe a correction eval merged earlier today
  // — carry it over from the existing row before overwriting the payload.
  const existing = (await (
    prisma.calibrationSnapshot as unknown as {
      findUnique: (args: unknown) => Promise<{ payload?: unknown } | null>;
    }
  ).findUnique({
    where: { userId_dayKey: { userId, dayKey } },
    select: { payload: true },
  })) as { payload?: { correctionEval?: CorrectionEvalPayload } } | null;
  if (existing?.payload?.correctionEval) {
    payload.correctionEval = existing.payload.correctionEval;
  }

  await (
    prisma.calibrationSnapshot as unknown as {
      upsert: (args: unknown) => Promise<unknown>;
    }
  ).upsert({
    where: { userId_dayKey: { userId, dayKey } },
    create: { userId, dayKey, payload },
    update: { payload },
  });
}

/**
 * Sunday-only: run the counterfactual correction eval and merge the result
 * into today's snapshot. Idempotent — a snapshot that already carries a
 * correctionEval (same-day restart) skips the LLM batch entirely.
 */
async function maybeMergeWeeklyCorrectionEval(userId: string, now: Date): Promise<void> {
  const dayKey = now.toISOString().slice(0, 10);
  const snapshot = prisma.calibrationSnapshot as unknown as {
    findUnique: (args: unknown) => Promise<{ payload?: unknown } | null>;
    update: (args: unknown) => Promise<unknown>;
  };

  const row = (await snapshot.findUnique({
    where: { userId_dayKey: { userId, dayKey } },
    select: { payload: true },
  })) as { payload?: { correctionEval?: CorrectionEvalPayload } } | null;
  if (!row || row.payload?.correctionEval) return;

  const { runCorrectionEval } = await import("./correction-eval.js");
  const result = await runCorrectionEval(userId, now);
  if (!result) return;

  await snapshot.update({
    where: { userId_dayKey: { userId, dayKey } },
    data: { payload: { ...row.payload, correctionEval: result } },
  });
}

/**
 * Snapshot every user with attention items in the current window. Called
 * once per UTC day by the automation scheduler. Per-user failures are
 * captured and skipped — one broken user must not stop the rest.
 */
export async function runDailyCalibrationSnapshots(now: Date = new Date()): Promise<void> {
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const groups = (await (
    prisma.attentionItem as unknown as {
      groupBy: (args: unknown) => Promise<Array<{ userId: string }>>;
    }
  ).groupBy({
    by: ["userId"],
    where: { createdAt: { gte: since } },
  })) as Array<{ userId: string }>;

  const isSundayUtc = now.getUTCDay() === 0;
  for (const { userId } of groups) {
    try {
      await snapshotUserCalibration(userId, now);
      if (isSundayUtc) await maybeMergeWeeklyCorrectionEval(userId, now);
    } catch (err) {
      captureError(err, { tags: { scope: "calibration-snapshot" }, extra: { userId } });
    }
  }
  if (groups.length > 0) {
    console.log(`[CALIBRATION] Daily snapshots written for ${groups.length} user(s)`);
  }
}
