/**
 * Per-run summary for one benchmark cell (set × model × prompt × run).
 * Every rate is reported as hit/n so a reader sees the support, not a bare %.
 */
import type { Tier } from "../judge/tiers.js";
import { type CallRecord, callCostUsd } from "./call-tap.js";

export interface Ratio {
  hit: number;
  n: number;
}

export interface BenchRow {
  id: string;
  truth: Tier;
  predicted: Tier;
  /** "llm" | "keyword-fallback" | a front source | "v3" | "v3-unparsed" | "v3-provider-failed". */
  source: string;
  /** v3: the policy rule that placed the item. */
  rule?: string;
  evidenceTotal?: number;
  evidenceValid?: number;
  /** v3: kept asks whose due was nulled by due binding. */
  dueUnbound?: number;
  ambiguous?: boolean;
}

export interface RunSummary {
  n: number;
  overall: Ratio;
  /** Accuracy on the items that reached the LLM stage only (the front is identical for every model). */
  llmOverall: Ratio;
  pushRecall: Ratio;
  pushPrecision: Ratio;
  silentPrecision: Ratio;
  meetingRecall: Ratio;
  infoRecall: Ratio;
  queueRecall: Ratio;
  /** Safety invariant 1: truth-PUSH predicted SILENT. Must stay 0. */
  pushToSilent: number;
  /** Items that reached the LLM stage (not short-circuited by the front). */
  llmItems: number;
  /** Provider failures (v2 keyword fallback, v3 both attempts threw): a run with any is discarded. */
  degraded: number;
  evidence: Ratio;
  /** v3 items with ≥1 ask dropped for failed evidence. */
  droppedAskItems: number;
  /** v3 items with ≥1 due nulled by due binding (the quote states no deadline). */
  dueUnboundItems: number;
  ambiguous: number;
  unparsed: number;
  /** Doc §4 escalation triggers seen: dropped evidence, unbound due, ambiguous, unparsed. */
  wouldEscalate: number;
  calls: number;
  costUsd: number;
  costPer1kMailsUsd: number;
  p50Ms: number | null;
  p90Ms: number | null;
}

const LLM_SOURCES = new Set(["llm", "keyword-fallback", "v3", "v3-unparsed", "v3-provider-failed"]);

function ratio(
  rows: readonly BenchRow[],
  pick: (r: BenchRow) => boolean,
  hit: (r: BenchRow) => boolean,
): Ratio {
  const pool = rows.filter(pick);
  return { hit: pool.filter(hit).length, n: pool.length };
}

const recall = (rows: readonly BenchRow[], tier: Tier) =>
  ratio(
    rows,
    (r) => r.truth === tier,
    (r) => r.predicted === tier,
  );

const precision = (rows: readonly BenchRow[], tier: Tier) =>
  ratio(
    rows,
    (r) => r.predicted === tier,
    (r) => r.truth === tier,
  );

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * `mailCount` is every mail the run processed (default: rows.length). A
 * re-score that drops unlabelled rows keeps the run's calls, so pricing must
 * keep the original denominator.
 */
export function summarizeRun(
  rows: readonly BenchRow[],
  calls: readonly CallRecord[],
  mailCount: number = rows.length,
): RunSummary {
  const ok = calls.filter((c) => c.status >= 200 && c.status < 300);
  const costUsd = ok.reduce((sum, c) => sum + callCostUsd(c), 0);
  const droppedAskItems = rows.filter(
    (r) => (r.evidenceValid ?? 0) < (r.evidenceTotal ?? 0),
  ).length;
  const ambiguous = rows.filter((r) => r.ambiguous === true).length;
  const unparsed = rows.filter((r) => r.source === "v3-unparsed").length;
  const wouldEscalate = rows.filter(
    (r) =>
      r.source === "v3-unparsed" ||
      r.ambiguous === true ||
      (r.dueUnbound ?? 0) > 0 ||
      (r.evidenceValid ?? 0) < (r.evidenceTotal ?? 0),
  ).length;
  return {
    n: rows.length,
    overall: ratio(
      rows,
      () => true,
      (r) => r.truth === r.predicted,
    ),
    llmOverall: ratio(
      rows,
      (r) => LLM_SOURCES.has(r.source),
      (r) => r.truth === r.predicted,
    ),
    pushRecall: recall(rows, "PUSH"),
    pushPrecision: precision(rows, "PUSH"),
    silentPrecision: precision(rows, "SILENT"),
    meetingRecall: recall(rows, "MEETING"),
    infoRecall: recall(rows, "INFO"),
    queueRecall: recall(rows, "QUEUE"),
    pushToSilent: rows.filter((r) => r.truth === "PUSH" && r.predicted === "SILENT").length,
    llmItems: rows.filter((r) => LLM_SOURCES.has(r.source)).length,
    degraded: rows.filter(
      (r) => r.source === "keyword-fallback" || r.source === "v3-provider-failed",
    ).length,
    evidence: {
      hit: rows.reduce((s, r) => s + (r.evidenceValid ?? 0), 0),
      n: rows.reduce((s, r) => s + (r.evidenceTotal ?? 0), 0),
    },
    droppedAskItems,
    dueUnboundItems: rows.filter((r) => (r.dueUnbound ?? 0) > 0).length,
    ambiguous,
    unparsed,
    wouldEscalate,
    calls: ok.length,
    costUsd,
    costPer1kMailsUsd: mailCount > 0 ? (costUsd / mailCount) * 1000 : 0,
    p50Ms: percentile(
      ok.map((c) => c.ms),
      50,
    ),
    p90Ms: percentile(
      ok.map((c) => c.ms),
      90,
    ),
  };
}
