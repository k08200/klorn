/**
 * Attention engine v3, phase P1: benchmark ONE cell (set × model × prompt × run).
 *
 *   --prompt=v2  the production judge, unchanged (4 calibrated scores → tier rule → floors)
 *   --prompt=v3  facts schema v1 with verified evidence → doc §3(4) policy
 *
 * Both share the deterministic front (pin, marketing fast-path, sender prior,
 * learned rule). With --context=fixture the v2 prompt ALSO sees the fixtures'
 * sender facts, traits and corrections, which the v3 fact prompt does not;
 * --context=front strips those, so only the LLM stage differs. One process per
 * run on purpose: the v2 judge keeps an in-process prompt cache, which would
 * make a second run in the same process a replay instead of a measurement.
 *
 * Usage. Set Anthropic as the only provider. LLM_PROVIDER_ORDER only reorders
 * the chain, so every call's served model is also checked against --model:
 *   LLM_PROVIDER_ORDER=anthropic JUDGE_INCLUDE_BODY=true GLOBAL_DAILY_COST_CAP_CENTS=0 \
 *   LLM_USAGE_LOG_DISABLED=true DATABASE_URL=postgresql://eval:eval@localhost:5432/eval \
 *   npx tsx scripts/v3-bench.ts --in=eval/judge-eval-set.json --model=claude-haiku-5-5 \
 *     --prompt=v3 --run=1 --out=/tmp/p1/runs/judge-eval-set.claude-haiku-5-5.v3.1.json
 *
 * Exit codes: 0 ok; 1 bad args or unsafe env; 3 instrument degraded (a provider
 * failure, or a call served by another model). The file is still written, with
 * the counts in meta, and the report skips it.
 * Writes counts, labels, lanes, facts and token usage only; never API keys.
 */
import { writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { installCallTap } from "../src/eval-v3/call-tap.js";

// Before any app import: the provider SDK clients are created lazily and pick up this fetch.
const tap = installCallTap();

async function main(): Promise<void> {
  const io = await import("../src/eval-v3/bench-io.js");
  io.assertEvalEnv(process.env);
  const args = io.parseBenchArgs(process.argv.slice(2));
  const inPath = io.assertEvalSet(args.in, resolve("eval"));
  const [{ tierV2Enabled }, runner] = await Promise.all([
    import("../src/ops/feature-flags.js"),
    import("../src/eval-v3/runner.js"),
  ]);
  const useLabelV2 = tierV2Enabled();
  const items = io.loadEvalItems(inPath, { ...args, useLabelV2 });
  const includeBody = ["1", "true", "yes"].includes(
    (process.env.JUDGE_INCLUDE_BODY ?? "").toLowerCase(),
  );
  console.log(
    `v3-bench: ${basename(inPath)} × ${args.model} × ${args.prompt} run ${args.run}: ${items.length} items, context ${args.context}, concurrency ${args.concurrency}, body ${includeBody ? "on" : "off"}, labels ${useLabelV2 ? "labelV2" : "label"}`,
  );

  const started = Date.now();
  const rows = await runner.mapPool(items, args.concurrency, args.delayMs, (item) =>
    args.prompt === "v2"
      ? runner.judgeItemV2(item, item.context, args.model)
      : runner.judgeItemV3(item, item.context, args.model, includeBody),
  );
  await tap.settle();
  const servedByOther = io.countServedByOther(tap.calls, args.model);
  const meta = {
    set: basename(inPath, ".json"),
    model: args.model,
    prompt: args.prompt,
    run: args.run,
    ranAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    includeBody,
    labels: useLabelV2 ? "labelV2" : "label",
    context: args.context,
    providerOrder: process.env.LLM_PROVIDER_ORDER ?? "(default)",
    servedByOther,
  };
  const degraded = await writeRun(args, meta, items, rows);
  if (degraded > 0 || servedByOther > 0) {
    console.error(
      `INSTRUMENT DEGRADED: ${degraded} provider failure(s), ${servedByOther} call(s) served by another model. The report skips this run.`,
    );
    process.exit(3);
  }
}

type Runner = typeof import("../src/eval-v3/runner.js");
type Items = ReturnType<typeof import("../src/eval-v3/bench-io.js").loadEvalItems>;
type Rows = Awaited<ReturnType<Runner["judgeItemV2"]>>[];

/** Summarise, add the v2 calibration instruments, write the cell file; returns the degraded count. */
async function writeRun(
  args: { prompt: "v2" | "v3"; out: string },
  meta: Record<string, unknown>,
  items: Items,
  rows: Rows,
): Promise<number> {
  const [metrics, calibration] = await Promise.all([
    import("../src/eval-v3/metrics.js"),
    import("../src/eval-v3/calibration.js"),
  ]);
  const summary = metrics.summarizeRun(rows, tap.calls);
  const scored = rows.map((r, i) => ({
    email: items[i],
    truth: r.truth,
    predicted: r.predicted,
    source: r.source,
    features: r.features ?? { confidence: 0, senderTrust: 0, reversibility: 0, urgency: 0 },
  }));
  const extra =
    args.prompt === "v2"
      ? {
          calibration: calibration.urgentCalibration(scored),
          counterfactual: calibration.CONFIDENCE_VARIANTS.map((v) =>
            calibration.counterfactual(scored, v),
          ),
        }
      : {};
  const out = { meta, summary, ...extra, calls: tap.calls, rows };
  writeFileSync(resolve(args.out), JSON.stringify(out, null, 2), "utf8");
  const r = (x: { hit: number; n: number }) => `${x.hit}/${x.n}`;
  console.log(
    `overall ${r(summary.overall)} · PUSH ${r(summary.pushRecall)} · SILENT prec ${r(summary.silentPrecision)} · MEETING ${r(summary.meetingRecall)} · INFO ${r(summary.infoRecall)} · evidence ${r(summary.evidence)} · $${summary.costUsd.toFixed(4)} · p50 ${summary.p50Ms === null ? "—" : Math.round(summary.p50Ms)}ms · degraded ${summary.degraded}`,
  );
  console.log(`wrote ${resolve(args.out)}`);
  return summary.degraded;
}

main().catch(async (err) => {
  const { describeErrorChain } = await import("../src/llm/model-fallback.js");
  console.error(describeErrorChain(err));
  process.exit(1);
});
