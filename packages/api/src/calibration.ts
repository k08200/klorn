/**
 * Pure stats helpers for the calibration CLI (scripts/calibration.ts).
 *
 * Kept side-effect-free and DB-free so the math can be unit-tested without
 * a Prisma fixture. The script wraps these with the actual DB reads.
 *
 * See doctrine note at the top of scripts/calibration.ts for the
 * motivation (Day 14+7 retention POC infra, dev.to thread response).
 */

// Imported from the canonical vocabulary so calibration math and the
// classifier can never count a different number of tiers. See tiers.ts.
import { TIERS, type Tier } from "./tiers.js";

export { TIERS, type Tier };

export interface AttentionRow {
  id: string;
  source: string;
  sourceId: string;
  tier: string | null;
  confidence: number;
  createdAt: Date;
}

export interface TierStats {
  count: number;
  meanConfidence: number;
  p10: number;
  p50: number;
  p90: number;
}

export interface OverrideStats {
  overridden: number;
  total: number;
  rate: number;
}

export interface AccuracyStats {
  tp: number;
  fn: number;
  fp: number;
  accuracy: number;
}

export interface DriftSignal {
  thisWindow: Record<Tier, number>;
  previousWindow: Record<Tier, number>;
  deltaMax: number;
  deltaMaxTier: Tier;
}

export interface GroundTruthAccuracy {
  matchedItems: number;
  perTier: Record<Tier, AccuracyStats | null>;
  overallAccuracy: number;
}

export interface GroundTruthItem {
  id: string;
  gmailId: string;
  label: Tier | null;
}

export interface GroundTruthFile {
  metadata: { userEmail: string; count: number };
  items: GroundTruthItem[];
}

export interface CalibrationReport {
  windowDays: number;
  user: string;
  windowStart: string;
  windowEnd: string;
  totalItems: number;
  perTier: Record<Tier, TierStats | null>;
  overrideRate: Record<Tier, OverrideStats>;
  groundTruthAccuracy?: GroundTruthAccuracy;
  driftSignal: DriftSignal;
}

export function isTier(value: string | null | undefined): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function emptyTierMap<T>(value: () => T): Record<Tier, T> {
  return {
    SILENT: value(),
    QUEUE: value(),
    PUSH: value(),
    AUTO: value(),
  };
}

export function tierStats(confidences: number[]): TierStats | null {
  if (confidences.length === 0) return null;
  const sorted = [...confidences].sort((a, b) => a - b);
  const sum = confidences.reduce((acc, x) => acc + x, 0);
  return {
    count: confidences.length,
    meanConfidence: Number((sum / confidences.length).toFixed(4)),
    p10: Number(quantile(sorted, 0.1).toFixed(4)),
    p50: Number(quantile(sorted, 0.5).toFixed(4)),
    p90: Number(quantile(sorted, 0.9).toFixed(4)),
  };
}

export function computePerTier(rows: AttentionRow[]): Record<Tier, TierStats | null> {
  const buckets = emptyTierMap<number[]>(() => []);
  for (const row of rows) {
    if (isTier(row.tier)) buckets[row.tier].push(row.confidence);
  }
  return {
    SILENT: tierStats(buckets.SILENT),
    QUEUE: tierStats(buckets.QUEUE),
    PUSH: tierStats(buckets.PUSH),
    AUTO: tierStats(buckets.AUTO),
  };
}

export function computeOverrideRate(
  rows: AttentionRow[],
  overrideIds: Set<string>,
): Record<Tier, OverrideStats> {
  const result = emptyTierMap<OverrideStats>(() => ({ overridden: 0, total: 0, rate: 0 }));
  for (const row of rows) {
    if (!isTier(row.tier)) continue;
    result[row.tier].total += 1;
    if (overrideIds.has(row.id)) result[row.tier].overridden += 1;
  }
  for (const tier of TIERS) {
    const r = result[tier];
    r.rate = r.total === 0 ? 0 : Number((r.overridden / r.total).toFixed(4));
  }
  return result;
}

export function computeGroundTruthAccuracy(
  rows: AttentionRow[],
  truth: Map<string, Tier>,
): GroundTruthAccuracy {
  let matched = 0;
  let correct = 0;
  // tp: predicted=tier && actual=tier
  // fn: actual=tier && predicted≠tier
  // fp: predicted=tier && actual≠tier
  const stats = emptyTierMap<{ tp: number; fn: number; fp: number; supportInTier: number }>(() => ({
    tp: 0,
    fn: 0,
    fp: 0,
    supportInTier: 0,
  }));
  for (const row of rows) {
    if (row.source !== "EMAIL") continue;
    const actual = truth.get(row.sourceId);
    if (!actual) continue;
    if (!isTier(row.tier)) continue;
    matched += 1;
    const predicted = row.tier;
    if (predicted === actual) {
      correct += 1;
      stats[actual].tp += 1;
      stats[actual].supportInTier += 1;
    } else {
      stats[actual].fn += 1;
      stats[actual].supportInTier += 1;
      stats[predicted].fp += 1;
    }
  }
  const perTier: Record<Tier, AccuracyStats | null> = emptyTierMap(() => null);
  for (const tier of TIERS) {
    const s = stats[tier];
    // Surface a tier if it has any signal — actual occurrences (supportInTier)
    // OR misclassifications into it (fp). A tier with only fp is the model
    // hallucinating that label, which is exactly what we want to see.
    if (s.supportInTier === 0 && s.fp === 0) {
      perTier[tier] = null;
      continue;
    }
    perTier[tier] = {
      tp: s.tp,
      fn: s.fn,
      fp: s.fp,
      // Accuracy here is recall on that tier (tp / (tp+fn)). 0 when
      // supportInTier=0 — there's nothing real to recall.
      accuracy: s.supportInTier === 0 ? 0 : Number((s.tp / s.supportInTier).toFixed(4)),
    };
  }
  return {
    matchedItems: matched,
    perTier,
    overallAccuracy: matched === 0 ? 0 : Number((correct / matched).toFixed(4)),
  };
}

export function computeDistribution(rows: AttentionRow[]): Record<Tier, number> {
  const counts = emptyTierMap(() => 0);
  let total = 0;
  for (const row of rows) {
    if (isTier(row.tier)) {
      counts[row.tier] += 1;
      total += 1;
    }
  }
  const dist = emptyTierMap(() => 0);
  if (total === 0) return dist;
  for (const tier of TIERS) {
    dist[tier] = Number((counts[tier] / total).toFixed(4));
  }
  return dist;
}

export function computeDriftSignal(
  thisRows: AttentionRow[],
  previousRows: AttentionRow[],
): DriftSignal {
  const thisDist = computeDistribution(thisRows);
  const prevDist = computeDistribution(previousRows);
  let deltaMax = 0;
  let deltaMaxTier: Tier = "SILENT";
  for (const tier of TIERS) {
    const d = Math.abs(thisDist[tier] - prevDist[tier]);
    if (d > deltaMax) {
      deltaMax = d;
      deltaMaxTier = tier;
    }
  }
  return {
    thisWindow: thisDist,
    previousWindow: prevDist,
    deltaMax: Number(deltaMax.toFixed(4)),
    deltaMaxTier,
  };
}
