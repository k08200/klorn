/**
 * Ontology write-side v0 — threshold-adjustment proposals.
 *
 * The classifier keeps reading the git `const`s in tier-policy.ts; this module
 * never mutates them. It turns the aggregate override metrics (decision-metrics)
 * into *proposed* threshold changes — the write side of the shared ontology.
 * Proposals are advisory: a human applies an approved one via a code PR (git is
 * the audit trail + revert). See docs/superpowers/specs/2026-06-23-ontology-
 * write-side-design.md.
 *
 * `proposeThresholdAdjustments` is pure so it can be unit-tested without a DB.
 */

import type { DecisionMetrics } from "./decision-metrics.js";
import { riskCoverageThreshold, type ScoredOutcome } from "./selective-threshold.js";
import { CLAMP, type ThresholdConfig, TIER_THRESHOLDS } from "./tier-policy.js";

/** PUSH recall below this (the CI eval-gate floor) means the firewall is missing
 * interrupts — propose lowering the PUSH confidence gate. */
export const PUSH_RECALL_TARGET = 0.9;
/** SILENT over-suppression above this means the firewall is hiding wanted mail —
 * propose tightening the SILENT gate. */
export const SILENT_OVERSUPPRESS_TARGET = 0.1;
/** Don't propose on thin data: require at least this many decided rows. */
export const MIN_SAMPLE = 20;
/** Never propose more than this much movement in one run (small, reversible). */
export const MAX_STEP = 0.05;
/**
 * Max tolerable AUTO error rate. AUTO auto-handles mail, so a wrong AUTO (the
 * user later had to override it) is costly — hold it tight. The risk-coverage
 * calibrator finds the confidence cutoff that keeps observed AUTO error under
 * this bound while covering as much as possible.
 */
export const AUTO_ERROR_TARGET = 0.05;

const DEFAULT_WINDOW_DAYS = 30;

/** The two override-derived signals a proposal can act on, with their samples. */
export interface ProposalSignals {
  recallUpperBound: number | null;
  pushRecallSample: number;
  overSuppressionRate: number | null;
  silentSample: number;
}

export interface ProposalEvidence {
  metric: string;
  value: number;
  target: number;
  sampleSize: number;
  windowDays: number;
}

export interface ProposalCandidate {
  /** Dotted path into the policy, e.g. "tier.push.confidence". */
  knob: string;
  currentValue: number;
  proposedValue: number;
  direction: "RAISE" | "LOWER";
  evidence: ProposalEvidence;
}

export interface ProposalOpts {
  /**
   * The thresholds to propose against. Defaults to the git base const, but the
   * recompute path passes the live *effective* thresholds (getEffectiveThresholds)
   * so that once an override is approved, currentValue reflects what the
   * classifier actually runs on — not the stale base value.
   */
  thresholds?: ThresholdConfig;
  windowDays?: number;
  minSample?: number;
  maxStep?: number;
  pushRecallTarget?: number;
  silentOverSuppressTarget?: number;
  /** Max tolerable AUTO error rate for the risk-coverage calibrator. */
  autoErrorTarget?: number;
}

/** Adapt the full decision-metrics summary to the signals a proposal needs. */
export function signalsFromMetrics(m: DecisionMetrics): ProposalSignals {
  return {
    recallUpperBound: m.push.recallUpperBound,
    pushRecallSample: m.push.keptPresumed + m.push.escalatedFromLower,
    overSuppressionRate: m.silent.overSuppressionRate,
    silentSample: m.silent.shown,
  };
}

/**
 * Map override signals to bounded, advisory threshold-change proposals. Pure.
 * Returns an empty array when the data is thin, missing, or already on target.
 */
