/**
 * Facts v1 eval on the synthetic set (docs/design/attention-engine-v3.md §5):
 * runs the production extractor on eval/judge-eval-set.json items and scores
 * them against eval/facts/synthetic-facts.json (per-field accuracy, ask-kind
 * precision/recall, evidence validity). Synthetic, PII-free.
 *
 *   LLM_PROVIDER_ORDER=anthropic GLOBAL_DAILY_COST_CAP_CENTS=0 LLM_USAGE_LOG_DISABLED=true \
 *   DATABASE_URL=postgresql://eval:eval@localhost:5432/eval \
 *   npx tsx scripts/v3-fact-eval.ts [--model=claude-haiku-5-5] [--out=report.json]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type EvalItemResult,
  type FactLabel,
  summarizeFactEval,
} from "../src/judge/v3/fact-eval.js";
import { extractFacts } from "../src/judge/v3/facts-extractor.js";

interface Item {
  id: string;
  from: string;
  subject: string;
  snippet?: string | null;
  body?: string | null;
  labels?: string[];
  receivedAt: string;
}

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

async function run(
  item: Item,
  label: FactLabel,
  model: string | undefined,
): Promise<EvalItemResult & { costUsd: number }> {
  const receivedAt = new Date(item.receivedAt);
  const x = await extractFacts(
    {
      from: item.from,
      to: null,
      cc: null,
      userAddresses: [],
      subject: item.subject,
      snippet: item.snippet ?? null,
      body: item.body ?? null,
      labels: item.labels ?? [],
      hasListUnsubscribe: null,
      listId: null,
      precedence: null,
      autoSubmitted: null,
      hasCalendarInvite: null,
      userRepliedAfter: null,
      dateHeader: null,
      receivedAt,
      userTimeZone: null,
    },
    model ? { model } : {},
  );
  return {
    id: item.id,
    facts: x.facts,
    label,
    receivedAt,
    asksChecked: x.evidenceCheck.checked,
    asksDropped: x.evidenceCheck.dropped.length,
    costUsd: x.usage?.costUsd ?? 0,
  };
}

async function main(): Promise<number> {
  const items = JSON.parse(readFileSync(resolve("eval/judge-eval-set.json"), "utf8"))
    .items as Item[];
  const labels = JSON.parse(readFileSync(resolve("eval/facts/synthetic-facts.json"), "utf8"))
    .items as {
    id: string;
    labels: FactLabel;
  }[];
  const model = arg("model");
  const results = [];
  for (const { id, labels: label } of labels) {
    const item = items.find((i) => i.id === id);
    if (!item) throw new Error(`label for unknown item ${id}`);
    results.push(await run(item, label, model));
  }
  const report = {
    model: model ?? "(JUDGE_V3_FACTS_MODEL / JUDGE_MODEL)",
    costUsd: results.reduce((s, r) => s + r.costUsd, 0),
    ...summarizeFactEval(results),
  };
  const json = JSON.stringify(report, null, 2);
  const out = arg("out");
  if (out) writeFileSync(resolve(out), json);
  console.log(json);
  return report.noFacts > 0 ? 3 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("[v3-fact-eval] FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
