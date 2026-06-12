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
  detail: string;
}

export interface FloorReport {
  checks: FloorCheck[];
  pass: boolean;
}

export const OVERALL_ACCURACY_FLOOR = 0.8;
export const PUSH_RECALL_FLOOR = 0.9;
export const SILENT_PRECISION_FLOOR = 0.9;

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

  const checks: FloorCheck[] = [
    {
      name: "overall accuracy",
      value: overall,
      floor: OVERALL_ACCURACY_FLOOR,
      pass: overall >= OVERALL_ACCURACY_FLOOR,
      detail: `${correct}/${total}`,
    },
    {
      name: "PUSH recall",
      value: pushRecall,
      floor: PUSH_RECALL_FLOOR,
      pass: pushRecall >= PUSH_RECALL_FLOOR,
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
      detail:
        silentPredicted.length === 0
          ? "nothing predicted SILENT — vacuous"
          : `${silentTrue}/${silentPredicted.length} predicted-SILENT (burying real mail is the second-worst)`,
    },
  ];

  return { checks, pass: checks.every((c) => c.pass) };
}
