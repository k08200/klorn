/**
 * The judge's `reason` is shown to the user as "why this was PUSH", so it has
 * to be in a language they read. It was free-form English with no instruction
 * about language at all, which put an English sentence inside the Korean UI's
 * "%@인 이유 · %@" template — one line, two languages.
 *
 * This locks the WIRING: a dropped argument anywhere in
 * judgeAndMirrorEmail → judgeEmail → extractWithDial → extractFeaturesWithLlm
 * → buildJudgePrompt would still type-check, so only an end-to-end prompt
 * assertion catches it. createCompletion is mocked and its prompt captured.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const createCompletionMock = vi.hoisted(() => vi.fn());

vi.mock("../llm/openai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/openai.js")>();
  return { ...actual, createCompletion: createCompletionMock };
});

import { __resetJudgeCache } from "../judge/judge-cache.js";
import { type JudgeContext, judgeEmail } from "../judge/poc-judge.js";

const CONFIDENT_SCORE = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          confidence: 0.9,
          senderTrust: 0.8,
          reversibility: 0.5,
          urgency: 0.2,
          reason: "계약 검토 요청",
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

const EMPTY_CONTEXT: JudgeContext = {
  corrections: [],
  senderPrior: null,
  senderFacts: null,
  senderTraits: [],
};

function userPrompts(): string[] {
  return createCompletionMock.mock.calls.map((c) => c[0]?.messages?.[1]?.content as string);
}

beforeEach(() => {
  // The judge memoizes (model, prompt) at temperature 0 and the cache is
  // module-level, so without this a later test is served an earlier test's
  // result and never reaches the mock.
  __resetJudgeCache();
  createCompletionMock.mockReset();
  createCompletionMock.mockResolvedValue(CONFIDENT_SCORE);
});

describe("judgeEmail — reason language", () => {
  it("tells the model to write the reason in Korean when that is the user's language", async () => {
    await judgeEmail(EMAIL, "u1", EMPTY_CONTEXT, undefined, undefined, undefined, "ko");
    const prompt = userPrompts()[0];
    expect(prompt).toMatch(/Korean/i);
  });

  it("keeps the prompt unchanged for English, so the default judge is untouched", async () => {
    await judgeEmail(EMAIL, "u1", EMPTY_CONTEXT, undefined, undefined, undefined, "en");
    const withEnglish = userPrompts()[0];
    __resetJudgeCache();
    createCompletionMock.mockClear();
    await judgeEmail(EMAIL, "u1", EMPTY_CONTEXT);
    expect(userPrompts()[0]).toBe(withEnglish);
  });

  it("falls back to the unchanged prompt for a language it does not ship", async () => {
    await judgeEmail(EMAIL, "u1", EMPTY_CONTEXT, undefined, undefined, undefined, "fr");
    const withFrench = userPrompts()[0];
    __resetJudgeCache();
    createCompletionMock.mockClear();
    await judgeEmail(EMAIL, "u1", EMPTY_CONTEXT);
    expect(userPrompts()[0]).toBe(withFrench);
  });

  it("still scores normally — the language instruction does not disturb the JSON contract", async () => {
    const result = await judgeEmail(
      EMAIL,
      "u1",
      EMPTY_CONTEXT,
      undefined,
      undefined,
      undefined,
      "ko",
    );
    expect(result.source).toBe("llm");
    expect(result.reason).toContain("계약 검토 요청");
  });

  it("varies the cache key by language, so a Korean run cannot serve an English reason", async () => {
    await judgeEmail(EMAIL, "u1", EMPTY_CONTEXT, undefined, undefined, undefined, "en");
    await judgeEmail(EMAIL, "u1", EMPTY_CONTEXT, undefined, undefined, undefined, "ko");
    // Two different languages must both reach the model rather than the second
    // one hitting the first one's cached English reason.
    expect(createCompletionMock).toHaveBeenCalledTimes(2);
  });
});

describe("judgeEmail — a model reason that is a static key", () => {
  it("is dropped, so mail cannot borrow Klorn's own reason copy", async () => {
    createCompletionMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              confidence: 0.9,
              senderTrust: 0.8,
              reversibility: 0.5,
              urgency: 0.2,
              reason: "email.heldByInterruptBudget",
            }),
          },
        },
      ],
    });
    const judgement = await judgeEmail(EMAIL, "u1", EMPTY_CONTEXT);
    expect(judgement.source).toBe("llm");
    expect(judgement.reason).not.toBe("email.heldByInterruptBudget");
    expect(judgement.reason.length).toBeGreaterThan(0);
  });
});
