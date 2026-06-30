/**
 * POC accuracy measurement (Day 6–7 of POC.md sprint).
 *
 * Reads a ground-truth JSON written by scripts/poc-label-emails.ts, runs
 * judgeEmail against each labelled item, and prints:
 *   - overall accuracy (Day 7 HARD GATE bar: ≥80%)
 *   - per-tier confusion matrix
 *   - top disagreements (founder label vs model tier) for Day 6 prompt tuning
 *
 * Usage:
 *   DATABASE_URL=... OPENROUTER_API_KEY=... npx tsx scripts/poc-accuracy.ts \
 *     --in=./poc-ground-truth.json
 *
 * The script does not persist anything. It only reads the JSON and calls
 * the LLM via poc-judge.ts.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateTierFloors } from "../src/eval-floors.js";
import { judgeEmails, POC_TIERS, type PocJudgement, type PocTier } from "../src/poc-judge.js";

interface GroundTruthItem {
  id: string;
  gmailId: string;
  from: string;
  subject: string;
  snippet: string | null;
  /**
   * Full plaintext body. Only fed to the judge when JUDGE_INCLUDE_BODY is on
   * (see poc-judge.ts). Absent in the locked 50-item gate set — there it is
   * inert. Present in the body-eval set so an off-vs-on run measures the
   * body's effect on cases whose true tier lives below the snippet.
   */
  body?: string | null;
  labels: string[];
  receivedAt: string;
  label: null | PocTier;
  note?: string;
}

interface GroundTruthFile {
  metadata: { userEmail: string; extractedAt: string; count: number };
  items: GroundTruthItem[];
}

interface CliArgs {
  in: string;
  out?: string;
  concurrency: number;
  delayMs: number;
}

function parseArgs(argv: string[]): CliArgs {
  const map = new Map<string, string>();
  for (const raw of argv) {
    const m = raw.match(/^--([\w-]+)=(.+)$/);
    if (m) map.set(m[1], m[2]);
  }
  const input = map.get("in");
  if (!input) throw new Error("--in=<path> is required");
  const concurrency = Number(map.get("concurrency") ?? "4");
  if (!Number.isFinite(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error("--concurrency must be between 1 and 16");
  }
  // Free-tier providers (Gemini AI Studio: 15 RPM) need a per-call sleep
  // so the 50-email run doesn't burst past the limit. 5000ms with
  // concurrency=1 keeps us under 12 RPM with margin.
  const delayMs = Number(map.get("delay") ?? "0");
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 60000) {
    throw new Error("--delay must be 0–60000 (ms)");
  }
  return { in: input, out: map.get("out"), concurrency, delayMs };
}

