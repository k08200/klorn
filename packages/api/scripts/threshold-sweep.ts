/**
 * Threshold sweep — the data-driven answer to "is AUTO's senderTrust floor
 * the right lever?" (Phase 1 calibration seed).
 *
 * The hand-tuned tier thresholds (tier-policy.ts) and the founder's ground-truth
 * labels disagree on AUTO: low-trust informational mail (receipts, delivery,
 * summaries) is labelled AUTO but the senderTrust>=0.5 floor (added 2026-06-12
 * to stop bills/invoices auto-claiming) drops it to QUEUE. Rather than hand-patch
 * the safety rule again, this measures: extract features ONCE (so model
 * nondeterminism is removed from the comparison), then replay the deterministic
 * tier rule under different threshold configs and score each against the labels.
 *
 * The point is to SEE whether lowering/removing the AUTO senderTrust floor
 * raises AUTO recall WITHOUT regressing the safety floors (PUSH recall,
 * SILENT precision) or leaking low-trust QUEUE mail into AUTO.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... JUDGE_MODEL=google/gemini-2.5-flash \
 *   DATABASE_URL=postgresql://eval:eval@localhost/eval \
 *   npx tsx scripts/threshold-sweep.ts [--extract] [--concurrency=2] [--delay=500]
 *
 * Reads the committed eval set and a fixed temp cache (paths are not
 * configurable — see EVAL_SET_PATH / FEATURE_CACHE_PATH). Features are cached
 * after the first extraction; re-runs are free + instant (deterministic) unless
 * --extract forces a fresh LLM pass.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateTierFloors } from "../src/eval-floors.js";
import { judgeEmails, POC_TIERS, type PocJudgement, type PocTier } from "../src/poc-judge.js";
import { type ThresholdConfig, TIER_THRESHOLDS, tierFromFeatures } from "../src/tier-policy.js";

interface GroundTruthItem {
  id: string;
  from: string;
  subject: string;
  snippet: string | null;
  labels: string[];
  label: null | PocTier;
  note?: string;
}
interface GroundTruthFile {
  items: GroundTruthItem[];
}

interface CachedRow {
  id: string;
  from: string;
  subject: string;
  label: PocTier;
  note?: string;
  features: PocJudgement["features"];
  source: PocJudgement["source"];
  /** The tier judgeEmail actually returned — used to faithfully replay the
   *  sources that bypass tierFromFeatures (fast-path, sender-prior). */
  baselineTier: PocTier;
}

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

// Fixed paths. This dev-only eval tool always runs against the committed eval
// set and a single temp cache; they are NOT operator-configurable, so no
// untrusted value ever reaches a filesystem path (no js/path-injection surface).
const EVAL_SET_PATH = "eval/judge-eval-set.json";
const FEATURE_CACHE_PATH = "/tmp/klorn-eval-features.json";

async function loadOrExtract(
  inPath: string,
  cachePath: string,
  forceExtract: boolean,
): Promise<CachedRow[]> {
  if (!forceExtract && existsSync(cachePath)) {
    console.log(`Loading cached features ← ${cachePath} (use --extract to refresh)`);
    let cached: CachedRow[];
    try {
      cached = JSON.parse(readFileSync(cachePath, "utf8")) as CachedRow[];
    } catch (err) {
      throw new Error(
        `Cache at ${cachePath} is unreadable/corrupt (${err instanceof Error ? err.message : err}). ` +
          `Delete it or re-run with --extract to rebuild.`,
      );
    }
    // Older caches predate baselineTier — force a refresh so the sender-prior
    // replay stays faithful instead of silently falling back to tierFromFeatures.
    if (cached.length > 0 && cached[0].baselineTier === undefined) {
      console.log("Cache predates baselineTier — re-extracting once.");
    } else {
      return cached;
    }
  }

  const file = JSON.parse(readFileSync(resolve(inPath), "utf8")) as GroundTruthFile;
  const labelled = file.items.filter(
    (i): i is GroundTruthItem & { label: PocTier } =>
      i.label !== null && POC_TIERS.includes(i.label as PocTier),
  );
  const concurrency = Number(arg("concurrency", "2"));
  const delayMs = Number(arg("delay", "500"));
  console.log(`Extracting features for ${labelled.length} labelled emails (one paid LLM pass)...`);

  const judgements = await judgeEmails(
    labelled.map((i) => ({
      id: i.id,
      from: i.from,
      subject: i.subject,
      snippet: i.snippet ?? null,
      labels: i.labels,
    })),
    { concurrency, interCallDelayMs: delayMs },
  );

  const rows: CachedRow[] = labelled.map((item, i) => ({
    id: item.id,
    from: item.from,
    subject: item.subject,
    label: item.label,
    note: item.note,
    features: judgements[i].features,
    source: judgements[i].source,
    baselineTier: judgements[i].tier,
  }));
  writeFileSync(cachePath, JSON.stringify(rows, null, 2), "utf8");
  console.log(`Cached features → ${cachePath}`);
  return rows;
}

/**
 * Replay the judge's tier decision for one email under a candidate threshold
 * config, faithful to judgeEmail: the marketing fast-path is a hard SILENT
 * rule decided BEFORE tierFromFeatures, so it is threshold-invariant. Every
 * other source (llm / keyword-fallback) flows through the deterministic rule.
 */
