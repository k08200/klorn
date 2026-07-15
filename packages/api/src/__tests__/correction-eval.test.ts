/**
 * correction-eval — weekly counterfactual accuracy on real user overrides.
 *
 * Every manual tier override is a gold label. The eval re-judges each
 * overridden email with its OWN correction hidden from the judge context
 * (otherwise the few-shot pool contains the answer sheet), then scores
 * agreement. The summary math is pure; the runner is mocked at module
 * boundaries.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const attentionFindMany = vi.hoisted(() => vi.fn());
const emailFindMany = vi.hoisted(() => vi.fn());
const buildJudgeContextMock = vi.hoisted(() => vi.fn(async () => ({})));
const judgeEmailMock = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({
  prisma: {
    attentionItem: { findMany: attentionFindMany },
    emailMessage: { findMany: emailFindMany },
  },
  db: {},
}));

vi.mock("../judge-context.js", () => ({
  buildJudgeContext: buildJudgeContextMock,
}));

vi.mock("../poc-judge.js", () => ({
  judgeEmail: judgeEmailMock,
}));

vi.mock("../sentry.js", () => ({
  captureError: vi.fn(),
}));

import { runCorrectionEval, summarizeCorrectionEval } from "../learning/correction-eval.js";

const NOW = new Date("2026-06-14T01:00:00.000Z");

beforeEach(() => {
  attentionFindMany.mockReset();
  emailFindMany.mockReset();
  buildJudgeContextMock.mockReset();
  buildJudgeContextMock.mockResolvedValue({
    corrections: [],
    senderPrior: null,
    senderFacts: null,
  });
  judgeEmailMock.mockReset();
  process.env.OPENROUTER_API_KEY = "test-key";
});

afterEach(() => {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_COMPAT_BASE_URL;
});

describe("summarizeCorrectionEval", () => {
  it("computes agreement, per-tier recall/precision, and source mix", () => {
    const payload = summarizeCorrectionEval(
      [
        { expected: "PUSH", predicted: "PUSH", source: "llm" },
        { expected: "PUSH", predicted: "QUEUE", source: "llm" },
        { expected: "QUEUE", predicted: "QUEUE", source: "sender-prior" },
        { expected: "SILENT", predicted: "SILENT", source: "fast-path" },
        { expected: "QUEUE", predicted: "SILENT", source: "keyword-fallback" },
      ],
      NOW,
    );

    expect(payload.n).toBe(5);
    expect(payload.agreement).toBe(0.6);
    expect(payload.perTier.PUSH).toMatchObject({ support: 2, correct: 1, recall: 0.5 });
    // SILENT: predicted twice, one was really QUEUE → precision 0.5
    expect(payload.perTier.SILENT).toMatchObject({ predicted: 2, precision: 0.5 });
    expect(payload.sourceMix).toEqual({
      llm: 2,
      "sender-prior": 1,
      "fast-path": 1,
      "keyword-fallback": 1,
    });
    expect(payload.ranAt).toBe(NOW.toISOString());
  });
});

describe("runCorrectionEval", () => {
  function wireOverrides(
    overrides: Array<{ sourceId: string; tier: string }>,
    emails: Array<{ id: string; from: string; subject: string; snippet: string | null }>,
  ) {
    attentionFindMany.mockResolvedValue(overrides);
    emailFindMany.mockResolvedValue(emails.map((e) => ({ ...e, labels: [] })));
  }

  it("re-judges each override with its own correction hidden", async () => {
    wireOverrides(
      [
        { sourceId: "e1", tier: "QUEUE" },
        { sourceId: "e2", tier: "PUSH" },
      ],
      [
        { id: "e1", from: "A <a@x.com>", subject: "s1", snippet: null },
        { id: "e2", from: "B <b@y.com>", subject: "s2", snippet: null },
      ],
    );
    judgeEmailMock
      .mockResolvedValueOnce({ tier: "QUEUE", source: "llm" })
      .mockResolvedValueOnce({ tier: "QUEUE", source: "llm" });

    const payload = await runCorrectionEval("u1", NOW, { delayMs: 0 });

    expect(payload?.n).toBe(2);
    expect(payload?.agreement).toBe(0.5);
    // The counterfactual guard: context must exclude the email itself AND
    // its own correction from the few-shot pool.
    expect(buildJudgeContextMock).toHaveBeenCalledWith("u1", {
      from: "A <a@x.com>",
      excludeEmailId: "e1",
      excludeOwnCorrection: true,
    });
  });

  it("returns null when no LLM provider key is configured (keyword-only eval is noise)", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const payload = await runCorrectionEval("u1", NOW, { delayMs: 0 });
    expect(payload).toBeNull();
    expect(attentionFindMany).not.toHaveBeenCalled();
  });

  it("returns null when the user has no corrections", async () => {
    wireOverrides([], []);
    const payload = await runCorrectionEval("u1", NOW, { delayMs: 0 });
    expect(payload).toBeNull();
    expect(judgeEmailMock).not.toHaveBeenCalled();
  });

  it("skips overrides whose email row no longer exists", async () => {
    wireOverrides(
      [
        { sourceId: "gone", tier: "QUEUE" },
        { sourceId: "e2", tier: "SILENT" },
      ],
      [{ id: "e2", from: "B <b@y.com>", subject: "s2", snippet: null }],
    );
    judgeEmailMock.mockResolvedValueOnce({ tier: "SILENT", source: "fast-path" });

    const payload = await runCorrectionEval("u1", NOW, { delayMs: 0 });
    expect(payload?.n).toBe(1);
    expect(payload?.agreement).toBe(1);
  });

  it("ignores overrides with a legacy/invalid tier", async () => {
    wireOverrides(
      [{ sourceId: "e1", tier: "CALL" }],
      [{ id: "e1", from: "A <a@x.com>", subject: "s1", snippet: null }],
    );
    const payload = await runCorrectionEval("u1", NOW, { delayMs: 0 });
    expect(payload).toBeNull();
  });
});
