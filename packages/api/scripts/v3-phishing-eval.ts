/**
 * Adversarial phishing eval (docs/design/attention-engine-v3.md §3(5)): runs
 * the production facts extractor on eval/phishing-eval-set.json and reports
 * phishing_suspect recall, the benign false-positive rate, and the policy lane
 * of every item under each sender scenario (src/judge/v3/phishing-eval.ts).
 * `pooled` scores the live version; --policy-versions=v3.1,v3.2 adds
 * `byVersion`, every listed version over the same facts.
 * Synthetic, PII-free. Every item is To the set's user, so pre-facts fix
 * addressedTo me_direct, as for a targeted phish.
 *
 *   LLM_PROVIDER_ORDER=anthropic GLOBAL_DAILY_COST_CAP_CENTS=0 LLM_USAGE_LOG_DISABLED=true \
 *   DATABASE_URL=postgresql://eval:eval@localhost:5432/eval \
 *   npx tsx scripts/v3-phishing-eval.ts [--model=claude-haiku-5-5] [--runs=3] [--out=report.json] \
 *     [--policy-versions=v3.1,v3.2]
 *
 * Exit codes: 0 ok; 1 failed; 3 instrument degraded: an item got no facts, or
 * (with --model) an answer was served by another model after a silent failover.
 * Cost is a lower bound: an answer that fails to parse reports no usage.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LiveTier } from "@klorn/contract";
import { assertEvalEnv } from "../src/eval-v3/bench-io.js";
import { extractFacts } from "../src/judge/v3/facts-extractor.js";
import {
  PHISHING_SCENARIOS,
  type PhishingItemResult,
  servedByOther,
  summarizePhishingEval,
} from "../src/judge/v3/phishing-eval.js";
import { POLICY_VERSION, POLICY_VERSIONS, type PolicyVersion } from "../src/judge/v3/policy.js";

type RunResult = PhishingItemResult & {
  costUsd: number;
  issues: string[];
  servedModel: string | null;
  servedProvider: string | null;
};

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

function versionsArg(): PolicyVersion[] {
  const raw = (arg("policy-versions") ?? POLICY_VERSION).split(",").map((v) => v.trim());
  const bad = raw.filter((v) => !(POLICY_VERSIONS as readonly string[]).includes(v));
  if (bad.length > 0) {
    throw new Error(`--policy-versions must name versions in ${POLICY_VERSIONS.join(", ")}`);
  }
  return raw as PolicyVersion[];
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
): Promise<RunResult> {
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
    servedModel: x.model,
    servedProvider: x.provider,
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
  const versions = versionsArg();
  const results: RunResult[] = [];
  for (let runNo = 1; runNo <= runs; runNo++) {
    for (const item of doc.items) {
      results.push(await run(item, doc.metadata.userEmail, runNo, model));
    }
  }
  const perRun = Array.from({ length: runs }, (_, i) => {
    const s = summarizePhishingEval(results.filter((r) => r.run === i + 1));
    return {
      run: i + 1,
      recall: s.phishing.recall,
      falsePositiveRate: s.benign.falsePositiveRate,
      noFacts: s.noFacts,
    };
  });
  const served: Record<string, number> = {};
  for (const r of results) {
    const key = r.servedModel ? `${r.servedProvider ?? "?"}/${r.servedModel}` : "(no answer)";
    served[key] = (served[key] ?? 0) + 1;
  }
  const otherModel = model
    ? servedByOther(
        results.map((r) => r.servedModel),
        model,
      )
    : 0;
  const report = {
    model: model ?? "(JUDGE_V3_FACTS_MODEL / JUDGE_MODEL)",
    served,
    servedByOther: model ? otherModel : null,
    runs,
    costUsd: results.reduce((s, r) => s + r.costUsd, 0),
    perRun,
    pooled: summarizePhishingEval(results),
    byVersion: Object.fromEntries(
      versions.map((v) => [v, summarizePhishingEval(results, PHISHING_SCENARIOS, v)]),
    ),
    facts: results.map((r) => ({
      id: r.id,
      run: r.run,
      model: r.servedModel,
      provider: r.servedProvider,
      facts: r.facts,
      automatedSenderSignal: r.automatedSenderSignal,
      issues: r.issues,
    })),
  };
  const json = JSON.stringify(report, null, 2);
  const out = arg("out");
  if (out) writeFileSync(resolve(out), json);
  else console.log(json);
  const p = report.pooled;
  console.error(
    `[v3-phishing-eval] recall ${p.phishing.flagged}/${p.phishing.total}, ` +
      `benign FP ${p.benign.flagged}/${p.benign.total}, noFacts ${p.noFacts.total}, ` +
      `served ${JSON.stringify(served)}, cost $${report.costUsd.toFixed(4)}`,
  );
  for (const [v, summary] of Object.entries(report.byVersion)) {
    const interrupts = Object.entries(summary.scenarios).map(
      ([name, sc]) => `${name} ${sc.phishingInterrupts.length}`,
    );
    console.error(`[v3-phishing-eval] ${v} phishing interrupts: ${interrupts.join(", ")}`);
  }
  if (otherModel > 0) {
    console.error(
      `[v3-phishing-eval] ${otherModel} answer(s) were served by a model other than ${model}`,
    );
  }
  return p.noFacts.total > 0 || otherModel > 0 ? 3 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("[v3-phishing-eval] FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
