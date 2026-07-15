import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression guard for the "not analyzed" dead end: the summarizer must
// select HTML-only / snippet-only rows (legacy body=null), and must feed the
// projected htmlBody text to the LLM instead of an empty string.

const findMany = vi.fn(async (): Promise<unknown[]> => []);
const update = vi.fn(async () => ({}));
vi.mock("../db.js", () => {
  const prisma = {
    emailMessage: {
      findMany: (...a: unknown[]) => findMany(...a),
      update: (...a: unknown[]) => update(...a),
    },
  };
  return { prisma, db: prisma };
});

vi.mock("../llm/llm-credentials.js", () => ({
  getUserLlmCredentials: vi.fn(async () => ({})),
}));
vi.mock("../providers/index.js", () => ({
  getProviderChain: vi.fn(() => [{ name: "env" }]),
}));

const createCompletion = vi.fn(async () => ({
  choices: [
    {
      message: {
        content: JSON.stringify({
          summary: "s",
          category: "other",
          keyPoints: [],
          actionItems: [],
          sentiment: "neutral",
          priority: "NORMAL",
        }),
      },
    },
  ],
}));
vi.mock("../llm/openai.js", () => ({
  createCompletion: (...a: unknown[]) => createCompletion(...a),
  MODEL: "test-model",
}));

vi.mock("../resolve-user-email.js", () => ({ resolveUserEmail: vi.fn(async () => "me@x.com") }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { summarizeUnsummarizedEmails } from "../mail/email-summarize.js";

beforeEach(() => {
  findMany.mockClear();
  update.mockClear();
  createCompletion.mockClear();
});

describe("summarizeUnsummarizedEmails rescue", () => {
  it("selects rows with null body when htmlBody or snippet is present", async () => {
    await summarizeUnsummarizedEmails("u1", 10);

    const where = (findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;
    expect(where.OR).toEqual([
      { body: { not: null } },
      { htmlBody: { not: null } },
      { snippet: { not: null } },
    ]);
  });

  it("feeds the projected htmlBody text to the model for html-only rows", async () => {
    findMany.mockResolvedValueOnce([
      {
        id: "e1",
        from: "a@b.c",
        subject: "Confirm",
        body: null,
        htmlBody: '<p>Confirm via <a href="https://x.co/verify/1">link</a></p>',
        snippet: "Confirm via",
        labels: [],
        priority: "NORMAL",
      },
    ]);

    const count = await summarizeUnsummarizedEmails("u1", 10);

    expect(count).toBe(1);
    const params = createCompletion.mock.calls[0]?.[0] as {
      messages: { content: string }[];
    };
    const prompt = params.messages.map((m) => m.content).join("\n");
    expect(prompt).toContain("https://x.co/verify/1");
    expect(update).toHaveBeenCalled();
  });
});
