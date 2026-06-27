/**
 * judgeEmail must thread JudgeContext.senderTraits all the way into the LLM
 * user prompt. buildSenderTraitsBlock is unit-tested separately; this locks the
 * WIRING — a dropped positional arg anywhere in judgeEmail → extractWithDial →
 * extractFeaturesWithLlm → buildJudgePrompt would still type-check, so only an
 * end-to-end prompt assertion catches it. createCompletion is mocked to a
 * confident score and its prompt is captured.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const createCompletionMock = vi.hoisted(() => vi.fn());

vi.mock("../openai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../openai.js")>();
  return { ...actual, createCompletion: createCompletionMock };
});

import { type JudgeContext, judgeEmail } from "../poc-judge.js";

const CONFIDENT_SCORE = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          confidence: 0.9,
          senderTrust: 0.8,
          reversibility: 0.5,
          urgency: 0.2,
          reason: "known investor",
        }),
      },
    },
  ],
};

const EMAIL = {
  id: "e1",
  from: "Alice <alice@vc.com>",
  subject: "Following up on the round",
  snippet: "Are you raising?",
  labels: [],
};

function userPrompts(): string[] {
  return createCompletionMock.mock.calls.map((c) => c[0]?.messages?.[1]?.content as string);
}

beforeEach(() => {
  createCompletionMock.mockReset();
  createCompletionMock.mockResolvedValue(CONFIDENT_SCORE);
});

describe("judgeEmail — sender-trait threading", () => {
  it("renders JudgeContext.senderTraits into the LLM user prompt", async () => {
    const context: JudgeContext = {
      corrections: [],
      senderPrior: null,
      senderFacts: null,
      senderTraits: [
        {
          factKind: "relationship",
          factValue: "investor",
          confidence: 0.9,
          evidenceText: "We'd like to invest in your round.",
        },
      ],
    };

    const result = await judgeEmail(EMAIL, "u1", context);

    expect(result.source).toBe("llm");
    expect(createCompletionMock).toHaveBeenCalled();
    const prompts = userPrompts();
    expect(prompts.some((p) => p.includes("Observed profile for this sender"))).toBe(true);
    expect(
      prompts.some((p) =>
        p.includes('- Relationship: investor — "We\'d like to invest in your round."'),
      ),
    ).toBe(true);
  });

  it("omits the trait block when senderTraits is empty (prompt unchanged)", async () => {
    const result = await judgeEmail(EMAIL, "u1", {
      corrections: [],
      senderPrior: null,
      senderFacts: null,
      senderTraits: [],
    });

    expect(result.source).toBe("llm");
    expect(userPrompts().every((p) => !p.includes("Observed profile for this sender"))).toBe(true);
  });
});
