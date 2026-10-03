/**
 * The judge-health heartbeat is observability: a throw from recordJudgeSource
 * must never skip the AttentionItem upsert that makes the judge's decision
 * visible (#1319 review, email-firewall.ts).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ prisma: {}, db: {} }));

const upsert = vi.hoisted(() => vi.fn(async () => "preserved" as const));
vi.mock("../judge/attention-mirror.js", () => ({ upsertAttentionForEmailJudgement: upsert }));
vi.mock("../pim/commitment-ingestion.js", () => ({
  extractAndUpsertCommitmentsFromText: vi.fn(() => Promise.resolve()),
}));
vi.mock("../agentcore/email-action-trigger.js", () => ({
  scheduleAgentForActionableEmail: vi.fn(() => Promise.resolve()),
}));
vi.mock("../mail/email-attachments.js", () => ({
  analyzePendingEmailAttachments: vi.fn(() => Promise.resolve()),
  upsertEmailAttachments: vi.fn(() => Promise.resolve()),
}));
vi.mock("../mail/gmail.js", () => ({ markAsRead: vi.fn(() => Promise.resolve()) }));
vi.mock("../judge/judge-context.js", () => ({
  buildJudgeContext: vi.fn(() => Promise.resolve({})),
}));
const recordJudgeSource = vi.hoisted(() => vi.fn());
vi.mock("../judge/judge-health.js", () => ({ recordJudgeSource }));
vi.mock("../llm/llm-credentials.js", () => ({
  getUserLlmCredentials: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("../judge/poc-judge.js", () => ({
  judgeEmail: vi.fn(() =>
    Promise.resolve({
      tier: "QUEUE",
      reason: "r",
      source: "keyword-fallback",
      features: { confidence: 0.55, senderTrust: 0.5, reversibility: 0.5, urgency: 0.2 },
    }),
  ),
}));
vi.mock("../resolve-user-email.js", () => ({
  resolveUserEmail: vi.fn(() => Promise.resolve("me@example.com")),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { judgeAndMirrorEmail } from "../judge/email-firewall.js";

const EMAIL = {
  id: "email-1",
  from: "a@example.com",
  subject: "s",
  snippet: "x",
  body: "x",
  labels: [],
  hasListUnsubscribe: false,
  receivedAt: new Date("2026-10-02T00:00:00Z"),
} as unknown as Parameters<typeof judgeAndMirrorEmail>[1];

beforeEach(() => {
  upsert.mockClear();
  recordJudgeSource.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("judgeAndMirrorEmail — judge-health guard", () => {
  it("still upserts the AttentionItem when recordJudgeSource throws", async () => {
    recordJudgeSource.mockImplementation(() => {
      throw new Error("tripwire exploded");
    });
    await expect(judgeAndMirrorEmail("user-1", EMAIL, {} as never, "en")).resolves.toBe("QUEUE");
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("records the judged-by source on the normal path", async () => {
    await judgeAndMirrorEmail("user-1", EMAIL, {} as never, "en");
    expect(recordJudgeSource).toHaveBeenCalledWith("keyword-fallback");
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
