/**
 * Policy variant tables (docs/design/attention-engine-v3.md §3(5), "Policy
 * v3.2"). No LLM calls: replays the facts stored in P1's bench runs, and
 * optionally in a v3-phishing-eval report, under every variant in
 * src/eval-v3/variants.ts and each sender scenario.
 *
 *   npx tsx scripts/v3-policy-variants.ts --dir=<P1 runs dir> \
 *     [--phishing=<v3-phishing-eval report.json>] [--trusted=eval-046]
 *
 * Prints markdown: aggregate counts and item ids only, never mail text.
 * --trusted names the items whose sender the third scenario treats as a known
 * correspondent with a DMARC pass (default eval-046, the P3 bar's open item).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LiveTier } from "@klorn/contract";
import { type EvalEmail, rescore, type StoredRun } from "../src/eval-v3/analysis.js";
import type { BenchRow, Ratio } from "../src/eval-v3/metrics.js";
import { cellLabel } from "../src/eval-v3/report.js";
import {
  demotedCorrect,
  laneMetrics,
  POLICY_VARIANTS,
  type PolicyVariant,
  senderScenarios,
  variantDecider,
} from "../src/eval-v3/variants.js";
import { isAutomatedSender } from "../src/judge/keyword-policy.js";
import { TIERS, type Tier } from "../src/judge/tiers.js";
import type { FactsV1 } from "../src/judge/v3/facts-schema.js";
import { PHISHING_SCENARIOS } from "../src/judge/v3/phishing-eval.js";
import { laneFromFactsUnderRules } from "../src/judge/v3/policy.js";
import { tierV2Enabled } from "../src/ops/feature-flags.js";

const SETS = { gate: "judge-eval-set", real: "real-eval-set" } as const;
/** The v2 control per set, as the doc's "Against v2" table reads it. */
const V2_CELL: Record<string, string> = {
  "judge-eval-set": "v2",
  "real-eval-set": "v2 (front ctx)",
};
const PRODUCTION_MODEL = "claude-haiku-5-5";

interface RawItem {
  id: string;
  from: string;
  subject: string;
  snippet: string | null;
  body?: string | null;
  labels?: string[];
  receivedAt?: string;
  label: string | null;
  labelV2?: string;
  phishing?: boolean;
}

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function loadItems(set: string): RawItem[] {
  return (JSON.parse(readFileSync(resolve(`eval/${set}.json`), "utf8")) as { items: RawItem[] })
    .items;
}

function loadSet(set: string) {
  const v2 = tierV2Enabled();
  const truth = new Map<string, Tier>();
  const email = new Map<string, EvalEmail>();
  for (const i of loadItems(set)) {
    const label = (v2 && i.labelV2 ? i.labelV2 : i.label) as Tier | null;
    if (label && TIERS.includes(label)) truth.set(i.id, label);
    email.set(i.id, { ...i, body: i.body ?? null, labels: i.labels ?? [] });
  }
  return { truth, email };
}

function loadRuns(dir: string): StoredRun[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.includes(".degraded."))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as StoredRun)
    .filter((r) => r.summary.degraded === 0 && (r.meta.servedByOther ?? 0) === 0)
    .sort((a, b) => `${a.meta.model}${a.meta.run}`.localeCompare(`${b.meta.model}${b.meta.run}`));
}

const pct = (r: Ratio) => (r.n ? `${((100 * r.hit) / r.n).toFixed(1)}% (${r.hit}/${r.n})` : "—");

function metricCells(rows: readonly BenchRow[]): string {
  const m = laneMetrics(rows);
  return [
    m.overall,
    m.pushRecall,
    m.pushPrecision,
    m.silentPrecision,
    m.meetingRecall,
    m.meetingPrecision,
  ]
    .map(pct)
    .join(" | ");
}

const idCounts = (byId: Map<string, number>) =>
  [...byId.entries()].map(([id, n]) => `${id.slice(0, 20)}×${n}`).join(", ") || "none";

