import { describe, expect, it, vi } from "vitest";
import {
  ALLOW_GATE_FAILURE_ENV,
  gateFailureMessage,
  judgeModelVerdict,
  normalizeModelId,
  RECOMMENDED_JUDGE_MODEL,
  reportJudgeModelResolution,
  resolveJudgeModel,
} from "../llm/judge-model-gate.js";

const FAILING = "anthropic/claude-sonnet-5";

describe("judge model gate guard", () => {
  describe("normalizeModelId", () => {
    it("strips the OpenRouter variant suffix so :free and :beta cannot slip past", () => {
      expect(normalizeModelId("anthropic/claude-sonnet-5:beta")).toBe(FAILING);
      expect(normalizeModelId("anthropic/claude-sonnet-5:free")).toBe(FAILING);
    });

    it("normalizes case and surrounding whitespace from hand-typed env vars", () => {
      expect(normalizeModelId("  Anthropic/Claude-Sonnet-5  ")).toBe(FAILING);
    });
  });

  describe("judgeModelVerdict", () => {
    it("flags the model that took PUSH to zero in production", () => {
      const verdict = judgeModelVerdict(FAILING);
      expect(verdict.status).toBe("failed-gate");
      if (verdict.status !== "failed-gate") throw new Error("unreachable");
      // The mechanism is the operator's actual question: why did nothing look broken?
      expect(verdict.result.mechanism).toContain("confidence");
      expect(verdict.result.gate).toBe("0/2");
    });

    it("flags a variant-suffixed spelling of a failing model", () => {
      expect(judgeModelVerdict("anthropic/claude-sonnet-5:beta").status).toBe("failed-gate");
    });

    it("flags the other model the bake-off recorded as failing", () => {
      expect(judgeModelVerdict("anthropic/claude-opus-4.8").status).toBe("failed-gate");
    });

    it("passes the recommended pin", () => {
      expect(judgeModelVerdict(RECOMMENDED_JUDGE_MODEL).status).toBe("passed-gate");
    });

    it("reports an unmeasured model as not-measured rather than inventing a verdict", () => {
      // Most models — including every local one — were never in the bake-off.
      // Claiming anything about them would be a number we cannot re-run.
      expect(judgeModelVerdict("ollama/llama-4-8b").status).toBe("not-measured");
    });

    it("does not warn about a model that merely shares a vendor with a failing one", () => {
      expect(judgeModelVerdict("anthropic/claude-haiku-4.5").status).toBe("not-measured");
    });
  });

  describe("resolveJudgeModel", () => {
    it("refuses a gate-failing pin and runs the measured default instead", () => {
      const r = resolveJudgeModel(FAILING, {});
      expect(r.effective).toBe(RECOMMENDED_JUDGE_MODEL);
      expect(r.substituted).toBe(true);
      expect(r.overridden).toBe(false);
      expect(r.configured).toBe(FAILING);
    });

    it("refuses a variant-suffixed gate-failing pin too", () => {
      expect(resolveJudgeModel("anthropic/claude-sonnet-5:beta", {}).substituted).toBe(true);
    });

    it("keeps the pin when the operator opts in explicitly", () => {
      const r = resolveJudgeModel(FAILING, { [ALLOW_GATE_FAILURE_ENV]: "true" });
      expect(r.effective).toBe(FAILING);
      expect(r.substituted).toBe(false);
      expect(r.overridden).toBe(true);
    });

    it("treats any value other than the literal 'true' as not opting in", () => {
      // A half-set env var must not silently disable a safety check.
      for (const v of ["1", "yes", "TRUE", "", undefined]) {
        expect(resolveJudgeModel(FAILING, { [ALLOW_GATE_FAILURE_ENV]: v }).substituted).toBe(true);
      }
    });

    it("passes a good pin through untouched", () => {
      const r = resolveJudgeModel(RECOMMENDED_JUDGE_MODEL, {});
      expect(r.effective).toBe(RECOMMENDED_JUDGE_MODEL);
      expect(r.substituted).toBe(false);
      expect(r.overridden).toBe(false);
    });

    it("passes an unmeasured pin through — a self-hoster on a local model is not an error", () => {
      const r = resolveJudgeModel("ollama/llama-4-8b", {});
      expect(r.effective).toBe("ollama/llama-4-8b");
      expect(r.substituted).toBe(false);
    });
  });

  describe("gateFailureMessage", () => {
    it("names what it did, the effect, and both ways out when it substitutes", () => {
      const message = gateFailureMessage(resolveJudgeModel(FAILING, {}));
      expect(message).toContain("Declined");
      expect(message).toContain(RECOMMENDED_JUDGE_MODEL);
      expect(message).toContain("PUSH goes to zero");
      expect(message).toContain(ALLOW_GATE_FAILURE_ENV);
      expect(message).toContain("pnpm eval:judge");
    });

    it("does not claim to have substituted when the operator overrode", () => {
      const message = gateFailureMessage(
        resolveJudgeModel(FAILING, { [ALLOW_GATE_FAILURE_ENV]: "true" }),
      );
      expect(message).toContain("your explicit choice");
      expect(message).not.toContain("Declined");
    });

    it("is empty for a pin that did not fail the gate", () => {
      expect(gateFailureMessage(resolveJudgeModel(RECOMMENDED_JUDGE_MODEL, {}))).toBe("");
    });
  });

  describe("reportJudgeModelResolution", () => {
    it("writes to stderr when the configured pin failed the gate", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        reportJudgeModelResolution(resolveJudgeModel(FAILING, {}));
        expect(spy).toHaveBeenCalledTimes(1);
        expect(String(spy.mock.calls[0]?.[0])).toContain("[JUDGE-MODEL]");
      } finally {
        spy.mockRestore();
      }
    });

    it("still reports when the operator overrode — an opt-in is not a reason to go quiet", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        reportJudgeModelResolution(
          resolveJudgeModel(FAILING, { [ALLOW_GATE_FAILURE_ENV]: "true" }),
        );
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });

    it("stays silent for a passing pin", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        reportJudgeModelResolution(resolveJudgeModel(RECOMMENDED_JUDGE_MODEL, {}));
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it("stays silent for an unmeasured pin", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        reportJudgeModelResolution(resolveJudgeModel("ollama/llama-4-8b", {}));
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it("never throws, whatever it is handed — a guard must not be able to kill the boot", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(() => resolveJudgeModel("", {})).not.toThrow();
        expect(() => resolveJudgeModel(undefined as unknown as string, {})).not.toThrow();
        expect(() =>
          reportJudgeModelResolution(resolveJudgeModel(undefined as unknown as string, {})),
        ).not.toThrow();
      } finally {
        spy.mockRestore();
      }
    });
  });
});
