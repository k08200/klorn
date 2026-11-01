/**
 * Fact-level labels for the founder's own mail (docs/design/attention-engine-v3.md
 * §5; consent and protocol decided 2026-10-31): two different frontier models
 * label each mail independently with the production facts extractor; every
 * disagreement and every PUSH/MEETING-relevant item goes to the founder's
 * review sheet; only reconciled labels count.
 *
 *   LLM_PROVIDER_ORDER=anthropic GLOBAL_DAILY_COST_CAP_CENTS=0 LLM_USAGE_LOG_DISABLED=true \
 *   DATABASE_URL=postgresql://eval:eval@localhost:5432/eval \
 *   npx tsx scripts/v3-label-own-mail.ts --in=eval/real-eval-set.json \
 *     --i-have-founder-consent [--models=claude-opus-5-5,claude-fable-5-1] [--limit=N]
 *
 * Output goes OUTSIDE the repo (default ~/klorn-secrets/ae3-fact-labels/<stamp>/,
 * mode 0600): labels.jsonl (both models' facts + verdict), review.md (items for
 * the founder), summary.json. Only Anthropic (a disclosed processor) is used;
 * the script refuses any other provider order.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { extractFacts, type FactsExtraction } from "../src/judge/v3/facts-extractor.js";
import { comparePair, type PairVerdict } from "../src/judge/v3/label-pair.js";

interface MailItem {
  id: string;
  from: string;
  subject: string;
  snippet?: string | null;
  body?: string | null;
  labels?: string[];
  receivedAt: string;
}

interface Args {
  input: string;
  models: [string, string];
  limit: number | null;
  outDir: string;
  concurrency: number;
}

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const DEFAULT_MODELS: [string, string] = ["claude-opus-5-5", "claude-fable-5-1"];

function parseArgs(argv: string[]): Args {
  const map = new Map<string, string>();
  for (const raw of argv) {
    const m = raw.match(/^--([\w-]+)(?:=(.+))?$/);
    if (m) map.set(m[1], m[2] ?? "true");
  }
  if (map.get("i-have-founder-consent") !== "true") {
    throw new Error("refusing: pass --i-have-founder-consent (doc §8, decided 2026-10-31)");
  }
  if (process.env.LLM_PROVIDER_ORDER?.trim() !== "anthropic") {
    throw new Error("refusing: set LLM_PROVIDER_ORDER=anthropic (disclosed processor only)");
  }
  const input = map.get("in");
  if (!input) throw new Error("--in=<mail export JSON> is required");
  const models = (map.get("models") ?? DEFAULT_MODELS.join(",")).split(",").map((s) => s.trim());
  if (models.length !== 2 || models[0] === models[1]) throw new Error("--models needs two different models");
  const outDir = resolve(
    map.get("out-dir") ?? join(homedir(), "klorn-secrets", "ae3-fact-labels", new Date().toISOString().replace(/[:.]/g, "-")),
  );
  if (!relative(REPO_ROOT, outDir).startsWith("..")) throw new Error("refusing: --out-dir must be outside the repo");
  const limit = map.has("limit") ? Number(map.get("limit")) : null;
  return { input, models: [models[0], models[1]], limit, outDir, concurrency: Number(map.get("concurrency") ?? 2) };
}

function loadItems(path: string, limit: number | null): { items: MailItem[]; userEmail: string | null } {
  const doc = JSON.parse(readFileSync(resolve(path), "utf8"));
  const items = (doc.items ?? doc) as MailItem[];
  return { items: limit ? items.slice(0, limit) : items, userEmail: doc.metadata?.userEmail ?? null };
}

async function labelOne(item: MailItem, model: string, userEmail: string | null) {
  try {
    const x = await extractFacts(
      {
        from: item.from,
        to: null,
        cc: null,
        userAddresses: userEmail ? [userEmail] : [],
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
        receivedAt: new Date(item.receivedAt),
        userTimeZone: "Asia/Seoul",
      },
      { model },
    );
    return { x, error: null as string | null };
  } catch (err) {
    return { x: null as FactsExtraction | null, error: err instanceof Error ? err.name : "Error" };
  }
}

function slim(x: FactsExtraction | null, error: string | null, requested: string) {
  return {
    requested,
    served: x?.model ?? null,
    degraded: !x || x.source !== "llm" || (x.model !== null && !x.model.startsWith(requested)),
    facts: x?.facts ?? null,
    issues: x?.issues ?? [],
    evidenceCheck: x?.evidenceCheck ?? null,
    costUsd: x?.usage?.costUsd ?? 0,
    error,
  };
}

async function mapLimit<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, n) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

function reviewMarkdown(rows: { item: MailItem; verdict: PairVerdict; a: ReturnType<typeof slim>; b: ReturnType<typeof slim> }[]) {
  const lines = ["# Fact labels for founder review", "", "Decide each item; only reconciled labels count.", ""];
  for (const { item, verdict, a, b } of rows.filter((r) => r.verdict.needsReview)) {
    lines.push(`## ${item.id} — ${item.subject.slice(0, 120)}`);
    lines.push(`from: ${item.from} · ${item.receivedAt} · why: ${verdict.reviewReasons.join(", ")}`);
    if (verdict.diffs.length) lines.push(`differs on: ${verdict.diffs.join(", ")}`);
    lines.push("```json", JSON.stringify({ [a.requested]: a.facts, [b.requested]: b.facts }, null, 2), "```", "");
  }
  return lines.join("\n");
}

function writePrivate(path: string, data: string): void {
  writeFileSync(path, data, { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const { items, userEmail } = loadItems(args.input, args.limit);
  mkdirSync(args.outDir, { recursive: true, mode: 0o700 });
  const rows = await mapLimit(items, args.concurrency, async (item) => {
    const [ra, rb] = await Promise.all(args.models.map((m) => labelOne(item, m, userEmail)));
    const a = slim(ra.x, ra.error, args.models[0]);
    const b = slim(rb.x, rb.error, args.models[1]);
    const verdict = comparePair(a.facts, b.facts, new Date(item.receivedAt));
    console.error(`[label] ${item.id} agree=${verdict.agree} review=${verdict.needsReview}`);
    return { item, a, b, verdict };
  });
  writePrivate(
    join(args.outDir, "labels.jsonl"),
    rows.map((r) => JSON.stringify({ id: r.item.id, receivedAt: r.item.receivedAt, a: r.a, b: r.b, ...r.verdict })).join("\n"),
  );
  writePrivate(join(args.outDir, "review.md"), reviewMarkdown(rows));
  const summary = {
    input: args.input,
    models: args.models,
    items: rows.length,
    agreed: rows.filter((r) => r.verdict.agree).length,
    reconciledNow: rows.filter((r) => r.verdict.reconciled).length,
    needsReview: rows.filter((r) => r.verdict.needsReview).length,
    reviewReasons: rows.flatMap((r) => r.verdict.reviewReasons).reduce<Record<string, number>>((m, k) => ({ ...m, [k]: (m[k] ?? 0) + 1 }), {}),
    diffFields: rows.flatMap((r) => r.verdict.diffs).reduce<Record<string, number>>((m, k) => ({ ...m, [k]: (m[k] ?? 0) + 1 }), {}),
    degradedCalls: rows.filter((r) => r.a.degraded).length + rows.filter((r) => r.b.degraded).length,
    costUsd: rows.reduce((s, r) => s + r.a.costUsd + r.b.costUsd, 0),
  };
  writePrivate(join(args.outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ outDir: args.outDir, ...summary }, null, 2));
  return summary.degradedCalls > 0 ? 3 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("[v3-label-own-mail] FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
