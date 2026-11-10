/**
 * judgeEmail must thread JudgeContext.userPriorities into the LLM user
 * prompt (judgeEmail → extractWithDial → extractFeaturesWithLlm →
 * buildJudgePrompt). A dropped positional arg type-checks, so only an
 * end-to-end prompt capture catches it — same shape as the trait test.
 * And with no priorities the prompt must be byte-identical to today's.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const createCompletionMock = vi.hoisted(() => vi.fn());

vi.mock("../llm/openai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/openai.js")>();
  return { ...actual, createCompletion: createCompletionMock };
});

import { EMPTY_JUDGE_CONTEXT, type JudgeContext, judgeEmail } from "../judge/poc-judge.js";

const CONFIDENT_SCORE = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          confidence: 0.9,
          senderTrust: 0.8,
          reversibility: 0.5,
          urgency: 0.6,
          reason: "known investor",
        }),
      },
    },
  ],
};

function userPrompts(): string[] {
  return createCompletionMock.mock.calls.map((c) => c[0]?.messages?.[1]?.content as string);
}

beforeEach(() => {
  createCompletionMock.mockReset();
  createCompletionMock.mockResolvedValue(CONFIDENT_SCORE);
});

describe("judgeEmail — user priorities threading", () => {
  it("renders the recipient's priorities into the prompt, before the untrusted email", async () => {
    const context: JudgeContext = { ...EMPTY_JUDGE_CONTEXT, userPriorities: "investor mail first" };
    const email = {
      id: "e1",
      from: "Alice <alice@vc.com>",
      subject: "Following up on the round",
      snippet: "Are you raising?",
      labels: [],
    };
    const result = await judgeEmail(email, "u1", context);
    expect(result.source).toBe("llm");
    const prompt = userPrompts()[0];
    expect(prompt).toContain("The recipient's own priorities");
    expect(prompt).toContain('"investor mail first"');
    // Standing instruction first, untrusted mail after — never the reverse.
    expect(prompt.indexOf("recipient's own priorities")).toBeLessThan(
      prompt.indexOf("Email (untrusted"),
    );
  });

  it("no priorities → the prompt is byte-identical to the empty-context prompt", async () => {
    const email = {
      id: "e2",
      from: "Bob <bob@example.com>",
      subject: "Hello",
      snippet: "Quick question",
      labels: [],
    };
    await judgeEmail(email, "u1", EMPTY_JUDGE_CONTEXT);
    await judgeEmail(email, "u1", { ...EMPTY_JUDGE_CONTEXT, userPriorities: null });
    // The judge caches by exact prompt at temperature 0: a second LLM call
    // would mean the prompt differed. One call = byte-identical prompt.
    expect(createCompletionMock).toHaveBeenCalledTimes(1);
    expect(userPrompts()[0]).not.toContain("recipient's own priorities");
  });
});
