/**
 * Selective prediction / risk-coverage — the pure calibration primitive.
 *
 * Given a set of past decisions, each with the model's confidence score and
 * whether the decision turned out correct, find the confidence threshold τ that
 * accepts as many decisions as possible ("coverage") while keeping the error
 * rate on the accepted set at or under a target α ("risk"). This is the
 * risk–coverage tradeoff of learning-to-reject (Geifman & El-Yaniv, "Selective
 * Classification for Deep Neural Networks", NeurIPS 2017; roots in Chow 1970).
 *
 * Klorn uses it to calibrate the AUTO gate from the DecisionLabel ledger: AUTO
 * should fire only where the judge's confidence is high enough that the observed
 * AUTO error (the user later overrode it) stays under a chosen risk bound. The
 * returned threshold is the highest-recall AUTO cutoff that still honours α — no
 * higher (over-cautious, low recall), no lower (over-eager, unsafe).
 *
 * Pure: no DB, no clock, no randomness — unit-testable on synthetic rows. The
 * caller (ontology proposals, Phase 4 AUTO gate) supplies real rows.
 */

/** One past decision: the judge's confidence and whether it was correct. */
export interface ScoredOutcome {
  /** Judge confidence at decision time, 0.0–1.0. */
  confidence: number;
  /** True if the decision was right (e.g. AUTO not overridden by the user). */
  correct: boolean;
}

export interface CoverageResult {
  /** Accept decisions with confidence >= this threshold. */
  threshold: number;
  /** Number of rows accepted at this threshold. */
  covered: number;
  /** Total rows considered. */
  total: number;
  /** covered / total. */
  coverage: number;
  /** Error rate on the accepted set — guaranteed <= alpha. */
  errorRate: number;
}

export interface RiskCoverageOpts {
  /** Max tolerable error rate on the accepted set (e.g. 0.05 = 5%). */
  alpha: number;
  /** Require at least this many accepted rows, else return null. Default 1. */
  minCovered?: number;
}

/**
 * Return the max-coverage threshold whose accepted-set error rate is <= alpha,
 * or null when no threshold accepts >= minCovered rows within the bound.
 *
 * Error rate is not strictly monotonic in τ on small samples, so every distinct
 * confidence value is evaluated as a candidate and the widest-coverage
 * satisfying one is chosen (ties broken toward the higher, safer threshold).
 */
export function riskCoverageThreshold(
  rows: readonly ScoredOutcome[],
  opts: RiskCoverageOpts,
): CoverageResult | null {
  const total = rows.length;
  if (total === 0) return null;

  const { alpha } = opts;
  const minCovered = Math.max(1, opts.minCovered ?? 1);
  const candidates = [...new Set(rows.map((r) => r.confidence))].sort((a, b) => a - b);

  let best: CoverageResult | null = null;
  for (const threshold of candidates) {
    const covered = rows.filter((r) => r.confidence >= threshold);
    if (covered.length < minCovered) continue;
    const errors = covered.reduce((n, r) => n + (r.correct ? 0 : 1), 0);
    const errorRate = errors / covered.length;
    if (errorRate > alpha) continue;

    const result: CoverageResult = {
      threshold,
      covered: covered.length,
      total,
      coverage: covered.length / total,
      errorRate,
    };
    if (
      best === null ||
      result.covered > best.covered ||
      (result.covered === best.covered && result.threshold > best.threshold)
    ) {
      best = result;
    }
  }
  return best;
}
