/**
 * Per-tier floor evaluation for the judge eval gates.
 *
 * A single overall bar hides asymmetric failure costs: half the PUSH set
 * can be missed while the run still clears 80%. These floors encode the
 * product's failure ranking — a missed PUSH (urgent mail the user never
 * saw) is the worst failure, a real mail buried in SILENT is second.
 *
 * Floors are calibrated to the committed synthetic set's support
 * (PUSH n=13 → recall 0.90 allows exactly one miss; SILENT precision 0.90
 * allows one false-silent at ~12 predictions). Tighten toward 0.95 when
 * the set grows enough for the rate to have finer granularity. Like the
 * keyword-pipeline floor, these are ratchets: raise when the judge
 * improves, never lower to make a PR pass.
 */

import { TIERS, type Tier } from "./tiers.js";

export interface TierPair {
  truth: Tier;
  predicted: Tier;
}

export interface FloorCheck {
  name: string;
  value: number;
  floor: number;
  pass: boolean;
  /**
   * Whether this check gates the run. Report-only checks (false) surface a
   * metric every run for visibility but never fail the gate — used for tiers
   * without a calibrated floor yet, so a hard floor can't be injected blindly.
   */
  gating: boolean;
  detail: string;
}

export interface FloorReport {
  checks: FloorCheck[];
  pass: boolean;
}

export const OVERALL_ACCURACY_FLOOR = 0.8;
export const PUSH_RECALL_FLOOR = 0.9;
export const SILENT_PRECISION_FLOOR = 0.9;

// Report-only targets (NOT gates). QUEUE (n=21) and AUTO (n=4) have no gating
// floor yet: AUTO's low recall is a known threshold-tuning target and its tiny
// support makes the rate coarse (each miss = 0.25), so a hard floor would be
// either vacuous or flappy. These document the aspiration and render the
// measured recall every run; ratchet one into a real gate once a stable
// measured baseline exists (the "raise when the judge improves" doctrine).
export const QUEUE_RECALL_TARGET = 0.8;
export const AUTO_RECALL_TARGET = 0.5;

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

export function evaluateTierFloors(pairs: TierPair[]): FloorReport {
  const valid = pairs.filter((p) => TIERS.includes(p.truth) && TIERS.includes(p.predicted));
  const total = valid.length;
  const correct = valid.filter((p) => p.truth === p.predicted).length;
  // An empty run must never green-light the gate — overall is 0, not vacuous.
  const overall = total === 0 ? 0 : correct / total;

  const pushTruth = valid.filter((p) => p.truth === "PUSH");
  const pushHit = pushTruth.filter((p) => p.predicted === "PUSH").length;
  const pushRecall = ratio(pushHit, pushTruth.length);

  const silentPredicted = valid.filter((p) => p.predicted === "SILENT");
  const silentTrue = silentPredicted.filter((p) => p.truth === "SILENT").length;
  const silentPrecision = ratio(silentTrue, silentPredicted.length);

  // Report-only recall for the two tiers no gate watches today. AUTO (n=4) and
  // QUEUE (n=21) can collapse without moving the 80% overall bar — losing all
  // four AUTO items costs only 8% — so they were previously invisible.
  const queueTruth = valid.filter((p) => p.truth === "QUEUE");
  const queueHit = queueTruth.filter((p) => p.predicted === "QUEUE").length;
  const queueRecall = ratio(queueHit, queueTruth.length);
  const autoTruth = valid.filter((p) => p.truth === "AUTO");
  const autoHit = autoTruth.filter((p) => p.predicted === "AUTO").length;
  const autoRecall = ratio(autoHit, autoTruth.length);

  const checks: FloorCheck[] = [
    {
      name: "overall accuracy",
      value: overall,
      floor: OVERALL_ACCURACY_FLOOR,
      pass: overall >= OVERALL_ACCURACY_FLOOR,
      gating: true,
      detail: `${correct}/${total}`,
    },
    {
      name: "PUSH recall",
      value: pushRecall,
      floor: PUSH_RECALL_FLOOR,
      pass: pushRecall >= PUSH_RECALL_FLOOR,
      gating: true,
      detail:
        pushTruth.length === 0
          ? "no PUSH items — vacuous"
          : `${pushHit}/${pushTruth.length} (a missed urgent mail is the worst failure)`,
    },
    {
      name: "SILENT precision",
      value: silentPrecision,
      floor: SILENT_PRECISION_FLOOR,
      pass: silentPrecision >= SILENT_PRECISION_FLOOR,
      gating: true,
      detail:
        silentPredicted.length === 0
          ? "nothing predicted SILENT — vacuous"
          : `${silentTrue}/${silentPredicted.length} predicted-SILENT (burying real mail is the second-worst)`,
    },
    {
      name: "QUEUE recall",
      value: queueRecall,
      floor: QUEUE_RECALL_TARGET,
      pass: queueRecall >= QUEUE_RECALL_TARGET,
      gating: false,
      detail:
        queueTruth.length === 0
          ? "no QUEUE items — vacuous"
          : `${queueHit}/${queueTruth.length} (report-only)`,
    },
    {
      name: "AUTO recall",
      value: autoRecall,
      floor: AUTO_RECALL_TARGET,
      pass: autoRecall >= AUTO_RECALL_TARGET,
      gating: false,
      detail:
        autoTruth.length === 0
          ? "no AUTO items — vacuous"
          : `${autoHit}/${autoTruth.length} (report-only — low recall is a threshold-tuning target)`,
    },
  ];

  // Only gating checks decide the verdict; report-only checks are visibility,
  // not a gate. An empty run still fails via overall accuracy (overall = 0).
  return { checks, pass: checks.filter((c) => c.gating).every((c) => c.pass) };
}