export function proposeThresholdAdjustments(
  signals: ProposalSignals,
  opts: ProposalOpts = {},
): ProposalCandidate[] {
  const thresholds = opts.thresholds ?? TIER_THRESHOLDS;
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const minSample = opts.minSample ?? MIN_SAMPLE;
  const maxStep = opts.maxStep ?? MAX_STEP;
  const pushTarget = opts.pushRecallTarget ?? PUSH_RECALL_TARGET;
  const silentTarget = opts.silentOverSuppressTarget ?? SILENT_OVERSUPPRESS_TARGET;

  const out: ProposalCandidate[] = [];

  // PUSH recall below target → lower the confidence gate, but never down into the
  // QUEUE region (must stay above lowConfidenceFloor).
  if (
    signals.recallUpperBound !== null &&
    signals.recallUpperBound < pushTarget &&
    signals.pushRecallSample >= minSample
  ) {
    const current = thresholds.push.confidence;
    const proposed = Math.max(CLAMP(current - maxStep), thresholds.lowConfidenceFloor);
    if (proposed !== current) {
      out.push({
        knob: "tier.push.confidence",
        currentValue: current,
        proposedValue: proposed,
        direction: "LOWER",
        evidence: {
          metric: "push.recallUpperBound",
          value: signals.recallUpperBound,
          target: pushTarget,
          sampleSize: signals.pushRecallSample,
          windowDays,
        },
      });
    }
  }

  // SILENT over-suppression above target → tighten the gate by raising the
  // reversibility requirement so fewer items qualify for SILENT.
  if (
    signals.overSuppressionRate !== null &&
    signals.overSuppressionRate > silentTarget &&
    signals.silentSample >= minSample
  ) {
    const current = thresholds.silent.reversibility;
    const proposed = CLAMP(current + maxStep);
    if (proposed !== current) {
      out.push({
        knob: "tier.silent.reversibility",
        currentValue: current,
        proposedValue: proposed,
        direction: "RAISE",
        evidence: {
          metric: "silent.overSuppressionRate",
          value: signals.overSuppressionRate,
          target: silentTarget,
          sampleSize: signals.silentSample,
          windowDays,
        },
      });
    }
  }

  return out;
}

/**
 * Calibrate the AUTO confidence gate from observed AUTO decisions using the
 * risk-coverage primitive (selective-threshold.ts). Unlike the aggregate-metric
 * proposals above, this reads per-row (confidence, correct) outcomes and asks:
 * what confidence cutoff keeps AUTO error under `autoErrorTarget` while covering
 * the most mail? It then proposes moving tier.auto.confidence toward that cutoff
 * — LOWER when the current gate is over-cautious (safe headroom → more AUTO
 * recall), RAISE when observed AUTO error demands a tighter gate. Movement is
 * bounded by maxStep and clamped to [0,1]; returns null on thin data, no safe
 * threshold, or when already calibrated.
 *
 * Pure — the caller supplies the rows (from the DecisionLabel ledger).
 */
export function proposeAutoConfidenceAdjustment(
  rows: readonly ScoredOutcome[],
  opts: ProposalOpts = {},
): ProposalCandidate | null {
  const thresholds = opts.thresholds ?? TIER_THRESHOLDS;
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const minSample = opts.minSample ?? MIN_SAMPLE;
  const maxStep = opts.maxStep ?? MAX_STEP;
  const alpha = opts.autoErrorTarget ?? AUTO_ERROR_TARGET;

  if (rows.length < minSample) return null;

  const rc = riskCoverageThreshold(rows, { alpha, minCovered: minSample });
  if (!rc) return null; // no confidence cutoff keeps AUTO error under alpha here

  const current = thresholds.auto.confidence;
  // Step toward the calibrated cutoff, but never more than maxStep in one run.
  const delta = Math.max(-maxStep, Math.min(maxStep, rc.threshold - current));
  const proposed = CLAMP(current + delta);
  if (proposed === current) return null;

  return {
    knob: "tier.auto.confidence",
    currentValue: current,
    proposedValue: proposed,
    direction: proposed < current ? "LOWER" : "RAISE",
    evidence: {
      metric: "auto.confidence@riskCoverage",
      value: rc.threshold,
      target: alpha,
      sampleSize: rows.length,
      windowDays,
    },
  };
}
