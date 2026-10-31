import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertEvalEnv,
  assertEvalSet,
  countServedByOther,
  loadEvalItems,
  parseBenchArgs,
} from "../eval-v3/bench-io.js";
import type { CallRecord } from "../eval-v3/call-tap.js";

const SAFE_ENV = {
  LLM_USAGE_LOG_DISABLED: "true",
  GLOBAL_DAILY_COST_CAP_CENTS: "0",
  DATABASE_URL: "postgresql://eval:eval@localhost:5432/eval",
};

describe("parseBenchArgs", () => {
  const base = ["--in=eval/judge-eval-set.json", "--model=m", "--prompt=v3", "--out=/tmp/x.json"];

  it("parses a full command with defaults", () => {
    expect(parseBenchArgs(base)).toMatchObject({
      prompt: "v3",
      run: 1,
      concurrency: 2,
      delayMs: 300,
      offset: 0,
      limit: undefined,
      context: "fixture",
    });
  });

  it("rejects non-numeric or out-of-range numbers instead of running zero workers", () => {
    expect(() => parseBenchArgs([...base, "--concurrency=abc"])).toThrow(/concurrency/);
    expect(() => parseBenchArgs([...base, "--concurrency=0"])).toThrow(/concurrency/);
    expect(() => parseBenchArgs([...base, "--limit=-1"])).toThrow(/limit/);
  });

  it("accepts the front-only context mode and rejects unknown ones", () => {
    expect(parseBenchArgs([...base, "--context=front"]).context).toBe("front");
    expect(() => parseBenchArgs([...base, "--context=db"])).toThrow(/context/);
    expect(() => parseBenchArgs([...base.slice(1)])).toThrow(/--in/);
  });
});

describe("eval guards", () => {
  it("refuses an env where an LLM call could write to a real database", () => {
    expect(() => assertEvalEnv(SAFE_ENV)).not.toThrow();
    expect(() => assertEvalEnv({ ...SAFE_ENV, LLM_USAGE_LOG_DISABLED: undefined })).toThrow(
      /LLM_USAGE_LOG_DISABLED/,
    );
    expect(() =>
      assertEvalEnv({ ...SAFE_ENV, DATABASE_URL: "postgresql://u:p@db.supabase.co:5432/postgres" }),
    ).toThrow(/DATABASE_URL/);
  });

  it("only accepts committed eval sets", () => {
    const evalDir = resolve("eval");
    expect(assertEvalSet("eval/judge-eval-set.json", evalDir)).toBe(
      resolve("eval/judge-eval-set.json"),
    );
    expect(() => assertEvalSet("../../poc-ground-truth.json", evalDir)).toThrow(/eval set/);
    expect(() => assertEvalSet("eval/README.md", evalDir)).toThrow(/eval set/);
  });
});

describe("countServedByOther", () => {
  const call = (model: string, status = 200): CallRecord => ({
    model,
    status,
    ms: 1,
    promptTokens: 1,
    completionTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });

  it("counts only successful calls answered by a different model", () => {
    const calls = [
      call("claude-haiku-5-5"),
      call("unknown", 429), // a retried rate limit is not another model
      call("google/gemini-2.5-flash"),
    ];
    expect(countServedByOther(calls, "claude-haiku-5-5")).toBe(1);
    expect(countServedByOther([call("google/gemini-4-argon")], "google/gemini-4-argon")).toBe(0);
  });
});

describe("loadEvalItems", () => {
  it("strips v2's prompt context in front mode but keeps what the front reads", () => {
    const opts = { offset: 0, limit: undefined, useLabelV2: true };
    const fixture = loadEvalItems(resolve("eval/real-eval-set.json"), {
      ...opts,
      context: "fixture",
    });
    const front = loadEvalItems(resolve("eval/real-eval-set.json"), { ...opts, context: "front" });
    const withFacts = fixture.filter((i) => i.context.senderFacts).length;
    expect(withFacts).toBeGreaterThan(40);
    expect(front.filter((i) => i.context.senderFacts).length).toBe(0);
    expect(front.filter((i) => i.context.senderPrior).length).toBe(
      fixture.filter((i) => i.context.senderPrior).length,
    );
  });

  it("uses labelV2 when the ontology flag is on and honours offset/limit", () => {
    const items = loadEvalItems(resolve("eval/real-eval-set.json"), {
      context: "empty",
      offset: 0,
      limit: undefined,
      useLabelV2: true,
    });
    expect(items.filter((i) => i.truth === "INFO")).toHaveLength(4);
    const slice = loadEvalItems(resolve("eval/judge-eval-set.json"), {
      context: "empty",
      offset: 28,
      limit: 3,
      useLabelV2: true,
    });
    expect(slice.map((i) => i.id)).toEqual(["eval-029", "eval-030", "eval-031"]);
  });
});