function replayTier(row: CachedRow, thresholds: ThresholdConfig): PocTier {
  // fast-path (marketing) and sender-prior decide the tier BEFORE
  // tierFromFeatures in judgeEmail, so they're threshold-invariant — replay
  // their recorded outcome rather than re-deriving it from features.
  if (row.source === "fast-path" || row.source === "sender-prior") return row.baselineTier;
  return tierFromFeatures(row.features, thresholds).tier;
}

interface Scored {
  accuracy: number;
  right: number;
  total: number;
  pushRecall: number;
  silentPrecision: number;
  floorsPass: boolean;
  perTier: Record<PocTier, { right: number; total: number } | null>;
  movedIntoAuto: CachedRow[];
}

function score(rows: CachedRow[], thresholds: ThresholdConfig): Scored {
  const preds = rows.map((r) => ({ row: r, truth: r.label, predicted: replayTier(r, thresholds) }));
  const right = preds.filter((p) => p.truth === p.predicted).length;
  const floors = evaluateTierFloors(preds.map((p) => ({ truth: p.truth, predicted: p.predicted })));
  const pushCheck = floors.checks.find((c) => c.name.includes("PUSH"));
  const silentCheck = floors.checks.find((c) => c.name.includes("SILENT"));

  const perTier = {} as Record<PocTier, { right: number; total: number } | null>;
  for (const t of POC_TIERS) {
    const inTier = preds.filter((p) => p.truth === t);
    perTier[t] = inTier.length
      ? { right: inTier.filter((p) => p.predicted === t).length, total: inTier.length }
      : null;
  }

  // Items the rule now sends to AUTO that the label disagrees with — the
  // leak we most fear when loosening the AUTO floor (a bill auto-claimed).
  const movedIntoAuto = preds
    .filter((p) => p.predicted === "AUTO" && p.truth !== "AUTO")
    .map((p) => p.row);

  return {
    accuracy: right / preds.length,
    right,
    total: preds.length,
    pushRecall: pushCheck?.value ?? Number.NaN,
    silentPrecision: silentCheck?.value ?? Number.NaN,
    floorsPass: floors.pass,
    perTier,
    movedIntoAuto,
  };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function main() {
  const rows = await loadOrExtract(EVAL_SET_PATH, FEATURE_CACHE_PATH, hasFlag("extract"));

  const base: ThresholdConfig = TIER_THRESHOLDS;
  const withAuto = (senderTrust: number, confidence?: number): ThresholdConfig => ({
    ...base,
    auto: {
      ...base.auto,
      senderTrust,
      ...(confidence != null ? { confidence } : {}),
    },
  });

  const variants: Array<{ label: string; thresholds: ThresholdConfig }> = [
    { label: "baseline (senderTrust>=0.50)", thresholds: base },
    { label: "senderTrust>=0.40", thresholds: withAuto(0.4) },
    { label: "senderTrust>=0.30", thresholds: withAuto(0.3) },
    { label: "senderTrust>=0.20", thresholds: withAuto(0.2) },
    { label: "senderTrust>=0.00 (drop floor)", thresholds: withAuto(0.0) },
    { label: "drop floor + confidence>=0.80", thresholds: withAuto(0.0, 0.8) },
  ];

  console.log(`\nScoring ${rows.length} emails across ${variants.length} threshold configs.`);
  console.log("Safety floors: PUSH recall >=90%, SILENT precision >=90%, overall >=80%.\n");
  console.log(
    `${"config".padEnd(34)} ${"overall".padEnd(9)} ${"AUTO".padEnd(8)} ${"QUEUE".padEnd(8)} ${"PUSHrec".padEnd(9)} ${"SILENTp".padEnd(9)} gate`,
  );
  console.log("-".repeat(92));

  for (const v of variants) {
    const s = score(rows, v.thresholds);
    const auto = s.perTier.AUTO;
    const queue = s.perTier.QUEUE;
    const autoStr = auto ? `${auto.right}/${auto.total}` : "—";
    const queueStr = queue ? `${queue.right}/${queue.total}` : "—";
    console.log(
      `${v.label.padEnd(34)} ${pct(s.accuracy).padEnd(9)} ${autoStr.padEnd(8)} ${queueStr.padEnd(8)} ${pct(s.pushRecall).padEnd(9)} ${pct(s.silentPrecision).padEnd(9)} ${s.floorsPass ? "PASS" : "FAIL"}`,
    );
  }

  // Detail on the loosest safe variant: what (if anything) leaks into AUTO wrongly.
  console.log("\n── Leak check: items wrongly sent to AUTO when the floor is dropped ──");
  const dropped = score(rows, withAuto(0.0));
  if (dropped.movedIntoAuto.length === 0) {
    console.log("  none — dropping the senderTrust floor pulls NOTHING wrong into AUTO.");
  } else {
    for (const r of dropped.movedIntoAuto) {
      console.log(
        `  label=${r.label} → AUTO  | ${r.subject.slice(0, 56)}  (from ${r.from.slice(0, 36)})`,
      );
      console.log(
        `      conf=${r.features.confidence.toFixed(2)} trust=${r.features.senderTrust.toFixed(2)} rev=${r.features.reversibility.toFixed(2)} urg=${r.features.urgency.toFixed(2)}${r.note ? `  note: ${r.note}` : ""}`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
