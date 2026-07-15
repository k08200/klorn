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

import { TIERS, type Tier } from "./judge/tiers.js";

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

/**
 * Configurable per-tier gating (#650). Each check has a stable id; an
 * override sets its floor AND makes it gating. The parser enforces the
 * ratchet doctrine: a default-gating floor may only tighten (≥ default) —
 * report-only checks may be promoted at any floor, since they had no
 * committed floor to lower.
 */
export const FLOOR_CHECK_IDS = [
  "overall",
  "push-recall",
  "silent-precision",
  "queue-recall",
  "auto-recall",
] as const;
export type FloorCheckId = (typeof FLOOR_CHECK_IDS)[number];
export type FloorOverrides = Partial<Record<FloorCheckId, number>>;

const DEFAULT_FLOORS: Record<FloorCheckId, { floor: number; gating: boolean }> = {
  overall: { floor: OVERALL_ACCURACY_FLOOR, gating: true },
  "push-recall": { floor: PUSH_RECALL_FLOOR, gating: true },
  "silent-precision": { floor: SILENT_PRECISION_FLOOR, gating: true },
  "queue-recall": { floor: QUEUE_RECALL_TARGET, gating: false },
  "auto-recall": { floor: AUTO_RECALL_TARGET, gating: false },
};

/** Parse "auto-recall=0.5,push-recall=0.95" into overrides. Throws on typos. */
export function parseGateFloorOverrides(raw: string): FloorOverrides {
  const overrides: FloorOverrides = {};
  for (const token of raw.split(",")) {
    const m = token.trim().match(/^([\w-]+)=([\d.]+)$/);
    if (!m || !(FLOOR_CHECK_IDS as readonly string[]).includes(m[1])) {
      throw new Error(
        `invalid gate-floor "${token.trim()}" — expected <check>=<0..1> with check one of ${FLOOR_CHECK_IDS.join(", ")}`,
      );
    }
    const id = m[1] as FloorCheckId;
    const value = Number(m[2]);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`gate-floor ${id} must be within [0, 1], got "${m[2]}"`);
    }
    const dflt = DEFAULT_FLOORS[id];
    if (dflt.gating && value < dflt.floor) {
      throw new Error(
        `gate-floor ${id}=${value} is below the committed default ${dflt.floor} — floors are ratchets, they only tighten`,
      );
    }
    overrides[id] = value;
  }
  return overrides;
}

function resolveFloor(
  id: FloorCheckId,
  overrides: FloorOverrides,
): { floor: number; gating: boolean } {
  const override = overrides[id];
  return override === undefined ? DEFAULT_FLOORS[id] : { floor: override, gating: true };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

export function evaluateTierFloors(pairs: TierPair[], overrides: FloorOverrides = {}): FloorReport {
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

  const overallFloor = resolveFloor("overall", overrides);
  const pushFloor = resolveFloor("push-recall", overrides);
  const silentFloor = resolveFloor("silent-precision", overrides);
  const queueFloor = resolveFloor("queue-recall", overrides);
  const autoFloor = resolveFloor("auto-recall", overrides);

  const checks: FloorCheck[] = [
    {
      name: "overall accuracy",
      value: overall,
      floor: overallFloor.floor,
      pass: overall >= overallFloor.floor,
      gating: overallFloor.gating,
      detail: `${correct}/${total}`,
    },
    {
      name: "PUSH recall",
      value: pushRecall,
      floor: pushFloor.floor,
      pass: pushRecall >= pushFloor.floor,
      gating: pushFloor.gating,
      detail:
        pushTruth.length === 0
          ? "no PUSH items — vacuous"
          : `${pushHit}/${pushTruth.length} (a missed urgent mail is the worst failure)`,
    },
    {
      name: "SILENT precision",
      value: silentPrecision,
      floor: silentFloor.floor,
      pass: silentPrecision >= silentFloor.floor,
      gating: silentFloor.gating,
      detail:
        silentPredicted.length === 0
          ? "nothing predicted SILENT — vacuous"
          : `${silentTrue}/${silentPredicted.length} predicted-SILENT (burying real mail is the second-worst)`,
    },
    {
      name: "QUEUE recall",
      value: queueRecall,
      floor: queueFloor.floor,
      pass: queueRecall >= queueFloor.floor,
      gating: queueFloor.gating,
      detail:
        queueTruth.length === 0
          ? "no QUEUE items — vacuous"
          : `${queueHit}/${queueTruth.length}${queueFloor.gating ? "" : " (report-only)"}`,
    },
    {
      name: "AUTO recall",
      value: autoRecall,
      floor: autoFloor.floor,
      pass: autoRecall >= autoFloor.floor,
      gating: autoFloor.gating,
      detail:
        autoTruth.length === 0
          ? "no AUTO items — vacuous"
          : `${autoHit}/${autoTruth.length}${autoFloor.gating ? "" : " (report-only — low recall is a threshold-tuning target)"}`,
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
