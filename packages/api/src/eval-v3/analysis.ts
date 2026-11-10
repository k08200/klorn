/**
 * Report-time analysis over stored benchmark runs. No LLM calls: every
 * number is recomputed from the saved predictions, so a relabel (or a policy
 * change, doc principle 6) re-scores the whole matrix offline.
 */
import type { ClassifiableEmail } from "../judge/email-classifier.js";
import { isAutomatedSender } from "../judge/keyword-policy.js";
import { hasSpamLabel } from "../judge/poc-judge.js";
import type { TierFeatures } from "../judge/tier-policy.js";
import type { Tier } from "../judge/tiers.js";
import { type FactsV1, parseFactsV1 } from "../judge/v3/facts-schema.js";
import { laneFromFactsV3 } from "../judge/v3/policy.js";
import { CONFIDENCE_VARIANTS, counterfactual, urgentCalibration } from "./calibration.js";
import type { CallRecord } from "./call-tap.js";
import { applyEvidenceCheck } from "./evidence.js";
import { buildFactsUserPrompt } from "./facts-prompt.js";
import { type BenchRow, summarizeRun } from "./metrics.js";
import { laneFromFacts } from "./policy.js";
import { type BenchFile, cellLabel } from "./report.js";

export interface StoredRow extends BenchRow {
  features?: TierFeatures;
  /** v3: the model's facts before evidence checks — the replay input. */
  rawFacts?: FactsV1 | null;
}

export interface StoredRun extends BenchFile {
  meta: BenchFile["meta"] & { includeBody?: boolean };
  rows: StoredRow[];
  calls: CallRecord[];
}

export type EvalEmail = ClassifiableEmail & { receivedAt?: string };

/**
 * Which lane policy a replay applies to the facts:
 *  - "doc": doc §3(4) read literally (eval-v3/policy.ts), the P1 baseline;
 *  - "p3":  P3's production policy, the live version (judge/v3/policy.ts,
 *           laneFromFactsV3; "p3-v3.0" pins v3.0 for comparison)
 *           with the inputs replay.ts gives it: no relationship data (the eval
 *           sets carry none, so every sender is unknown: the cold-start case)
 *           and `isAutomatedSender(from)` as the automated-sender signal. The
 *           shadow report also ORs an Auto-Submitted header, which the eval
 *           mails do not carry.
 * Neither path can apply production's header-based pre-fact merge
 * (`mergeWithPreFacts`: List-Unsubscribe, To/Cc, ICS) — the eval mails have
 * no headers.
 */
export type ReplayPolicy = "doc" | "p3" | "p3-v3.0";

function decideLane(
  policy: ReplayPolicy,
  facts: FactsV1,
  email: EvalEmail & { receivedAt: string },
): { lane: Tier; rule: string } {
  const receivedAt = new Date(email.receivedAt);
  const spam = hasSpamLabel(email.labels);
  if (policy === "doc") return laneFromFacts(facts, { receivedAt, spam });
  const d = laneFromFactsV3({
    facts,
    relationship: null,
    spam,
    automatedSender: isAutomatedSender(email.from ?? ""),
    decidedAt: receivedAt,
    version: policy === "p3-v3.0" ? "v3.0" : undefined,
  });
  return { lane: d.lane, rule: `${d.policyVersion}:${d.reasons[0]?.code ?? "default"}` };
}

/**
 * Re-derive a v3 lane from stored raw facts under the CURRENT production
 * contract: P2's `parseFactsV1` (text cleaning, empty-object drops, strict ISO
 * dates), P2's evidence rules, then the policy. A stored answer the production
 * parser rejects becomes "v3-unparsed" → QUEUE, as it would in production.
 */
function replayV3(
  row: StoredRow,
  email: EvalEmail | undefined,
  includeBody: boolean,
  policy: ReplayPolicy,
): StoredRow {
  if (row.source !== "v3" || !row.rawFacts || !email?.receivedAt) return row;
  const parsed = parseFactsV1(row.rawFacts);
  if (!parsed.facts) {
    return {
      ...row,
      predicted: "QUEUE",
      source: "v3-unparsed",
      rule: undefined,
      evidenceTotal: 0,
      evidenceValid: 0,
      dueUnbound: 0,
    };
  }
  const { fields } = buildFactsUserPrompt({ ...email, receivedAt: email.receivedAt }, includeBody);
  const checked = applyEvidenceCheck(parsed.facts, fields);
  const decision = decideLane(policy, checked.facts, { ...email, receivedAt: email.receivedAt });
  return {
    ...row,
    predicted: decision.lane,
    rule: decision.rule,
    evidenceTotal: checked.evidenceTotal,
    evidenceValid: checked.evidenceValid,
    dueUnbound: checked.dueUnbound,
  };
}

/**
 * Re-score a stored run against the labels in effect now; v3 rows are also
 * replayed from their raw facts. Rows whose id has no label are dropped.
 */
