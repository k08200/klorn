import { describe, expect, it, vi } from "vitest";
import {
  GATE_FAILING_JUDGE_MODELS,
  gateFailureMessage,
  judgeModelVerdict,
  normalizeModelId,
  RECOMMENDED_JUDGE_MODEL,
  warnIfJudgeModelFailsGate,
} from "../llm/judge-model-gate.js";

describe("judge model gate guard", () => {
  describe("normalizeModelId", () => {
    it("strips the OpenRouter variant suffix so :free and :beta cannot slip past", () => {
      expect(normalizeModelId("anthropic/claude-sonnet-5:beta")).toBe("anthropic/claude-sonnet-5");
      expect(normalizeModelId("anthropic/claude-sonnet-5:free")).toBe("anthropic/claude-sonnet-5");
    });

    it("normalizes case and surrounding whitespace from hand-typed env vars", () => {
      expect(normalizeModelId("  Anthropic/Claude-Sonnet-5  ")).toBe("anthropic/claude-sonnet-5");
    });
  });

  describe("judgeModelVerdict", () => {
    it("flags the model that took PUSH to zero in production", () => {
      const verdict = judgeModelVerdict("anthropic/claude-sonnet-5");
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
      const verdict = judgeModelVerdict("ollama/llama-4-8b");
      expect(verdict.status).toBe("not-measured");
    });

    it("does not warn about a model that merely shares a vendor with a failing one", () => {
      expect(judgeModelVerdict("anthropic/claude-haiku-4.5").status).toBe("not-measured");
    });
  });

  describe("gateFailureMessage", () => {
    it("names the effect and the fix, not just the failure", () => {
      const result = GATE_FAILING_JUDGE_MODELS["anthropic/claude-sonnet-5"];
      if (!result) throw new Error("fixture missing");
      const message = gateFailureMessage("anthropic/claude-sonnet-5", result);
      expect(message).toContain("PUSH goes to zero");
      expect(message).toContain(`JUDGE_MODEL=${RECOMMENDED_JUDGE_MODEL}`);
      expect(message).toContain("pnpm eval:judge");
    });
  });

  describe("warnIfJudgeModelFailsGate", () => {
    it("writes to stderr when the pinned model fails the gate", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const verdict = warnIfJudgeModelFailsGate("anthropic/claude-sonnet-5");
        expect(verdict.status).toBe("failed-gate");
        expect(spy).toHaveBeenCalledTimes(1);
        expect(String(spy.mock.calls[0]?.[0])).toContain("[JUDGE-MODEL]");
      } finally {
        spy.mockRestore();
      }
    });

    it("stays silent for a passing pin", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(warnIfJudgeModelFailsGate(RECOMMENDED_JUDGE_MODEL).status).toBe("passed-gate");
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it("stays silent for an unmeasured pin — a self-hoster on a local model is not an error", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(warnIfJudgeModelFailsGate("ollama/llama-4-8b").status).toBe("not-measured");
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it("never throws, whatever it is handed — a guard must not be able to kill the boot", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(() => warnIfJudgeModelFailsGate("")).not.toThrow();
        expect(() => warnIfJudgeModelFailsGate(undefined as unknown as string)).not.toThrow();
      } finally {
        spy.mockRestore();
      }
    });
  });
});
