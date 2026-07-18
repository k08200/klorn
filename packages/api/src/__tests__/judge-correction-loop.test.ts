/**
 * Correction-loop behaviour of judgeEmail: sender-prior short-circuit and
 * few-shot injection. The LLM is mocked at the openai.js boundary.
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

import { __resetJudgeCache } from "../judge/judge-cache.js";
import { type JudgeContext, judgeEmail } from "../judge/poc-judge.js";

// noreply@ = clearly automated (isAutomatedSender): history priors only
// short-circuit machine senders since the #654 leak-#5 hardening.
const PLAIN_EMAIL = {
  from: "Acme Updates <noreply@acme.example>",
  subject: "Changelog for June",
  snippet: "What shipped this month",
  labels: [],
};

function ctx(partial: Partial<JudgeContext>): JudgeContext {
  return { corrections: [], senderPrior: null, ...partial };
}

beforeEach(() => {
  __resetJudgeCache();
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

  it("never short-circuits a SILENT prior — a stale prior cannot mute a sender without the LLM", async () => {
    createCompletionMock.mockRejectedValue(new Error("provider down"));
    const result = await judgeEmail(
      PLAIN_EMAIL, // non-urgent
      undefined,
      ctx({ senderPrior: { tier: "SILENT", count: 5, kind: "history" } }),
    );
    // SILENT is excluded from both prior allowlists, so even a strong,
    // non-urgent SILENT prior falls through to the LLM (here keyword fallback)
    // rather than short-circuiting (source "sender-prior") and muting the
    // sender with no LLM look — a silent one-way door the user can never see to
    // correct. The fallback may still land on SILENT; what matters is that it
    // went through the LLM path, not the blind prior bypass.
    expect(result.source).not.toBe("sender-prior");
    expect(result.source).toBe("keyword-fallback");
    expect(createCompletionMock).toHaveBeenCalled();
  });

  it("sends urgent-looking mail to the LLM even when the prior says SILENT", async () => {
    createCompletionMock.mockRejectedValue(new Error("provider down"));
    const result = await judgeEmail(
      { ...PLAIN_EMAIL, subject: "Deadline today: account action required" },
      undefined,
      ctx({ senderPrior: { tier: "SILENT", count: 5, kind: "history" } }),
    );
    // Same outcome as the non-urgent case above (SILENT never short-circuits);
    // the LLM was attempted and fell back to keywords since it's down.
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

  it("calls the LLM with the dedicated judge model, not the chat model", async () => {
    llmRespondsWith({ confidence: 0.6, senderTrust: 0.5, reversibility: 0.5, urgency: 0.3 });
    await judgeEmail(PLAIN_EMAIL, undefined, ctx({}));
    expect(createCompletionMock.mock.calls[0]?.[0]?.model).toBe("test-judge-model");
  });

  it("rubric scores system/transactional notices above the marketing floor", async () => {
    llmRespondsWith({ confidence: 0.6, senderTrust: 0.5, reversibility: 0.5, urgency: 0.3 });
    await judgeEmail(PLAIN_EMAIL, undefined, ctx({}));
    const prompt = sentPrompt();
    // Regression for the 2026-06-12 flash run: the rubric only defined 0.0
    // (marketing) and 0.5 (human), so a precise model scored deploy/invoice
    // notices 0.0 and the rule buried them in SILENT. QUEUE is doctrine.
    expect(prompt).toContain("0.3 = automated system/transactional notice");
    expect(prompt).toContain("NOT marketing");
    // And the date≠urgency clarification (flash scored a next-week invite 1.0).
    expect(prompt).toContain("A scheduled date alone is NOT urgency");
  });
});

describe("LLM retry", () => {
  function valid() {
    return {
      choices: [
        {
          message: {
            content: JSON.stringify({
              confidence: 0.9,
              senderTrust: 0.9,
              reversibility: 0.3,
              urgency: 0.9,
              reason: "urgent human ask",
            }),
          },
        },
      ],
    };
  }

  it("retries once and recovers from a transient provider failure", async () => {
    createCompletionMock
      .mockRejectedValueOnce(new Error("502 upstream"))
      .mockResolvedValueOnce(valid());
    // Human sender: PLAIN_EMAIL is noreply@ now, and the automated-sender
    // floor (#794) would cap the asserted PUSH to QUEUE regardless of retry.
    const result = await judgeEmail(
      { ...PLAIN_EMAIL, from: "Jamie Cho <jamie@corp.example>" },
      undefined,
      ctx({}),
    );
    expect(result.source).toBe("llm");
    expect(result.tier).toBe("PUSH");
    expect(createCompletionMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to keywords only after both attempts fail", async () => {
    createCompletionMock.mockRejectedValue(new Error("provider down"));
    const result = await judgeEmail(PLAIN_EMAIL, undefined, ctx({}));
    expect(result.source).toBe("keyword-fallback");
    expect(createCompletionMock).toHaveBeenCalledTimes(2);
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

describe("sender-prior short-circuit — urgency-guard hardening (#654 leak #5)", () => {
  // Two measured gaps (2026-07-17): the urgency guard's vocabulary had no
  // Korean deadline patterns (the founder's real buried-urgent mail read
  // "오늘 6시까지 회신 필요" — zero trigger words), and a HISTORY prior (model-
  // authored, never a human decision) could short-circuit mail from a real
  // person, whose content is heterogeneous by nature. Override priors are
  // explicit human ground truth and keep their existing behavior.

  it("Korean deadline vocabulary defeats a QUEUE short-circuit (goes to the LLM path)", async () => {
    createCompletionMock.mockRejectedValue(new Error("provider down"));
    const result = await judgeEmail(
      { ...PLAIN_EMAIL, subject: "오늘 6시까지 회신 필요 — 계약 최종 확인" },
      undefined,
      ctx({ senderPrior: { tier: "QUEUE", count: 4, kind: "history" } }),
    );
    expect(result.source).not.toBe("sender-prior");
    expect(createCompletionMock).toHaveBeenCalled();
  });

  it("a history prior never short-circuits mail from a human sender", async () => {
    createCompletionMock.mockRejectedValue(new Error("provider down"));
    const result = await judgeEmail(
      {
        from: "Kim Minsu <minsu@partnercorp.example>",
        subject: "Quarterly numbers",
        snippet: "sharing the sheet",
        labels: [],
      },
      undefined,
      ctx({ senderPrior: { tier: "QUEUE", count: 5, kind: "history" } }),
    );
    expect(result.source).not.toBe("sender-prior");
    expect(createCompletionMock).toHaveBeenCalled();
  });

  it("a history prior still short-circuits an automated sender (the cost path this prior exists for)", async () => {
    const result = await judgeEmail(
      PLAIN_EMAIL, // updates@acme.example — automated
      undefined,
      ctx({ senderPrior: { tier: "QUEUE", count: 4, kind: "history" } }),
    );
    expect(result.source).toBe("sender-prior");
    expect(createCompletionMock).not.toHaveBeenCalled();
  });

  it("an override prior on a human sender keeps short-circuiting (explicit human ground truth)", async () => {
    const result = await judgeEmail(
      {
        from: "Kim Minsu <minsu@partnercorp.example>",
        subject: "Quarterly numbers",
        snippet: "sharing the sheet",
        labels: [],
      },
      undefined,
      ctx({ senderPrior: { tier: "QUEUE", count: 2, kind: "override" } }),
    );
    expect(result.tier).toBe("QUEUE");
    expect(result.source).toBe("sender-prior");
  });
});