export function rescore(
  run: StoredRun,
  truthById: ReadonlyMap<string, Tier>,
  emailById: ReadonlyMap<string, EvalEmail>,
  policy: ReplayPolicy = "doc",
): StoredRun & { warnings: string[] } {
  const includeBody = run.meta.includeBody ?? true;
  const labelled = run.rows.filter((r) => truthById.has(r.id));
  const missingEmail = labelled.filter((r) => !emailById.has(r.id)).length;
  const unreplayable = labelled.filter(
    (r) => r.source === "v3" && (!r.rawFacts || !emailById.get(r.id)?.receivedAt),
  ).length;
  const rows = labelled.map((r) =>
    replayV3(
      { ...r, truth: truthById.get(r.id) as Tier },
      emailById.get(r.id),
      includeBody,
      policy,
    ),
  );
  const name = `${run.meta.set}/${run.meta.model}/${run.meta.prompt}/${run.meta.run}`;
  const warnings = [
    labelled.length < run.rows.length
      ? `${name}: ${run.rows.length - labelled.length} row(s) have no label now`
      : null,
    missingEmail > 0 ? `${name}: ${missingEmail} row(s) missing from the eval set` : null,
    unreplayable > 0
      ? `${name}: ${unreplayable} v3 row(s) kept their stored lane (no raw facts to replay)`
      : null,
  ].filter((w): w is string => w !== null);
  // Price over every mail the run processed, not just the rows still labelled.
  const base = { ...run, rows, summary: summarizeRun(rows, run.calls, run.rows.length), warnings };
  if (run.meta.prompt !== "v2") return base;
  const scored = rows.map((r) => ({
    email: emailById.get(r.id) ?? { from: "", subject: "" },
    truth: r.truth,
    predicted: r.predicted,
    source: r.source,
    features: r.features ?? { confidence: 0, senderTrust: 0, reversibility: 0, urgency: 0 },
  }));
  return {
    ...base,
    calibration: urgentCalibration(scored),
    counterfactual: CONFIDENCE_VARIANTS.map((v) => counterfactual(scored, v)),
  };
}

const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const pct = (x: number) => `${(x * 100).toFixed(1)}`;
const rate = (r: { hit: number; n: number }) => r.hit / Math.max(1, r.n);

interface SpreadLine {
  set: string;
  label: string;
  /** model → mean overall / PUSH recall; absent when the model has no runs for this row. */
  per: Map<string, { overall: number; push: number }>;
}

function spreadLines(runs: readonly BenchFile[]): SpreadLine[] {
  const keys = [...new Set(runs.map((r) => `${r.meta.set}|${cellLabel(r.meta)}`))].sort();
  return keys.map((key) => {
    const [set, label] = key.split("|");
    const pool = runs.filter((r) => r.meta.set === set && cellLabel(r.meta) === label);
    const models = [...new Set(pool.map((r) => r.meta.model))];
    const per = new Map(
      models.map((m) => {
        const s = pool.filter((r) => r.meta.model === m).map((r) => r.summary);
        return [
          m,
          {
            overall: mean(s.map((x) => rate(x.overall))),
            push: mean(s.map((x) => rate(x.pushRecall))),
          },
        ];
      }),
    );
    return { set, label, per };
  });
}

/**
 * Per set × prompt (and run condition): mean overall and PUSH recall per model,
 * and the max−min spread over the models that HAVE runs for that row.
 */
export function spreadTable(runs: readonly BenchFile[]): string {
  const lines = spreadLines(runs);
  if (lines.length === 0) return "";
  const models = [...new Set(runs.map((r) => r.meta.model))].sort();
  const head = `| set | prompt | ${models.map((m) => `\`${m}\` overall / PUSH %`).join(" | ")} | spread overall | spread PUSH |`;
  const sep = `|---|---|${models.map(() => "---").join("|")}|---|---|`;
  const rows = lines.map((l) => {
    const present = [...l.per.values()];
    const range = (xs: number[]) => (xs.length > 0 ? Math.max(...xs) - Math.min(...xs) : 0);
    const cells = models
      .map((m) => {
        const v = l.per.get(m);
        return v ? `${pct(v.overall)} / ${pct(v.push)}` : "—";
      })
      .join(" | ");
    const spreadO = range(present.map((p) => p.overall));
    const spreadP = range(present.map((p) => p.push));
    return `| ${l.set} | ${l.label} | ${cells} | ${pct(spreadO)}pt | ${pct(spreadP)}pt |`;
  });
  return [head, sep, ...rows].join("\n");
}

export interface ConsistentMiss {
  id: string;
  truth: Tier;
  /** Distinct (lane [rule]) predictions seen across all models and runs. */
  predicted: string[];
}

/**
 * Items missed by EVERY model in EVERY run of one set × cell label (e.g. "v3",
 * "v2 (front ctx)"): label or policy disagreements, not model noise.
 */
export function consistentMisses(
  runs: readonly StoredRun[],
  set: string,
  label: string,
): ConsistentMiss[] {
  const pool = runs.filter((r) => r.meta.set === set && cellLabel(r.meta) === label);
  if (pool.length === 0) return [];
  const ids = pool[0].rows.map((r) => r.id);
  return ids
    .map((id) => {
      const rows = pool.map((r) => r.rows.find((x) => x.id === id));
      if (rows.some((x) => !x || x.truth === x.predicted)) return null;
      const seen = rows.map((x) => `${x?.predicted}${x?.rule ? ` [${x.rule}]` : ""}`);
      return { id, truth: rows[0]?.truth as Tier, predicted: [...new Set(seen)].sort() };
    })
    .filter((m): m is ConsistentMiss => m !== null);
}