/**
 * Full per-tier precision/recall/support snapshot for the eval report (NOT a
 * gate — the floors above are the gate). Diagnostic instrument for the
 * body-eval and confusion-matrix readouts.
 *
 * "Measure not inject": a tier with zero support has an UNKNOWN metric, so
 * precision/recall are `null` (never a fabricated 0 or 1). The reader is
 * handed the raw support counts alongside so a null is legible as "vacuous",
 * not "broken".
 */
export interface TierMetric {
  tier: Tier;
  /** correctForTier / predictedSupport; null when nothing was predicted this tier. */
  precision: number | null;
  /** correctForTier / truthSupport; null when nothing is truly this tier. */
  recall: number | null;
  /** count of items whose ground-truth tier is this tier. */
  truthSupport: number;
  /** count of items the judge predicted as this tier. */
  predictedSupport: number;
}

/** Divide, or null when the denominator has no support (unknown, not 0). */
function rateOrNull(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** One TierMetric per tier, in TIERS order. Pure — no I/O, no mutation. */
export function computePerTierMetrics(
  results: Array<{ truth: Tier; predicted: Tier }>,
): TierMetric[] {
  const valid = results.filter((r) => TIERS.includes(r.truth) && TIERS.includes(r.predicted));
  return TIERS.map((tier) => {
    const truthSupport = valid.filter((r) => r.truth === tier).length;
    const predictedSupport = valid.filter((r) => r.predicted === tier).length;
    const correct = valid.filter((r) => r.truth === tier && r.predicted === tier).length;
    return {
      tier,
      precision: rateOrNull(correct, predictedSupport),
      recall: rateOrNull(correct, truthSupport),
      truthSupport,
      predictedSupport,
    };
  });
}

export interface TierMetricDelta {
  tier: Tier;
  /** after.precision − before.precision; null if either side is null. */
  precisionDelta: number | null;
  /** after.recall − before.recall; null if either side is null. */
  recallDelta: number | null;
}

/** Subtract two metrics; null propagates so a vacuous side never fakes a delta. */
function delta(before: number | null, after: number | null): number | null {
  return before === null || after === null ? null : after - before;
}

/**
 * Per-tier change between two metric snapshots (e.g. body-off vs body-on).
 * A null on either side yields a null delta — an unknown minus anything is
 * still unknown, so we never report a confident change we didn't measure.
 * Aligns both inputs by tier in TIERS order.
 */
export function diffTierMetrics(before: TierMetric[], after: TierMetric[]): TierMetricDelta[] {
  return TIERS.map((tier) => {
    const b = before.find((m) => m.tier === tier);
    const a = after.find((m) => m.tier === tier);
    return {
      tier,
      precisionDelta: delta(b?.precision ?? null, a?.precision ?? null),
      recallDelta: delta(b?.recall ?? null, a?.recall ?? null),
    };
  });
}