function setTables(set: string, runs: readonly StoredRun[], trusted: string[]): string[] {
  const { truth, email } = loadSet(set);
  const scenarios = senderScenarios(trusted);
  const out: string[] = [];
  for (const [pool, keep] of [
    ["4 models", () => true],
    ["Haiku 5.5", (r: StoredRun) => r.meta.model === PRODUCTION_MODEL],
  ] as const) {
    const inSet = runs.filter((r) => r.meta.set === set && keep(r));
    const v2 = inSet.filter((r) => cellLabel(r.meta) === V2_CELL[set]);
    const v3 = inSet.filter((r) => cellLabel(r.meta) === "v3");
    const rowsOf = (variant: PolicyVariant | null, s = scenarios[0]) =>
      (variant ? v3 : v2).flatMap(
        (r) => rescore(r, truth, email, variant ? variantDecider(variant, s) : "doc").rows,
      );
    out.push(
      `\n#### ${set}, ${pool} (${v3.length} v3 runs)\n`,
      "| policy | senders | overall | PUSH recall | PUSH precision | SILENT precision | MEETING recall | MEETING precision | correct PUSH/MEETING lost vs v3.1 |",
      "|---|---|---|---|---|---|---|---|---|",
      `| v2 | (no trust rule) | ${metricCells(rowsOf(null))} | |`,
    );
    for (const s of scenarios) {
      const base = rowsOf(POLICY_VARIANTS[0], s);
      for (const variant of POLICY_VARIANTS) {
        const rows = variant === POLICY_VARIANTS[0] ? base : rowsOf(variant, s);
        const lost = variant === POLICY_VARIANTS[0] ? "" : idCounts(demotedCorrect(base, rows));
        out.push(`| ${variant.name} | ${s.name} | ${metricCells(rows)} | ${lost} |`);
      }
    }
  }
  return out;
}

interface PhishingFacts {
  id: string;
  run: number;
  facts: FactsV1 | null;
  automatedSenderSignal?: boolean;
}

const INTERRUPT: ReadonlySet<LiveTier> = new Set(["PUSH", "MEETING"]);

function phishingTables(path: string): string[] {
  const report = JSON.parse(readFileSync(resolve(path), "utf8")) as { facts: PhishingFacts[] };
  const items = new Map(loadItems("phishing-eval-set").map((i) => [i.id, i]));
  const scored = report.facts.filter((f) => f.facts && items.has(f.id));
  const approximated = scored.filter((f) => f.automatedSenderSignal === undefined).length;
  const out = [
    `\n#### phishing-eval-set (${scored.length} answers with facts${approximated ? `; automated-sender signal recomputed from From for ${approximated}` : ""})\n`,
    "| policy | senders | phishing mail that interrupts (PUSH/MEETING) | genuine look-alikes on their label | genuine off their label |",
    "|---|---|---|---|---|",
  ];
  for (const s of PHISHING_SCENARIOS) {
    for (const variant of POLICY_VARIANTS) {
      const interrupts = new Map<string, number>();
      const benignMisses = new Map<string, number>();
      let benign = 0;
      let benignRight = 0;
      for (const f of scored) {
        const item = items.get(f.id) as RawItem;
        const decidedAt = new Date(item.receivedAt as string);
        const { lane } = laneFromFactsUnderRules(
          {
            facts: f.facts as FactsV1,
            relationship: s.relationship(decidedAt),
            senderAuthenticated: s.senderAuthenticated,
            automatedSender: f.automatedSenderSignal ?? isAutomatedSender(item.from),
            spam: false,
            decidedAt,
          },
          variant.rules(decidedAt),
        );
        if (item.phishing && INTERRUPT.has(lane)) {
          interrupts.set(f.id, (interrupts.get(f.id) ?? 0) + 1);
        }
        if (!item.phishing) {
          benign++;
          if (lane === item.labelV2) benignRight++;
          else benignMisses.set(`${f.id}→${lane}`, (benignMisses.get(`${f.id}→${lane}`) ?? 0) + 1);
        }
      }
      const total = [...interrupts.values()].reduce((a, b) => a + b, 0);
      out.push(
        `| ${variant.name} | ${s.name} | ${total} (${idCounts(interrupts)}) | ${pct({ hit: benignRight, n: benign })} | ${idCounts(benignMisses)} |`,
      );
    }
  }
  return out;
}

function main(): void {
  const dir = arg("dir");
  if (!dir) throw new Error("--dir=<P1 runs dir> is required");
  const trusted = (arg("trusted") ?? "eval-046").split(",").filter(Boolean);
  const runs = loadRuns(dir);
  const lines = [
    "### Policy variants: stored facts replayed, no LLM calls",
    ...setTables(SETS.gate, runs, trusted),
    ...setTables(SETS.real, runs, trusted),
  ];
  const phishing = arg("phishing");
  if (phishing) lines.push(...phishingTables(phishing));
  console.log(lines.join("\n"));
}

main();
