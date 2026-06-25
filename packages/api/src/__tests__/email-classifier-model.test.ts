/**
 * The batch enricher (category / needsReply / priority hints) must ride the
 * same paid judge model as the tier judge: on the :free default its daily
 * quota lockouts silently demoted every batch to the keyword fallback for
 * an hour at a time (same cliff PR #511 fixed for the tier judge).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const createCompletionMock = vi.hoisted(() => vi.fn());

vi.mock("../openai.js", () => ({
  createCompletion: createCompletionMock,
  MODEL: "test-chat-model",
  JUDGE_MODEL: "test-judge-model",
}));

vi.mock("../sentry.js", () => ({
  captureError: vi.fn(),
}));

import { classifyEmailBatch } from "../email-classifier.js";

const HUMAN_EMAIL = {
  id: "e1",
  from: "Sarah Kim <sarah@acmecorp.com>",
  subject: "Question about the proposal",
  snippet: "Could you take a look at section 3?",
  labels: [],
};

beforeEach(() => {
  createCompletionMock.mockReset();
});

describe("classifyEmailBatch — model routing", () => {
  it("calls the LLM with the judge model, not the chat model", async () => {
    createCompletionMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              labels: [
                { index: 0, priority: "medium", category: "customer", needsReply: true, reason: "q" },
              ],
            }),
          },
        },
      ],
    });

    const labels = await classifyEmailBatch([HUMAN_EMAIL]);

    expect(createCompletionMock).toHaveBeenCalledTimes(1);
    expect(createCompletionMock.mock.calls[0]?.[0]?.model).toBe("test-judge-model");
    expect(labels[0]?.category).toBe("customer");
  });

  it("coerces hallucinated enums / wrong-typed fields to safe defaults", async () => {
    createCompletionMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              labels: [
                { index: 0, priority: "urgent", category: "vip", needsReply: "yes", reason: 5 },
              ],
            }),
          },
        },
      ],
    });

    const labels = await classifyEmailBatch([HUMAN_EMAIL]);

    expect(labels[0]?.priority).toBe("low"); // "urgent" is not in the union
    expect(labels[0]?.category).toBe("other"); // "vip" is not in the union
    expect(labels[0]?.needsReply).toBe(false); // "yes" is not a boolean
    expect(labels[0]?.reason).toBeUndefined(); // 5 is not a string
  });

  it("degrades to the keyword fallback when the LLM fails", async () => {
    createCompletionMock.mockRejectedValue(new Error("provider down"));
    const labels = await classifyEmailBatch([HUMAN_EMAIL]);
    expect(labels).toHaveLength(1);
    expect(labels[0]?.priority).toBeDefined();
  });
});
