import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The background summarize drain (2026-10-17). Every sync tick asks for at
// least 10 summaries "so a zero-new tick still drains the backlog" — and the
// backlog had no date bound. After the judge outages it held 1,172 mails for
// one user, back to March for another. Each day the drain spent the whole
// per-user LLM budget within hours of the 00:00 UTC reset, and every new email
// after that was judged by keywords alone. Old mail is summarized when it is
// opened (POST /api/email/:id/summarize); the drain only reaches recent mail.

const findMany = vi.fn(async (): Promise<unknown[]> => []);
vi.mock("../db.js", () => {
  const prisma = {
    user: { findUnique: vi.fn(async () => null) },
    linkedInboxAccount: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    senderLabel: { findMany: vi.fn(async () => []) },
    emailMessage: {
      findMany: (...a: unknown[]) => findMany(...a),
      update: vi.fn(async () => ({})),
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
vi.mock("../llm/openai.js", () => ({
  createCompletion: vi.fn(async () => ({ choices: [{ message: { content: "{}" } }] })),
  MODEL: "test-model",
}));
vi.mock("../resolve-user-email.js", () => ({ resolveUserEmail: vi.fn(async () => "me@x.com") }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import {
  SUMMARY_BACKLOG_MAX_AGE_DAYS,
  summarizeUnsummarizedEmails,
} from "../mail/email-summarize.js";

const NOW = new Date("2026-10-17T00:30:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  findMany.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("summarizeUnsummarizedEmails — backlog window", () => {
  it("reaches back seven days, no further", async () => {
    expect(SUMMARY_BACKLOG_MAX_AGE_DAYS).toBe(7);

    await summarizeUnsummarizedEmails("u1", 10);

    const where = (findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;
    expect(where.receivedAt).toEqual({ gte: new Date(NOW.getTime() - 7 * DAY_MS) });
  });

  it("keeps the rest of the selection: own unsummarized rows with some content, newest first", async () => {
    await summarizeUnsummarizedEmails("u1", 10);

    const args = findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      orderBy: unknown;
      take: number;
    };
    expect(args.where.userId).toBe("u1");
    expect(args.where.summary).toBeNull();
    expect(args.where.OR).toEqual([
      { body: { not: null } },
      { htmlBody: { not: null } },
      { snippet: { not: null } },
    ]);
    expect(args.orderBy).toEqual({ receivedAt: "desc" });
    expect(args.take).toBe(10);
  });
});
