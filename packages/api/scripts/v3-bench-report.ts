/**
 * Attention engine v3, phase P1: turn stored v3-bench cell files into the
 * README tables. Re-scores every run against the labels in the eval file NOW
 * (labelV2 when the v2 ontology is on) and replays v3 lanes from the stored raw
 * facts under the current evidence rules and policy, so a relabel or a policy
 * change needs no new LLM calls.
 *
 *   npx tsx scripts/v3-bench-report.ts --dir=/tmp/p1/runs [--out=/tmp/p1/report.md]
 *
 * Skipped with a warning: files named *.degraded.*, and any run whose meta or
 * summary records a provider failure or a call served by another model.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { consistentMisses, rescore, type StoredRun, spreadTable } from "../src/eval-v3/analysis.js";
import {
  calibrationTable,
  cellLabel,
  groupCells,
  mainTable,
  spendLine,
} from "../src/eval-v3/report.js";
import type { ClassifiableEmail } from "../src/judge/email-classifier.js";
import { TIERS, type Tier } from "../src/judge/tiers.js";
import { tierV2Enabled } from "../src/ops/feature-flags.js";

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
}

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function loadSet(set: string) {
  if (!/^[\w-]+$/.test(set))
    throw new Error(`run file names an invalid set: ${JSON.stringify(set)}`);
  const items = (
    JSON.parse(readFileSync(resolve(`eval/${set}.json`), "utf8")) as { items: RawItem[] }
  ).items;
  const v2 = tierV2Enabled();
  const truth = new Map<string, Tier>();
  const email = new Map<string, ClassifiableEmail & { receivedAt?: string }>();
  for (const i of items) {
    const label = (v2 && i.labelV2 ? i.labelV2 : i.label) as Tier | null;
    if (label && TIERS.includes(label)) truth.set(i.id, label);
    email.set(i.id, {
      from: i.from,
      subject: i.subject,
      snippet: i.snippet,
      body: i.body ?? null,
      labels: i.labels ?? [],
      receivedAt: i.receivedAt,
    });
  }
  return { truth, email };
}

function loadRuns(dir: string, warnings: string[]): StoredRun[] {
  const sets = new Map<string, ReturnType<typeof loadSet>>();
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.includes(".degraded."))
    .map((f) => ({ f, run: JSON.parse(readFileSync(join(dir, f), "utf8")) as StoredRun }))
    .filter(({ f, run }) => {
      const bad = run.summary.degraded > 0 || (run.meta.servedByOther ?? 0) > 0;
      if (bad) warnings.push(`skipped ${f}: instrument degraded`);
      return !bad;
    })
    .map(({ run }) => {
      const set = sets.get(run.meta.set) ?? loadSet(run.meta.set);
      sets.set(run.meta.set, set);
      const rescored = rescore(run, set.truth, set.email);
      warnings.push(...rescored.warnings);
      return rescored;
    });
}

function sharedMissRows(runs: readonly StoredRun[]): string[] {
  const keys = [...new Set(runs.map((r) => `${r.meta.set}|${cellLabel(r.meta)}`))].sort();
  return keys.flatMap((key) => {
    const [set, label] = key.split("|");
    return consistentMisses(runs, set, label).map(
      (m) => `| ${set} | ${label} | ${m.id} | ${m.truth} | ${m.predicted.join(", ")} |`,
    );
  });
}

function main(): void {
  const dir = arg("dir");
  if (!dir) throw new Error("--dir=<runs dir> is required");
  const warnings: string[] = [];
  const runs = loadRuns(dir, warnings);
  const cells = groupCells(runs);
  const md = [
    "### Per cell (one value per run)",
    "",
    mainTable(cells),
    "",
    "### Spread across models (mean of runs)",
    "",
    spreadTable(runs),
    "",
    "### v2 calibration on urgent (truth-PUSH) items",
    "",
    calibrationTable(cells),
    "",
    "### Misses shared by every model in every run",
    "",
    "| set | prompt | item | truth | predicted |",
    "|---|---|---|---|---|",
    ...sharedMissRows(runs),
    "",
    spendLine(runs),
    ...(warnings.length > 0 ? ["", "Warnings:", ...warnings.map((w) => `- ${w}`)] : []),
  ].join("\n");
  const out = arg("out");
  if (out) writeFileSync(resolve(out), `${md}\n`, "utf8");
  console.log(md);
}

main();