function pad(value: string | number, width: number): string {
  const s = String(value);
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function printConfusionMatrix(rows: Array<{ truth: PocTier; predicted: PocTier }>): void {
  const matrix: Record<PocTier, Record<PocTier, number>> = {
    SILENT: { SILENT: 0, QUEUE: 0, PUSH: 0, AUTO: 0 },
    QUEUE: { SILENT: 0, QUEUE: 0, PUSH: 0, AUTO: 0 },
    PUSH: { SILENT: 0, QUEUE: 0, PUSH: 0, AUTO: 0 },
    AUTO: { SILENT: 0, QUEUE: 0, PUSH: 0, AUTO: 0 },
  };
  for (const r of rows) matrix[r.truth][r.predicted]++;

  console.log("\nConfusion matrix (rows = ground truth, cols = predicted):");
  console.log(`         ${POC_TIERS.map((t) => pad(t, 8)).join("")}`);
  for (const truth of POC_TIERS) {
    const row = POC_TIERS.map((p) => pad(matrix[truth][p], 8)).join("");
    console.log(`  ${pad(truth, 7)} ${row}`);
  }
}

function printPerTierAccuracy(rows: Array<{ truth: PocTier; predicted: PocTier }>): void {
  console.log("\nPer-tier recall (% of ground-truth items in tier that were predicted correctly):");
  for (const tier of POC_TIERS) {
    const inTier = rows.filter((r) => r.truth === tier);
    if (inTier.length === 0) {
      console.log(`  ${pad(tier, 7)}     no ground-truth items`);
      continue;
    }
    const right = inTier.filter((r) => r.predicted === tier).length;
    const pct = ((right / inTier.length) * 100).toFixed(1);
    console.log(`  ${pad(tier, 7)} ${pad(`${right}/${inTier.length}`, 6)} ${pct}%`);
  }
}

interface Disagreement {
  id: string;
  from: string;
  subject: string;
  truth: PocTier;
  predicted: PocTier;
  reason: string;
  features: PocJudgement["features"];
  source: PocJudgement["source"];
  note?: string;
}

function printDisagreements(disagreements: Disagreement[], limit = 20): void {
  if (disagreements.length === 0) {
    console.log("\nNo disagreements — every labelled item matched.");
    return;
  }
  console.log(`\nDisagreements (showing up to ${limit} of ${disagreements.length}):`);
  for (const d of disagreements.slice(0, limit)) {
    console.log(
      `  ${pad(d.truth, 7)} → ${pad(d.predicted, 7)} [${d.source}] ${d.subject.slice(0, 60)}`,
    );
    console.log(`           from: ${d.from.slice(0, 80)}`);
    console.log(
      `           features: conf=${d.features.confidence.toFixed(2)} trust=${d.features.senderTrust.toFixed(2)} rev=${d.features.reversibility.toFixed(2)} urg=${d.features.urgency.toFixed(2)}`,
    );
    console.log(`           model reason: ${d.reason}`);
    if (d.note) console.log(`           your note: ${d.note}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const inPath = resolve(args.in);
  const raw = readFileSync(inPath, "utf8");
  const file = JSON.parse(raw) as GroundTruthFile;

  const labelled = file.items.filter(
    (i): i is GroundTruthItem & { label: PocTier } =>
      i.label !== null && POC_TIERS.includes(i.label as PocTier),
  );

  const skipped = file.items.length - labelled.length;
  if (labelled.length === 0) {
    throw new Error(`No items have a label set in ${inPath}. Fill in 'label' fields first.`);
  }

  console.log(`Loaded ${file.items.length} item(s) from ${inPath}`);
  console.log(`  ${labelled.length} labelled, ${skipped} skipped (label: null)`);
  console.log(`Running judge with concurrency=${args.concurrency}...`);

  const startedAt = Date.now();
  const judgements = await judgeEmails(
    labelled.map((i) => ({
      id: i.id,
      from: i.from,
      subject: i.subject,
      snippet: i.snippet ?? null,
      body: i.body ?? null,
      labels: i.labels,
    })),
    { concurrency: args.concurrency, interCallDelayMs: args.delayMs },
  );
  const elapsedMs = Date.now() - startedAt;

  const rows = labelled.map((item, i) => {
    const j = judgements[i];
    return {
      id: item.id,
      from: item.from,
      subject: item.subject,
      truth: item.label,
      predicted: j.tier,
      reason: j.reason,
      features: j.features,
      source: j.source,
      note: item.note,
    };
  });

  const right = rows.filter((r) => r.truth === r.predicted).length;
  const accuracy = right / rows.length;
  const accuracyPct = (accuracy * 100).toFixed(1);

  // Per-tier floors on top of the overall bar — asymmetric failure costs:
  // a missed PUSH is the worst failure, a real mail buried in SILENT is
  // second. See src/eval-floors.ts for the floor rationale.
  const floors = evaluateTierFloors(rows.map((r) => ({ truth: r.truth, predicted: r.predicted })));
  const passed = floors.pass;

  console.log(`\nOverall accuracy: ${right}/${rows.length} = ${accuracyPct}%`);
  console.log(`Elapsed: ${(elapsedMs / 1000).toFixed(1)}s`);
  console.log("\nGate checks:");
  for (const check of floors.checks.filter((c) => c.gating)) {
    const mark = check.pass ? "PASS" : "FAIL";
    console.log(
      `  [${mark}] ${check.name}: ${(check.value * 100).toFixed(1)}% (floor ${(check.floor * 100).toFixed(0)}%) — ${check.detail}`,
    );
  }
  console.log(
    passed ? "RESULT: PASS — all gates met." : "RESULT: FAIL — a gate is below its floor.",
  );

  const reportOnly = floors.checks.filter((c) => !c.gating);
  if (reportOnly.length > 0) {
    console.log("\nReport-only (visibility for the half-tier space, not gating):");
    for (const check of reportOnly) {
      console.log(
        `  [REPORT] ${check.name}: ${(check.value * 100).toFixed(1)}% (target ${(check.floor * 100).toFixed(0)}%) — ${check.detail}`,
      );
    }
  }

  printPerTierAccuracy(rows);
  printConfusionMatrix(rows);

  const disagreements: Disagreement[] = rows.filter((r) => r.truth !== r.predicted);
  printDisagreements(disagreements);

  if (args.out) {
    const outPath = resolve(args.out);
    writeFileSync(
      outPath,
      JSON.stringify(
        {
          metadata: {
            ...file.metadata,
            ranAt: new Date().toISOString(),
            accuracy,
            accuracyPct,
            passed,
            floorChecks: floors.checks,
            labelledCount: labelled.length,
            skippedCount: skipped,
          },
          rows,
        },
        null,
        2,
      ),
      "utf8",
    );
    console.log(`\nWrote detailed result → ${outPath}`);
  }

  if (!passed) process.exit(2);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
