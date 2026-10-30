/**
 * The judge gate must recognise a gate-failing Claude model however it is
 * spelled, and must look at the model that ACTUALLY serves the judge.
 *
 * Two holes the native Anthropic provider would otherwise open:
 *  1. Spelling. The failing list is keyed by OpenRouter ids
 *     (`anthropic/claude-sonnet-5`). The native provider takes native ids
 *     (`claude-sonnet-5`), which would not match — JUDGE_MODEL=claude-sonnet-5
 *     would run the very model that took PUSH to zero for three weeks, silently.
 *  2. Substitution by the provider. A non-OpenRouter provider leading the chain
 *     serves a pin it cannot route with its OWN default (Gemini does this;
 *     Anthropic does too, via ANTHROPIC_MODEL). The boot check on JUDGE_MODEL
 *     alone would then validate a model that never runs.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  judgeModelVerdict,
  normalizeModelId,
  reportJudgeServing,
  servedJudgeModel,
} from "../llm/judge-model-gate.js";

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

describe("normalizeModelId — Claude spellings", () => {
  it.each([
    ["claude-sonnet-5", "anthropic/claude-sonnet-5"],
    ["claude-opus-4-8", "anthropic/claude-opus-4.8"],
    ["claude-haiku-4-5-20251001", "anthropic/claude-haiku-4.5"],
    ["claude-sonnet-4-20250514", "anthropic/claude-sonnet-4"],
    ["Anthropic/Claude-Haiku-5-5", "anthropic/claude-haiku-5.5"],
    ["anthropic/claude-haiku-5.5:beta", "anthropic/claude-haiku-5.5"],
  ])("%s → %s", (raw, canonical) => {
    expect(normalizeModelId(raw)).toBe(canonical);
  });

  it("leaves non-Claude ids as before", () => {
    expect(normalizeModelId("google/gemini-2.5-flash")).toBe("google/gemini-2.5-flash");
    expect(normalizeModelId("qwen3:8b")).toBe("qwen3");
  });

  it("flags a native spelling of a gate-failing model", () => {
    expect(judgeModelVerdict("claude-sonnet-5").status).toBe("failed-gate");
    expect(judgeModelVerdict("claude-opus-4-8").status).toBe("failed-gate");
  });
});

describe("servedJudgeModel", () => {
  const anthropicHead = {
    name: "anthropic",
    resolveModel: (m: string) => (m.startsWith("claude-") ? m : "claude-haiku-5-5"),
  };

  it("is the pin itself when OpenRouter leads (it routes the caller's id as-is)", () => {
    expect(
      servedJudgeModel("google/gemini-2.5-flash", { name: "openrouter", resolveModel: () => "x" }),
    ).toBe("google/gemini-2.5-flash");
    expect(servedJudgeModel("google/gemini-2.5-flash", undefined)).toBe("google/gemini-2.5-flash");
  });

  it("is what the leading provider resolves the pin to otherwise", () => {
    expect(servedJudgeModel("google/gemini-2.5-flash", anthropicHead)).toBe("claude-haiku-5-5");
    expect(servedJudgeModel("claude-sonnet-5-5", anthropicHead)).toBe("claude-sonnet-5-5");
  });
});

describe("reportJudgeServing (every provider in the chain)", () => {
  const anthropic = (served: string) => ({ name: "anthropic", resolveModel: () => served });
  const openrouter = { name: "openrouter", resolveModel: (m: string) => m };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function spies() {
    return {
      log: vi.spyOn(console, "log").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
  }

  it("warns when the LEADING provider swaps the pin for a model the eval never measured", () => {
    const { warn, error } = spies();
    reportJudgeServing("google/gemini-2.5-flash", [anthropic("claude-haiku-9-9")]);
    expect(warn.mock.calls.join(" ")).toMatch(/anthropic.*claude-haiku-9-9.*not measured/);
    expect(error).not.toHaveBeenCalled();
  });

  it("is loud about a gate-failing model on a FAILOVER lane, not just the head", () => {
    const { error } = spies();
    reportJudgeServing("google/gemini-2.5-flash", [openrouter, anthropic("claude-sonnet-5")]);
    expect(error.mock.calls.join(" ")).toMatch(/claude-sonnet-5.*fails the gate/);
  });

  it("only notes an unmeasured swap on a failover lane", () => {
    const { log, warn, error } = spies();
    reportJudgeServing("google/gemini-2.5-flash", [openrouter, anthropic("claude-haiku-9-9")]);
    expect(log.mock.calls.join(" ")).toMatch(/failover.*claude-haiku-9-9/);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("stays silent when every provider serves the pin as configured", () => {
    const { log, warn, error } = spies();
    reportJudgeServing("google/gemini-2.5-flash", [openrouter]);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("never throws", () => {
    spies();
    expect(() =>
      reportJudgeServing("x", [
        {
          name: "anthropic",
          resolveModel: () => {
            throw new Error("boom");
          },
        },
      ]),
    ).not.toThrow();
  });
});

describe("Claude Haiku 5.5 is a measured, gate-passing judge (eval/README.md, 2026-10-30)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes the gate under either spelling", () => {
    expect(judgeModelVerdict("claude-haiku-5-5").status).toBe("passed-gate");
    expect(judgeModelVerdict("anthropic/claude-haiku-5.5").status).toBe("passed-gate");
  });

  it("does not warn when Anthropic leads and serves the gemini pin with Haiku 5.5", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    reportJudgeServing("google/gemini-2.5-flash", [
      { name: "anthropic", resolveModel: () => "claude-haiku-5-5" },
    ]);
    expect(log.mock.calls.join(" ")).toMatch(/claude-haiku-5-5/);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
