/**
 * Canary comparison CLI (#769) — compare two poc-accuracy --out reports.
 *
 * Usage:
 *   npx tsx scripts/canary-compare.ts \
 *     --prev=./canary-baseline.json \
 *     --curr=./canary-current.json \
 *     [--out=./canary-comparison.json]
 *
 * Exit codes:
 *   0 — stable (no verdict flips)
 *   2 — ALARM: at least one item's verdict flipped between runs
 *   1 — error (missing/malformed input)
 *
 * Pure read → compare → print; persists nothing beyond the optional --out.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type CanaryComparison,
  compareCanaryRuns,
  parseCanaryRunReport,
} from "../src/canary-compare.js";

function parseArgs(argv: string[]): { prev: string; curr: string; out?: string } {
  const map = new Map<string, string>();
  for (const raw of argv) {
    const kv = raw.match(/^--([\w-]+)=(.+)$/);
    if (kv) map.set(kv[1], kv[2]);
  }
  const prev = map.get("prev");
  const curr = map.get("curr");
  if (!prev || !curr)
    throw new Error("--prev=<baseline.json> and --curr=<current.json> are required");
  return { prev, curr, out: map.get("out") };
}

function loadReport(path: string, label: string) {
  const raw = JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
  return parseCanaryRunReport(raw, label);
}

function fmtPts(value: number): string {
  const pts = value * 100;
  const sign = pts > 0 ? "+" : "";
  return `${sign}${pts.toFixed(1)}pt`;
}

function printComparison(cmp: CanaryComparison): void {
  console.log(`Compared ${cmp.comparedCount} item(s) present in both runs with unchanged labels.`);
  if (cmp.addedItems.length > 0)
    console.log(`  added since baseline: ${cmp.addedItems.join(", ")}`);
  if (cmp.droppedItems.length > 0)
    console.log(`  dropped since baseline: ${cmp.droppedItems.join(", ")}`);
  if (cmp.relabeledItems.length > 0)
    console.log(`  relabeled (set edit, not drift): ${cmp.relabeledItems.join(", ")}`);

  console.log("\nFloor margins (value − floor; negative delta = margin shrank):");
  for (const d of cmp.marginDeltas) {
    const gate = d.gating ? "gate" : "report";
    console.log(
      `  ${d.name} [${gate}]: ${fmtPts(d.prevMargin)} → ${fmtPts(d.currMargin)} (Δ ${fmtPts(d.delta)})`,
    );
  }

  if (cmp.flips.length === 0) {
    console.log("\nRESULT: STABLE — no verdict flips against the baseline.");
    return;
  }
  console.log(`\nRESULT: ALARM — ${cmp.flips.length} verdict flip(s) on identical items:`);
  for (const f of cmp.flips) {
    console.log(
      `  ${f.id}: ${f.prevPredicted} → ${f.currPredicted} (truth ${f.truth})${f.subject ? ` — ${f.subject.slice(0, 60)}` : ""}`,
    );
    console.log(`      source: ${f.prevSource ?? "?"} → ${f.currSource ?? "?"}`);
  }
  console.log(
    "\nA flip on a fixed set with a temperature-0 judge means the decision boundary moved (prompt/threshold/provider drift). Investigate before accepting a new baseline (workflow_dispatch with accept-baseline).",
  );
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const prev = loadReport(args.prev, "baseline");
  const curr = loadReport(args.curr, "current");
  const cmp = compareCanaryRuns(prev, curr);
  printComparison(cmp);
  if (args.out) {
    writeFileSync(resolve(args.out), JSON.stringify(cmp, null, 2), "utf8");
    console.log(`\nWrote comparison → ${resolve(args.out)}`);
  }
  return cmp.flips.length > 0 ? 2 : 0;
}

try {
  process.exit(main());
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
