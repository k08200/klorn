import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createCompletion: vi.fn(),
  captureError: vi.fn(),
}));

vi.mock("../llm/openai.js", () => ({
  MODEL: "test-model",
  createCompletion: mocks.createCompletion,
}));

vi.mock("../sentry.js", () => ({
  captureError: mocks.captureError,
}));

import {
  isCommitmentLlmRefinementEnabled,
  maybeRefineCommitmentCandidateWithLlm,
} from "../pim/commitment-refiner.js";
import { DataWipeFenceError } from "../privacy/data-wipe-fence.js";

const ORIGINAL_FLAG = process.env.COMMITMENT_LLM_REFINEMENT;

const candidate = {
  text: "내일까지 자료 보내드릴게요.",
  owner: "USER" as const,
  dueHint: "내일",
  pattern: "ko-user-deliverable",
  startIndex: 0,
};

describe("commitment LLM refinement", () => {
  beforeEach(() => {
    mocks.createCompletion.mockReset();
    mocks.captureError.mockReset();
    delete process.env.COMMITMENT_LLM_REFINEMENT;
  });

  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.COMMITMENT_LLM_REFINEMENT;
    else process.env.COMMITMENT_LLM_REFINEMENT = ORIGINAL_FLAG;
  });

  it("stays disabled unless the feature flag is set", async () => {
    expect(isCommitmentLlmRefinementEnabled()).toBe(false);

    const out = await maybeRefineCommitmentCandidateWithLlm({
      candidate,
      sourceType: "CHAT",
      sourceText: candidate.text,
    });

    expect(out).toBeNull();
    expect(mocks.createCompletion).not.toHaveBeenCalled();
  });

  it("normalizes a valid LLM response", async () => {
    process.env.COMMITMENT_LLM_REFINEMENT = "1";
    mocks.createCompletion.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              isCommitment: true,
              title: "자료 보내기",
              kind: "DELIVERABLE",
              owner: "USER",
              counterpartyName: null,
              dueText: "내일",
              dueAt: "2026-04-29T14:59:00.000Z",
              confidence: 0.83,
            }),
          },
        },
      ],
    });

    const out = await maybeRefineCommitmentCandidateWithLlm({
      candidate,
      sourceType: "CHAT",
      sourceText: candidate.text,
      referenceDate: new Date("2026-04-28T05:00:00.000Z"),
      timeZone: "Asia/Seoul",
    });

    expect(out).toMatchObject({
      isCommitment: true,
      title: "자료 보내기",
      kind: "DELIVERABLE",
      owner: "USER",
      dueText: "내일",
      confidence: 0.83,
    });
    expect(out?.dueAt?.toISOString()).toBe("2026-04-29T14:59:00.000Z");
  });

  it("falls back to rule-based ingestion when the LLM call fails", async () => {
    process.env.COMMITMENT_LLM_REFINEMENT = "true";
    mocks.createCompletion.mockRejectedValueOnce(new Error("provider unavailable"));

    const out = await maybeRefineCommitmentCandidateWithLlm({
      candidate,
      sourceType: "EMAIL",
      sourceText: candidate.text,
      contextTitle: "자료 요청",
    });

    expect(out).toBeNull();
    expect(mocks.captureError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { scope: "commitment.llm_refinement" },
      }),
    );
  });

  describe("what a failure tells Sentry (the text is someone else's)", () => {
    const sourceText = `Re: 자료 요청 — ${candidate.text} 감사합니다.`;
    const input = {
      candidate,
      sourceType: "KAKAO" as const,
      sourceText,
      contextTitle: "KakaoTalk · 이민호",
    };

    function reported(): { error: Error; context: { extra: Record<string, unknown> } } {
      const [error, context] = mocks.captureError.mock.calls[0] as [
        Error,
        { extra: Record<string, unknown> },
      ];
      return { error, context };
    }

    function expectNoText(value: unknown): void {
      const serialized = JSON.stringify(value);
      for (const text of [candidate.text, "자료 요청", "이민호", "messages[1]"]) {
        expect(serialized).not.toContain(text);
      }
    }

    it("sends a provider error's name, status and the sizes, never the error itself", async () => {
      process.env.COMMITMENT_LLM_REFINEMENT = "1";
      const providerError = Object.assign(
        new Error(`400 messages[1].content: invalid input near "${candidate.text}"`),
        { name: "BadRequestError", status: 400, error: { prompt: sourceText } },
      );
      mocks.createCompletion.mockRejectedValueOnce(providerError);

      expect(await maybeRefineCommitmentCandidateWithLlm(input)).toBeNull();

      const { error, context } = reported();
      expect(error).not.toBe(providerError);
      expect(error.message).toBe("commitment refiner failed (BadRequestError)");
      expect(context).toEqual({
        tags: { scope: "commitment.llm_refinement" },
        extra: {
          errorName: "BadRequestError",
          status: 400,
          sourceType: "KAKAO",
          contextTitleLength: input.contextTitle.length,
          candidateTextLength: candidate.text.length,
          sourceTextLength: sourceText.length,
        },
      });
      expectNoText({ message: error.message, stack: error.stack, cause: error.cause, context });
    });

    it("reports a reply it cannot parse by name only, though JSON.parse quotes the reply", async () => {
      process.env.COMMITMENT_LLM_REFINEMENT = "1";
      mocks.createCompletion.mockResolvedValueOnce({
        choices: [{ message: { content: `${candidate.text} (not json)` } }],
      });

      expect(await maybeRefineCommitmentCandidateWithLlm(input)).toBeNull();

      const { error, context } = reported();
      expect(context.extra).toMatchObject({ errorName: "SyntaxError", status: null });
      expectNoText({ message: error.message, stack: error.stack, context });
    });

    it("reads the status off an exhausted provider chain's cause", async () => {
      process.env.COMMITMENT_LLM_REFINEMENT = "1";
      mocks.createCompletion.mockRejectedValueOnce(
        new Error("every provider failed", { cause: { status: 429 } }),
      );

      await maybeRefineCommitmentCandidateWithLlm(input);

      expect(reported().context.extra).toMatchObject({ errorName: "Error", status: 429 });
    });

    it("stays quiet about the data-wipe fence, as captureError would", async () => {
      process.env.COMMITMENT_LLM_REFINEMENT = "1";
      mocks.createCompletion.mockRejectedValueOnce(new DataWipeFenceError());

      expect(await maybeRefineCommitmentCandidateWithLlm(input)).toBeNull();
      expect(mocks.captureError).not.toHaveBeenCalled();
    });
  });

  it("does not treat malformed JSON shape as an explicit rejection", async () => {
    process.env.COMMITMENT_LLM_REFINEMENT = "1";
    mocks.createCompletion.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ title: "자료 보내기" }) } }],
    });

    const out = await maybeRefineCommitmentCandidateWithLlm({
      candidate,
      sourceType: "CHAT",
      sourceText: candidate.text,
    });

    expect(out?.isCommitment).toBeNull();
  });

  it("drops an LLM dueAt that carries no UTC offset", async () => {
    // "2026-11-13T15:00:00" would be read in the SERVER's zone, not the user's.
    process.env.COMMITMENT_LLM_REFINEMENT = "1";
    mocks.createCompletion.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              isCommitment: true,
              dueText: "내일 오후 3시",
              dueAt: "2026-11-13T15:00:00",
              confidence: 0.8,
            }),
          },
        },
      ],
    });

    const out = await maybeRefineCommitmentCandidateWithLlm({
      candidate,
      sourceType: "EMAIL",
      sourceText: candidate.text,
    });

    expect(out?.dueText).toBe("내일 오후 3시");
    expect(out?.dueAt).toBeNull();
  });

  it("drops an LLM dueAt on a date that does not exist", async () => {
    process.env.COMMITMENT_LLM_REFINEMENT = "1";
    mocks.createCompletion.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({ isCommitment: true, dueAt: "2026-02-30T10:00:00Z" }),
          },
        },
      ],
    });

    const out = await maybeRefineCommitmentCandidateWithLlm({
      candidate,
      sourceType: "EMAIL",
      sourceText: candidate.text,
    });

    expect(out?.dueAt).toBeNull();
  });

  it("keeps an offset-qualified LLM dueAt", async () => {
    process.env.COMMITMENT_LLM_REFINEMENT = "1";
    mocks.createCompletion.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({ isCommitment: true, dueAt: "2026-11-13T15:00:00+09:00" }),
          },
        },
      ],
    });

    const out = await maybeRefineCommitmentCandidateWithLlm({
      candidate,
      sourceType: "EMAIL",
      sourceText: candidate.text,
    });

    expect(out?.dueAt?.toISOString()).toBe("2026-11-13T06:00:00.000Z");
  });

  it("wraps the mail-derived due hint as untrusted and forbids meridiem guesses", async () => {
    process.env.COMMITMENT_LLM_REFINEMENT = "1";
    mocks.createCompletion.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ isCommitment: true }) } }],
    });

    await maybeRefineCommitmentCandidateWithLlm({
      candidate: { ...candidate, dueHint: "내일 8시" },
      sourceType: "EMAIL",
      sourceText: candidate.text,
    });

    const request = mocks.createCompletion.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const user = request.messages.find((message) => message.role === "user")?.content ?? "";
    const system = request.messages.find((message) => message.role === "system")?.content ?? "";
    expect(user).toContain(
      '<untrusted_content source="commitment:dueHint">내일 8시</untrusted_content>',
    );
    expect(system).toMatch(/8시/);
    expect(system).toMatch(/offset/i);
  });

  it("tells the LLM who wrote a KakaoTalk message and runs on the user's BYOK keys", async () => {
    process.env.COMMITMENT_LLM_REFINEMENT = "1";
    mocks.createCompletion.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ isCommitment: true }) } }],
    });
    const credentials = { anthropicApiKey: "sk-ant-test" };

    await maybeRefineCommitmentCandidateWithLlm({
      candidate,
      sourceType: "KAKAO",
      sourceText: candidate.text,
      userId: "user-1",
      authoredByUser: true,
      credentials,
      feature: "kakao-import",
    });

    const [request, options] = mocks.createCompletion.mock.calls[0] as [
      { messages: Array<{ role: string; content: string }> },
      Record<string, unknown>,
    ];
    const user = request.messages.find((message) => message.role === "user")?.content ?? "";
    expect(user).toContain("Message author: USER (the user wrote this message");
    expect(user).toContain(
      '<untrusted_content source="commitment:sourceText">내일까지 자료 보내드릴게요.</untrusted_content>',
    );
    expect(options).toEqual({
      userId: "user-1",
      priority: "background",
      credentials,
      feature: "kakao-import",
    });
  });

  it("keeps the mail prompt and call options as they were: no author line, no keys", async () => {
    process.env.COMMITMENT_LLM_REFINEMENT = "1";
    mocks.createCompletion.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ isCommitment: true }) } }],
    });

    await maybeRefineCommitmentCandidateWithLlm({
      candidate,
      sourceType: "EMAIL",
      sourceText: candidate.text,
      userId: "user-1",
    });

    const [request, options] = mocks.createCompletion.mock.calls[0] as [
      { messages: Array<{ role: string; content: string }> },
      Record<string, unknown>,
    ];
    const user = request.messages.find((message) => message.role === "user")?.content ?? "";
    const system = request.messages.find((message) => message.role === "system")?.content ?? "";
    expect(user).not.toContain("Message author:");
    expect(system).not.toContain("Message author");
    expect(system).not.toContain("KAKAO");
    expect(options).toEqual({ userId: "user-1", priority: "background" });
  });
});
