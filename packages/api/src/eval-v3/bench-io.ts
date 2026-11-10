/**
 * Arguments, guards and item loading for scripts/v3-bench.ts. Kept in src/ so
 * it is typechecked and tested; the script stays a thin shell around it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fixtureToJudgeContext } from "../eval-context.js";
import type { JudgeContext } from "../judge/poc-judge.js";
import { TIERS, type Tier } from "../judge/tiers.js";
import type { CallRecord } from "./call-tap.js";
import { frontOnlyContext } from "./front.js";
import type { EvalItem } from "./runner.js";

const MAX_CONCURRENCY = 8;
const MAX_DELAY_MS = 60_000;

export type ContextMode = "fixture" | "empty" | "front";

export interface BenchArgs {
  in: string;
  model: string;
  prompt: "v2" | "v3";
  run: number;
  out: string;
  concurrency: number;
  delayMs: number;
  offset: number;
  limit?: number;
  context: ContextMode;
}

function intArg(
  map: Map<string, string>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = map.get(key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`--${key} must be an integer in [${min}, ${max}], got ${JSON.stringify(raw)}`);
  }
  return n;
}

export function parseBenchArgs(argv: readonly string[]): BenchArgs {
  const map = new Map(
    argv
      .map((a) => a.match(/^--([\w-]+)=(.*)$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => [m[1], m[2]] as const),
  );
  const need = (k: string) => {
    const v = map.get(k);
    if (!v) throw new Error(`--${k} is required`);
    return v;
  };
  const prompt = need("prompt");
  if (prompt !== "v2" && prompt !== "v3") throw new Error("--prompt must be v2 or v3");
  const context = map.get("context") ?? "fixture";
  if (context !== "fixture" && context !== "empty" && context !== "front") {
    throw new Error("--context must be fixture, empty or front");
  }
  return {
    in: need("in"),
    model: need("model"),
    prompt,
    out: need("out"),
    run: intArg(map, "run", 1, 0, 1000),
    concurrency: intArg(map, "concurrency", 2, 1, MAX_CONCURRENCY),
    delayMs: intArg(map, "delay", 300, 0, MAX_DELAY_MS),
    offset: intArg(map, "offset", 0, 0, 100_000),
    limit: map.has("limit") ? intArg(map, "limit", 0, 1, 100_000) : undefined,
    context,
  };
}

/**
 * Refuse to run where an LLM call could touch a real database: the cost guard
 * and the usage log both write through Prisma unless these are set.
 */
export function assertEvalEnv(env: Record<string, string | undefined>): void {
  const localDb = /^postgres(?:ql)?:\/\/[^@]*@(?:localhost|127\.0\.0\.1)[:/]/;
  const problems = [
    env.LLM_USAGE_LOG_DISABLED === "true" ? null : "LLM_USAGE_LOG_DISABLED=true",
    env.GLOBAL_DAILY_COST_CAP_CENTS === "0" ? null : "GLOBAL_DAILY_COST_CAP_CENTS=0",
    localDb.test(env.DATABASE_URL ?? "") ? null : "DATABASE_URL pointing at localhost",
  ].filter((p): p is string => p !== null);
  if (problems.length > 0) {
    throw new Error(
      `unsafe eval env: set ${problems.join(", ")} (the bench must never reach a real DB)`,
    );
  }
}

/** Only the committed eval sets, never a real-mail export. */
export function assertEvalSet(path: string, evalDir: string): string {
  const abs = resolve(path);
  if (!abs.startsWith(`${evalDir}/`) || !abs.endsWith(".json")) {
    throw new Error(`--in must be a committed eval set under ${evalDir}/*.json`);
  }
  return abs;
}

/** Successful calls answered by a model other than the one asked for (a silent failover). */
export function countServedByOther(calls: readonly CallRecord[], model: string): number {
  const asked = model.replace(/^[^/]+\//, "");
  return calls.filter((c) => c.status >= 200 && c.status < 300 && !c.model.includes(asked)).length;
}

interface RawItem {
  id: string;
  from: string;
  subject: string;
  snippet: string | null;
  body?: string | null;
  labels?: string[];
  receivedAt: string;
  label: string | null;
  labelV2?: string;
  context?: unknown;
}

export interface LoadedItem extends EvalItem {
  context: JudgeContext;
}

function contextFor(raw: RawItem, mode: ContextMode): JudgeContext {
  if (mode === "empty") return fixtureToJudgeContext(null, raw.id);
  const full = fixtureToJudgeContext(raw.context, raw.id);
  return mode === "front" ? frontOnlyContext(full) : full;
}

export function loadEvalItems(
  path: string,
  opts: { context: ContextMode; offset: number; limit: number | undefined; useLabelV2: boolean },
): LoadedItem[] {
  const file = JSON.parse(readFileSync(path, "utf8")) as { items: RawItem[] };
  const end = opts.limit === undefined ? undefined : opts.offset + opts.limit;
  return file.items
    .map((raw) => ({
      raw,
      truth: (opts.useLabelV2 && raw.labelV2 ? raw.labelV2 : raw.label) as Tier | null,
    }))
    .filter((x): x is { raw: RawItem; truth: Tier } => x.truth !== null && TIERS.includes(x.truth))
    .slice(opts.offset, end)
    .map(({ raw, truth }) => ({
      id: raw.id,
      from: raw.from,
      subject: raw.subject,
      snippet: raw.snippet,
      body: raw.body ?? null,
      labels: raw.labels ?? [],
      receivedAt: raw.receivedAt,
      truth,
      context: contextFor(raw, opts.context),
    }));
}
