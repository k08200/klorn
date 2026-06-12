/**
 * Correction-loop behaviour of judgeEmail: sender-prior short-circuit and
 * few-shot injection. The LLM is mocked at the openai.js boundary.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const createCompletionMock = vi.hoisted(() => vi.fn());

vi.mock("../openai.js", () => ({
  createCompletion: createCompletionMock,
  MODEL: "test-model",
}));

vi.mock("../sentry.js", () => ({
  captureError: vi.fn(),
}));

import { type JudgeContext, judgeEmail } from "../poc-judge.js";

const PLAIN_EMAIL = {
  from: "Acme Updates <updates@acme.example>",
  subject: "Changelog for June",
  snippet: "What shipped this month",
  labels: [],
};

function ctx(partial: Partial<JudgeContext>): JudgeContext {
  return { corrections: [], senderPrior: null, ...partial };
}

beforeEach(() => {
  createCompletionMock.mockReset();
  createCompletionMock.mockRejectedValue(new Error("LLM should not be called"));
});

describe("sender-prior short-circuit", () => {
  it("skips the LLM when a history prior says QUEUE", async () => {
    const result = await judgeEmail(
      PLAIN_EMAIL,
      undefined,
      ctx({ senderPrior: { tier: "QUEUE", count: 4, kind: "history" } }),
    );
    expect(result.tier).toBe("QUEUE");
    expect(result.source).toBe("sender-prior");
    expect(result.reason).toContain("4 consistent past classifications");
    expect(createCompletionMock).not.toHaveBeenCalled();
  });

  it("skips the LLM when an override prior says PUSH — even with urgent content", async () => {
    const result = await judgeEmail(
      { ...PLAIN_EMAIL, subject: "URGENT: server down today" },
      undefined,
      ctx({ senderPrior: { tier: "PUSH", count: 2, kind: "override" } }),
    );
    expect(result.tier).toBe("PUSH");
    expect(result.source).toBe("sender-prior");
    expect(createCompletionMock).not.toHaveBeenCalled();
  });

  it("sends urgent-looking mail to the LLM even when the prior says SILENT", async () => {
    createCompletionMock.mockRejectedValue(new Error("provider down"));
    const result = await judgeEmail(
      { ...PLAIN_EMAIL, subject: "Deadline today: account action required" },
      undefined,
      ctx({ senderPrior: { tier: "SILENT", count: 5, kind: "history" } }),
    );
    // Urgency guard bypassed the short-circuit; LLM was attempted (and fell
    // back to keywords since it's down).
    expect(result.source).toBe("keyword-fallback");
    expect(createCompletionMock).toHaveBeenCalled();
  });

  it("never short-circuits history priors to PUSH (urgency is content-dependent)", async () => {
    createCompletionMock.mockRejectedValue(new Error("provider down"));
    const result = await judgeEmail(
      PLAIN_EMAIL,
      undefined,
      ctx({ senderPrior: { tier: "PUSH", count: 5, kind: "history" } }),
    );
    expect(result.source).toBe("keyword-fallback");
  });

  it("never short-circuits to AUTO", async () => {
    createCompletionMock.mockRejectedValue(new Error("provider down"));
    const result = await judgeEmail(
      PLAIN_EMAIL,
      undefined,
      ctx({ senderPrior: { tier: "AUTO", count: 3, kind: "override" } }),
    );
    expect(result.source).toBe("keyword-fallback");
  });

  it("fast-path marketing still wins over a sender prior", async () => {
    const result = await judgeEmail(
      { ...PLAIN_EMAIL, labels: ["CATEGORY_PROMOTIONS"] },
      undefined,
      ctx({ senderPrior: { tier: "QUEUE", count: 4, kind: "history" } }),
    );
    expect(result.tier).toBe("SILENT");
    expect(result.source).toBe("fast-path");
  });
});

describe("few-shot correction injection", () => {
  function llmRespondsWith(features: Record<string, number | string>) {
    createCompletionMock.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(features) } }],
    });
  }

  function sentPrompt(): string {
    const call = createCompletionMock.mock.calls[0]?.[0];
    return call?.messages?.find((m: { role: string }) => m.role === "user")?.content ?? "";
  }

  it("renders past corrections into the judge prompt", async () => {
    llmRespondsWith({ confidence: 0.6, senderTrust: 0.5, reversibility: 0.5, urgency: 0.3 });
    await judgeEmail(
      PLAIN_EMAIL,
      undefined,
      ctx({
        corrections: [
          {
            from: "Acme Updates <updates@acme.example>",
            subject: "Changelog for May",
            tier: "SILENT",
          },
        ],
      }),
    );
    const prompt = sentPrompt();
    expect(prompt).toContain("manually corrected");
    expect(prompt).toContain("Changelog for May → SILENT");
  });

  it("caps the prompt at 5 examples", async () => {
    llmRespondsWith({ confidence: 0.6, senderTrust: 0.5, reversibility: 0.5, urgency: 0.3 });
    const corrections = Array.from({ length: 9 }, (_, i) => ({
      from: `Sender ${i} <s${i}@x.example>`,
      subject: `subject-${i}`,
      tier: "QUEUE" as const,
    }));
    await judgeEmail(PLAIN_EMAIL, undefined, ctx({ corrections }));
    const prompt = sentPrompt();
    const exampleLines = prompt.split("\n").filter((l) => l.startsWith("- from:"));
    expect(exampleLines).toHaveLength(5);
  });

  it("omits the corrections block entirely when there are none", async () => {
    llmRespondsWith({ confidence: 0.6, senderTrust: 0.5, reversibility: 0.5, urgency: 0.3 });
    await judgeEmail(PLAIN_EMAIL, undefined, ctx({}));
    expect(sentPrompt()).not.toContain("manually corrected");
  });
});

describe("sender-facts grounding", () => {
  function llmRespondsWith(features: Record<string, number | string>) {
    createCompletionMock.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(features) } }],
    });
  }

  function sentPrompt(): string {
    const call = createCompletionMock.mock.calls[0]?.[0];
    return call?.messages?.find((m: { role: string }) => m.role === "user")?.content ?? "";
  }

  const FULL_FACTS = {
    tierHistory: { QUEUE: 6, SILENT: 3 },
    manualOverrides: 2,
    interaction: { emailCount: 14, lastEmailDaysAgo: 2, upcomingMeetings: 1 },
    commitments: { onTime: 4, total: 5 },
  };

  it("renders observed sender facts into the judge prompt", async () => {
    llmRespondsWith({ confidence: 0.6, senderTrust: 0.5, reversibility: 0.5, urgency: 0.3 });
    await judgeEmail(PLAIN_EMAIL, undefined, ctx({ senderFacts: FULL_FACTS }));
    const prompt = sentPrompt();
    expect(prompt).toContain("Known history for this sender");
    expect(prompt).toContain("QUEUE×6, SILENT×3");
    expect(prompt).toContain("2 were manual corrections");
    expect(prompt).toContain("14 emails");
    expect(prompt).toContain("kept 4 of 5 on time");
  });

  it("omits the block entirely when senderFacts is absent", async () => {
    llmRespondsWith({ confidence: 0.6, senderTrust: 0.5, reversibility: 0.5, urgency: 0.3 });
    await judgeEmail(PLAIN_EMAIL, undefined, ctx({}));
    expect(sentPrompt()).not.toContain("Known history for this sender");
  });

  it("renders partial facts without the missing lines", async () => {
    llmRespondsWith({ confidence: 0.6, senderTrust: 0.5, reversibility: 0.5, urgency: 0.3 });
    await judgeEmail(
      PLAIN_EMAIL,
      undefined,
      ctx({
        senderFacts: {
          tierHistory: { SILENT: 4 },
          manualOverrides: 0,
          interaction: null,
          commitments: null,
        },
      }),
    );
    const prompt = sentPrompt();
    expect(prompt).toContain("SILENT×4");
    expect(prompt).not.toContain("manual corrections");
    expect(prompt).not.toContain("Active correspondent");
    expect(prompt).not.toContain("Commitment track record");
  });
});
