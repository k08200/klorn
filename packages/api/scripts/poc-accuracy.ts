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
 * Context (#650 — the eval runs the judge's real context-consumption path):
 *   --context=fixture (default)  per-item `context` fixtures from the JSON
 *                                (items without one get the empty context,
 *                                byte-identical to the pre-#650 eval)
 *   --context=empty              force the empty context (A/B baseline)
 *   --context=db --user=<email>  assemble each item's context through the
 *                                PRODUCTION buildJudgeContext against a real
 *                                DB — the instrument for measuring context
 *                                flags (LEARNED_RULES_IN_JUDGE etc.) offline
 *
 * Gating floors (#650): --gate-floor=auto-recall=0.5,push-recall=0.95
 * promotes/tightens per-tier floors (ratchet: committed gates only tighten).
 *
 * The script does not persist anything. It only reads the JSON and calls
 * the LLM via poc-judge.ts.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ClassifiableEmail } from "../src/email-classifier.js";
import { fixtureToJudgeContext } from "../src/eval-context.js";
import {
  computePerTierMetrics,
  diffTierMetrics,
  evaluateTierFloors,
  type FloorOverrides,
  parseGateFloorOverrides,
  type TierMetric,
} from "../src/eval-floors.js";
import {
  type JudgeContext,
  judgeEmails,
  POC_TIERS,
  type PocJudgement,
  type PocTier,
} from "../src/poc-judge.js";
import { TIERS, type Tier } from "../src/tiers.js";

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
  /**
   * Optional per-item JudgeContext fixture (#650) — corrections, senderPrior,
   * senderFacts, senderTraits, learnedRules — fed to the judge in
   * --context=fixture mode so the context-consumption path is exercised
   * deterministically. Validated strictly (eval-context.ts): a typo'd fixture
   * fails the run instead of silently degrading to the empty context.
   */
  context?: unknown;
}

interface GroundTruthFile {
  metadata: { userEmail: string; extractedAt: string; count: number };
  items: GroundTruthItem[];
}

type ContextMode = "empty" | "fixture" | "db";

interface CliArgs {
  in: string;
  out?: string;
  concurrency: number;
  delayMs: number;
  /** Run the set twice (JUDGE_INCLUDE_BODY off then on) and print the delta. */
  compareBody: boolean;
  /** Where each item's JudgeContext comes from (#650). */
  contextMode: ContextMode;
  /** Account email for --context=db (resolved to a userId against the DB). */
  user?: string;
  /** Per-tier gating floor overrides (#650), e.g. auto-recall=0.5. */
  gateFloors: FloorOverrides;
}

function parseArgs(argv: string[]): CliArgs {
  const map = new Map<string, string>();
  const flags = new Set<string>();
  for (const raw of argv) {
    const kv = raw.match(/^--([\w-]+)=(.+)$/);
    if (kv) {
      map.set(kv[1], kv[2]);
      continue;
    }
    const bare = raw.match(/^--([\w-]+)$/);
    if (bare) flags.add(bare[1]);
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
  const contextMode = (map.get("context") ?? "fixture") as ContextMode;
  if (!["empty", "fixture", "db"].includes(contextMode)) {
    throw new Error("--context must be empty, fixture, or db");
  }
  const user = map.get("user");
  if (contextMode === "db" && !user) {
    throw new Error("--context=db requires --user=<account email>");
  }
  return {
    in: input,
    out: map.get("out"),
    concurrency,
    delayMs,
    compareBody: flags.has("compare-body"),
    contextMode,
    user,
    gateFloors: map.has("gate-floor") ? parseGateFloorOverrides(map.get("gate-floor") ?? "") : {},
  };
}

/** True when at least one LLM provider is configured (mirrors eval.yml). */
function hasProviderKey(): boolean {
  return Boolean(
    process.env.OPENROUTER_API_KEY ||
      process.env.GEMINI_API_KEY ||
      process.env.OPENAI_COMPAT_BASE_URL,
  );
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

/** Render a rate as a percentage, or "—" when it is null (unknown support). */
function fmtRate(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

/** Render a signed delta as points, or "—" when null (a side was vacuous). */
function fmtDelta(value: number | null): string {
  if (value === null) return "—";
  const pts = value * 100;
  const sign = pts > 0 ? "+" : "";
  return `${sign}${pts.toFixed(1)}pt`;
}

// Below this truth-support, AUTO recall is too coarse to trust (each miss
// swings it by ≥0.2) — flagged, never gated. Mirrors eval-floors' rationale.
const LOW_SUPPORT_THRESHOLD = 5;

function printPerTierMetrics(metrics: TierMetric[]): void {
  console.log("\nPer-tier metrics (precision + recall + support; '—' = no support, unknown):");
  console.log(
    `  ${pad("tier", 8)}${pad("precision", 11)}${pad("recall", 11)}${pad("truth-n", 9)}${pad("pred-n", 8)}`,
  );
  for (const m of metrics) {
    console.log(
      `  ${pad(m.tier, 8)}${pad(fmtRate(m.precision), 11)}${pad(fmtRate(m.recall), 11)}${pad(m.truthSupport, 9)}${pad(m.predictedSupport, 8)}`,
    );
  }
}

/**
 * The two trust-to-hide-mail metrics, surfaced prominently: SILENT precision
 * (of everything hidden as marketing, how much was really hideable) and AUTO
 * recall (of everything safe to auto-handle, how much did we catch). These are
 * the metrics that decide whether it's safe to keep mail off the user's radar.
 */
function printSuppressionTrust(metrics: TierMetric[]): void {
  const silent = metrics.find((m) => m.tier === "SILENT");
  const auto = metrics.find((m) => m.tier === "AUTO");
  console.log("\n=== SUPPRESSION TRUST (the trust-to-hide-mail metrics) ===");
  if (silent) {
    console.log(
      `  SILENT precision: ${fmtRate(silent.precision)} over ${silent.predictedSupport} predicted-SILENT — of mail hidden as marketing, how much truly was.`,
    );
  }
  if (auto) {
    const lowSupport = auto.truthSupport < LOW_SUPPORT_THRESHOLD;
    const caveat = lowSupport ? " (low support, not gated)" : "";
    console.log(
      `  AUTO recall:      ${fmtRate(auto.recall)} over ${auto.truthSupport} truth-AUTO${caveat} — of mail safe to auto-handle, how much we caught.`,
    );
  }
}

function printBodyDelta(deltas: ReturnType<typeof diffTierMetrics>): void {
  console.log("\n=== BODY DELTA (body-on minus body-off; '—' = a side had no support) ===");
  console.log(`  ${pad("tier", 8)}${pad("Δ precision", 13)}${pad("Δ recall", 12)}`);
  for (const d of deltas) {
    console.log(
      `  ${pad(d.tier, 8)}${pad(fmtDelta(d.precisionDelta), 13)}${pad(fmtDelta(d.recallDelta), 12)}`,
    );
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

type LabelledItem = GroundTruthItem & { label: PocTier };

interface Row {
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

interface LoadedSet {
  file: GroundTruthFile;
  labelled: LabelledItem[];
  skipped: number;
  inPath: string;
}

function loadLabelledSet(inArg: string): LoadedSet {
  const inPath = resolve(inArg);
  const raw = readFileSync(inPath, "utf8");
  const file = JSON.parse(raw) as GroundTruthFile;
  const labelled = file.items.filter(
    (i): i is LabelledItem => i.label !== null && POC_TIERS.includes(i.label as PocTier),
  );
  const skipped = file.items.length - labelled.length;
  if (labelled.length === 0) {
    throw new Error(`No items have a label set in ${inPath}. Fill in 'label' fields first.`);
  }
  return { file, labelled, skipped, inPath };
}

type ContextFor = (email: ClassifiableEmail, index: number) => JudgeContext | Promise<JudgeContext>;

/**
 * Build the per-item context source for the run (#650).
 *  - empty:   undefined → judgeEmail's EMPTY_JUDGE_CONTEXT default (baseline)
 *  - fixture: strict per-item fixtures from the eval JSON (DB-free, CI-safe)
 *  - db:      the PRODUCTION buildJudgeContext against a real DB — imported
 *             lazily so the CI path never touches the Prisma client's env.
 */
async function resolveContextFor(
  labelled: LabelledItem[],
  args: CliArgs,
): Promise<ContextFor | undefined> {
  if (args.contextMode === "empty") return undefined;
  if (args.contextMode === "fixture") {
    return (_email, index) => fixtureToJudgeContext(labelled[index].context, labelled[index].id);
  }
  const [{ buildJudgeContext }, { prisma }] = await Promise.all([
    import("../src/judge-context.js"),
    import("../src/db.js"),
  ]);
  const account = await prisma.user.findUnique({
    where: { email: args.user },
    select: { id: true },
  });
  if (!account) throw new Error(`--context=db: no user found for email=${args.user}`);
  return (_email, index) =>
    buildJudgeContext(account.id, {
      from: labelled[index].from,
      subject: labelled[index].subject,
    });
}

/** Run the judge over the labelled set and pair predictions with truth. */
async function runJudge(
  labelled: LabelledItem[],
  args: CliArgs,
  contextFor: ContextFor | undefined,
): Promise<Row[]> {
  const judgements = await judgeEmails(
    labelled.map((i) => ({
      id: i.id,
      from: i.from,
      subject: i.subject,
      snippet: i.snippet ?? null,
      body: i.body ?? null,
      labels: i.labels,
    })),
    { concurrency: args.concurrency, interCallDelayMs: args.delayMs, contextFor },
  );
  return labelled.map((item, i) => {
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
}

function tierPairs(rows: Row[]): Array<{ truth: Tier; predicted: Tier }> {
  return rows.map((r) => ({ truth: r.truth as Tier, predicted: r.predicted as Tier }));
}

/**
 * Body off-vs-on comparison: runs the SAME set twice, flipping
 * JUDGE_INCLUDE_BODY between runs (poc-judge reads it per call). Prints both
 * per-tier metric tables and a DELTA table. Requires a provider key — skips
 * cleanly (exit 0) when none is present, mirroring eval.yml.
 */
async function runBodyComparison(
  loaded: LoadedSet,
  args: CliArgs,
  contextFor: ContextFor | undefined,
): Promise<void> {
  if (!hasProviderKey()) {
    console.log(
      "\nno provider key — comparison skipped. Set OPENROUTER_API_KEY, GEMINI_API_KEY, or OPENAI_COMPAT_BASE_URL to run the body off-vs-on eval.",
    );
    return;
  }

  const { labelled, inPath } = loaded;
  console.log(
    `\nBody off-vs-on comparison over ${labelled.length} labelled item(s) from ${inPath}`,
  );
  console.log(
    `concurrency=${args.concurrency}, delay=${args.delayMs}ms per run, context=${args.contextMode}`,
  );

  const priorBodyFlag = process.env.JUDGE_INCLUDE_BODY;
  try {
    console.log("\n--- RUN 1/2: JUDGE_INCLUDE_BODY off (judge blind to body) ---");
    process.env.JUDGE_INCLUDE_BODY = "false";
    const offRows = await runJudge(labelled, args, contextFor);
    const offMetrics = computePerTierMetrics(tierPairs(offRows));
    const offAccuracy = offRows.filter((r) => r.truth === r.predicted).length / offRows.length;
    printPerTierMetrics(offMetrics);
    console.log(`  overall accuracy (body off): ${(offAccuracy * 100).toFixed(1)}%`);

    console.log("\n--- RUN 2/2: JUDGE_INCLUDE_BODY on (body fed to judge) ---");
    process.env.JUDGE_INCLUDE_BODY = "true";
    const onRows = await runJudge(labelled, args, contextFor);
    const onMetrics = computePerTierMetrics(tierPairs(onRows));
    const onAccuracy = onRows.filter((r) => r.truth === r.predicted).length / onRows.length;
    printPerTierMetrics(onMetrics);
    console.log(`  overall accuracy (body on): ${(onAccuracy * 100).toFixed(1)}%`);

    printBodyDelta(diffTierMetrics(offMetrics, onMetrics));
    console.log(
      `\n  overall accuracy delta: ${fmtDelta(onAccuracy - offAccuracy)} (body on − body off) — the measured value of feeding the body.`,
    );
    printSuppressionTrust(onMetrics);
  } finally {
    // Restore the ambient flag — never leak a mutation into the process env.
    if (priorBodyFlag === undefined) delete process.env.JUDGE_INCLUDE_BODY;
    else process.env.JUDGE_INCLUDE_BODY = priorBodyFlag;
  }
}

async function runSingle(
  loaded: LoadedSet,
  args: CliArgs,
  contextFor: ContextFor | undefined,
): Promise<void> {
  const { file, labelled, skipped } = loaded;

  console.log(`Loaded ${file.items.length} item(s) from ${loaded.inPath}`);
  console.log(`  ${labelled.length} labelled, ${skipped} skipped (label: null)`);
  console.log(`Running judge with concurrency=${args.concurrency}, context=${args.contextMode}...`);

  const startedAt = Date.now();
  const rows = await runJudge(labelled, args, contextFor);
  const elapsedMs = Date.now() - startedAt;

  const right = rows.filter((r) => r.truth === r.predicted).length;
  const accuracy = right / rows.length;
  const accuracyPct = (accuracy * 100).toFixed(1);

  // Per-tier floors on top of the overall bar — asymmetric failure costs:
  // a missed PUSH is the worst failure, a real mail buried in SILENT is
  // second. See src/eval-floors.ts for the floor rationale.
  const floors = evaluateTierFloors(
    rows.map((r) => ({ truth: r.truth, predicted: r.predicted })),
    args.gateFloors,
  );
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

  // Additive diagnostics: full per-tier precision/recall/support table and the
  // two trust-to-hide-mail metrics. These do NOT gate — the floors above do.
  const metrics = computePerTierMetrics(tierPairs(rows));
  printPerTierMetrics(metrics);
  printSuppressionTrust(metrics);

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
            contextMode: args.contextMode,
            gateFloorOverrides: args.gateFloors,
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const loaded = loadLabelledSet(args.in);
  const contextFor = await resolveContextFor(loaded.labelled, args);
  try {
    if (args.compareBody) {
      await runBodyComparison(loaded, args, contextFor);
      return;
    }
    await runSingle(loaded, args, contextFor);
  } finally {
    // db mode keeps a Prisma pool open, which would hold the event loop
    // hostage after a successful run — disconnect so the script can exit.
    if (args.contextMode === "db") {
      const { prisma } = await import("../src/db.js");
      await prisma.$disconnect();
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
