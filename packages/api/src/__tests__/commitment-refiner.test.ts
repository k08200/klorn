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
});
