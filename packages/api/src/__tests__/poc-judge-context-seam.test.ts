/**
 * judgeEmails per-item context seam (#650).
 *
 * The offline eval routes each item's JudgeContext through this seam, so it
 * must (a) feed the exact context to the exact item, and (b) leave behavior
 * byte-identical when absent (default = EMPTY_JUDGE_CONTEXT, as before).
 * The LLM is mocked down at the llm/openai.js boundary — every assertion
 * below is about the deterministic paths (sender-prior, learned-rule,
 * fallback). The fallback tests assert the mock WAS called: if this path
 * ever drifts from poc-judge's real import again (as after the #812 module
 * move), the suite must fail loudly instead of silently hitting a live
 * provider on machines where Prisma's .env auto-load supplies an API key.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const createCompletionMock = vi.hoisted(() => vi.fn());

vi.mock("../llm/openai.js", () => ({
  createCompletion: createCompletionMock,
  MODEL: "test-model",
  JUDGE_MODEL: "test-judge-model",
}));

vi.mock("../sentry.js", () => ({
  captureError: vi.fn(),
}));

import { EMPTY_JUDGE_CONTEXT, type JudgeContext, judgeEmails } from "../judge/poc-judge.js";

/** Neutral system email: no marketing markers, no urgency vocabulary. */
function neutralEmail(i: number) {
  return {
    id: `mail-${i}`,
    from: `builds@ci.example.com`,
    subject: `Nightly build report ${i}`,
    snippet: "All 214 checks completed.",
    body: null,
    labels: [],
  };
}

beforeEach(() => {
  createCompletionMock.mockReset();
  // LLM down → judge falls through to keyword fallback unless a context
  // short-circuits first.
  createCompletionMock.mockRejectedValue(new Error("provider down"));
});

describe("judgeEmails contextFor seam", () => {
  it("feeds the per-item context to the judge (sender-prior short-circuits)", async () => {
    const context: JudgeContext = {
      ...EMPTY_JUDGE_CONTEXT,
      senderPrior: { tier: "QUEUE", count: 3, kind: "history" },
    };

    const [judgement] = await judgeEmails([neutralEmail(0)], {
      contextFor: () => context,
    });

    expect(judgement.source).toBe("sender-prior");
    expect(judgement.tier).toBe("QUEUE");
    expect(createCompletionMock).not.toHaveBeenCalled();
  });

  it("feeds learned rules through the same seam", async () => {
    const context: JudgeContext = {
      ...EMPTY_JUDGE_CONTEXT,
      learnedRules: [{ pattern: "sender-domain", value: "ci.example.com", tier: "SILENT" }],
    };

    const [judgement] = await judgeEmails([neutralEmail(0)], {
      contextFor: () => context,
    });

    expect(judgement.source).toBe("learned-rule");
    expect(judgement.tier).toBe("SILENT");
  });

  it("maps contexts to items by index, not completion order", async () => {
    const emails = [0, 1, 2, 3].map(neutralEmail);
    const seen: Array<{ id: string; index: number }> = [];

    const judgements = await judgeEmails(emails, {
      concurrency: 3,
      contextFor: (email, index) => {
        seen.push({ id: email.id, index });
        // Give only item 2 a short-circuiting prior; the rest stay empty.
        return index === 2
          ? { ...EMPTY_JUDGE_CONTEXT, senderPrior: { tier: "QUEUE", count: 3, kind: "history" } }
          : EMPTY_JUDGE_CONTEXT;
      },
    });

    expect(seen).toHaveLength(4);
    for (const { id, index } of seen) {
      expect(id).toBe(`mail-${index}`);
    }
    expect(judgements[2].source).toBe("sender-prior");
    expect(judgements[0].source).toBe("keyword-fallback");
    expect(judgements[1].source).toBe("keyword-fallback");
    expect(judgements[3].source).toBe("keyword-fallback");
    // The empty-context items reached the (mocked, down) LLM — proves the
    // mock intercepts the real boundary rather than a stale module path.
    expect(createCompletionMock).toHaveBeenCalled();
  });

  it("supports an async contextFor", async () => {
    const [judgement] = await judgeEmails([neutralEmail(0)], {
      contextFor: async () => ({
        ...EMPTY_JUDGE_CONTEXT,
        senderPrior: { tier: "QUEUE", count: 3, kind: "history" },
      }),
    });
    expect(judgement.source).toBe("sender-prior");
  });

  it("behaves exactly as before when contextFor is absent", async () => {
    const [judgement] = await judgeEmails([neutralEmail(0)], {});
    expect(judgement.source).toBe("keyword-fallback");
    expect(createCompletionMock).toHaveBeenCalled();
  });
});
