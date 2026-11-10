/**
 * Sender pin ("this sender is ALWAYS this lane") — the PIN_TIER rule must
 * outrank EVERY other signal in the judge cascade (it is enforced, not
 * predicted), and the context fetch must match by exact address only.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const createCompletionMock = vi.hoisted(() => vi.fn());

vi.mock("../llm/openai.js", () => ({
  createCompletion: createCompletionMock,
  MODEL: "test-model",
  JUDGE_MODEL: "test-judge-model",
}));

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { EMPTY_JUDGE_CONTEXT, type JudgeContext, judgeEmails } from "../judge/poc-judge.js";

function email(from: string) {
  return {
    id: "mail-1",
    from,
    subject: "URGENT: production is down, need you NOW",
    snippet: "Please respond immediately.",
    body: null,
    labels: [],
  };
}

beforeEach(() => {
  createCompletionMock.mockReset();
  createCompletionMock.mockRejectedValue(new Error("provider down"));
});

describe("pinned-rule cascade rank", () => {
  it("pin wins over sender-prior and content signals", async () => {
    const context: JudgeContext = {
      ...EMPTY_JUDGE_CONTEXT,
      pinnedTier: "SILENT",
      // A strong opposing prior that would normally short-circuit to PUSH.
      senderPrior: { tier: "PUSH", count: 9, kind: "override" },
    };

    const [judgement] = await judgeEmails([email("boss@acme.com")], {
      contextFor: () => context,
    });

    expect(judgement.tier).toBe("SILENT");
    expect(judgement.source).toBe("pinned-rule");
    expect(judgement.reason).toContain("Pinned");
    // Enforced, never predicted: the LLM must not even be consulted.
    expect(createCompletionMock).not.toHaveBeenCalled();
  });

  it("without a pin the same context behaves as before", async () => {
    const context: JudgeContext = {
      ...EMPTY_JUDGE_CONTEXT,
      senderPrior: { tier: "PUSH", count: 9, kind: "override" },
    };

    const [judgement] = await judgeEmails([email("boss@acme.com")], {
      contextFor: () => context,
    });

    expect(judgement.tier).toBe("PUSH");
    expect(judgement.source).not.toBe("pinned-rule");
  });
});
