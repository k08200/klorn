/**
 * Adversarial phishing eval (docs/design/attention-engine-v3.md §3(5)): runs
 * the production facts extractor on eval/phishing-eval-set.json and reports
 * phishing_suspect recall, the benign false-positive rate, and the policy v3.1
 * lane of every item under each sender scenario (src/judge/v3/phishing-eval.ts).
 * Synthetic, PII-free. Every item is To the set's user, so pre-facts fix
 * addressedTo me_direct, as for a targeted phish.
 *
 *   LLM_PROVIDER_ORDER=anthropic GLOBAL_DAILY_COST_CAP_CENTS=0 LLM_USAGE_LOG_DISABLED=true \
 *   DATABASE_URL=postgresql://eval:eval@localhost:5432/eval \
 *   npx tsx scripts/v3-phishing-eval.ts [--model=claude-haiku-5-5] [--runs=3] [--out=report.json]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LiveTier } from "@klorn/contract";
import { assertEvalEnv } from "../src/eval-v3/bench-io.js";
import { extractFacts } from "../src/judge/v3/facts-extractor.js";
import { type PhishingItemResult, summarizePhishingEval } from "../src/judge/v3/phishing-eval.js";

interface Item {
  id: string;
  from: string;
  to: string;
  subject: string;
  snippet?: string | null;
  body?: string | null;
  labels?: string[];
  receivedAt: string;
  phishing: boolean;
  labelV2: LiveTier;
}

const MAX_RUNS = 10;

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function runsArg(): number {
  const n = Number(arg("runs") ?? "1");
  if (!Number.isInteger(n) || n < 1 || n > MAX_RUNS) {
    throw new Error(`--runs must be an integer 1..${MAX_RUNS}`);
  }
  return n;
}

async function run(
  item: Item,
  userEmail: string,
  runNo: number,
  model: string | undefined,
): Promise<PhishingItemResult & { costUsd: number; issues: string[] }> {
  const receivedAt = new Date(item.receivedAt);
  const x = await extractFacts(
    {
      from: item.from,
      to: item.to,
      cc: null,
      userAddresses: [userEmail],
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
    run: runNo,
    phishing: item.phishing,
    expectedLane: item.labelV2,
    facts: x.facts,
    receivedAt,
    asksChecked: x.evidenceCheck.checked,
    asksDropped: x.evidenceCheck.dropped.length,
    automatedSenderSignal: x.signals.automatedSender,
    costUsd: x.usage?.costUsd ?? 0,
    // Validator issues and failure notes (no mail text): why an item had no facts.
    issues: x.issues,
  };
}

async function main(): Promise<number> {
  assertEvalEnv(process.env);
  const doc = JSON.parse(readFileSync(resolve("eval/phishing-eval-set.json"), "utf8")) as {
    metadata: { userEmail: string };
    items: Item[];
  };
  const model = arg("model");
  const runs = runsArg();
  const results: (PhishingItemResult & { costUsd: number; issues: string[] })[] = [];
  for (let runNo = 1; runNo <= runs; runNo++) {
    for (const item of doc.items) {
      results.push(await run(item, doc.metadata.userEmail, runNo, model));
    }
  }
  const perRun = Array.from({ length: runs }, (_, i) => {
    const s = summarizePhishingEval(results.filter((r) => r.run === i + 1));
    return { run: i + 1, recall: s.phishing.recall, falsePositiveRate: s.benign.falsePositiveRate };
  });
  const report = {
    model: model ?? "(JUDGE_V3_FACTS_MODEL / JUDGE_MODEL)",
    runs,
    costUsd: results.reduce((s, r) => s + r.costUsd, 0),
    perRun,
    pooled: summarizePhishingEval(results),
    facts: results.map((r) => ({ id: r.id, run: r.run, facts: r.facts, issues: r.issues })),
  };
  const json = JSON.stringify(report, null, 2);
  const out = arg("out");
  if (out) writeFileSync(resolve(out), json);
  else console.log(json);
  const p = report.pooled;
  console.error(
    `[v3-phishing-eval] recall ${p.phishing.flagged}/${p.phishing.total}, ` +
      `benign FP ${p.benign.flagged}/${p.benign.total}, noFacts ${p.noFacts}, ` +
      `cost $${report.costUsd.toFixed(4)}`,
  );
  return p.noFacts > 0 ? 3 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("[v3-phishing-eval] FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
