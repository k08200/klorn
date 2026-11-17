/**
 * A failed AI analysis of an attachment falls back to the heuristic summary
 * and stores why in `analysisError`, which the attachment card and the file
 * exports show. What is stored is a code and facts, never the provider's
 * text: that can quote the attachment it was sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  executeRaw: vi.fn(async () => 1),
}));
const createCompletion = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => {
  const prisma = {
    $queryRaw: db.queryRaw,
    $executeRaw: db.executeRaw,
    feedbackEvent: { findMany: vi.fn(async () => []) },
  };
  return { prisma, db: prisma };
});
vi.mock("../llm/llm-credentials.js", () => ({ getUserLlmCredentials: vi.fn(async () => ({})) }));
vi.mock("../llm/openai.js", () => ({ createCompletion, MODEL: "test-model" }));

import { analyzePendingEmailAttachments } from "../mail/email-attachments.js";

/** The interpolated values of every $executeRaw call (the tagged template's substitutions). */
const writtenValues = () => db.executeRaw.mock.calls.flatMap((call) => call.slice(1) as unknown[]);

beforeEach(() => {
  vi.clearAllMocks();
  db.queryRaw.mockResolvedValue([
    {
      id: "att-1",
      filename: "quote.pdf",
      mimeType: "application/pdf",
      contentText: "Quote for the kitchen remodel",
      from: "builder@example.com",
      subject: "Your quote",
    },
  ]);
});

describe("analyzePendingEmailAttachments — a failed AI analysis", () => {
  it("stores a code and facts as analysisError, never the provider's text", async () => {
    createCompletion.mockRejectedValue(
      Object.assign(new Error("429 while reading: CANARY-attachment kitchen quote"), {
        status: 429,
      }),
    );

    expect(await analyzePendingEmailAttachments("user-1")).toBe(1);

    expect(JSON.stringify(writtenValues())).not.toContain("CANARY");
    expect(writtenValues()).toContain("AI analysis failed (PROVIDER_RATE_LIMITED; Error 429)");
  });

  it("stores a model answer that is not JSON as INTERNAL_ERROR, not the SyntaxError's quote", async () => {
    createCompletion.mockResolvedValue({
      choices: [{ message: { content: "CANARY-reply — here is what I found" } }],
    });

    await analyzePendingEmailAttachments("user-1");

    expect(JSON.stringify(writtenValues())).not.toContain("CANARY");
  });
});
