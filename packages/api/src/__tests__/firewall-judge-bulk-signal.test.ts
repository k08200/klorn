/**
 * persistGmailEmail — the sync-time bulk-mail marker (hasListUnsubscribe,
 * parsed from the List-Unsubscribe header in gmail-fetch) must reach the
 * judge. detectTransactionalNotice keys on it to keep bulk marketing out of
 * INFO ("transactional notices stay visible, marketing is SILENT's
 * territory") — a caller that drops the field silently disables that rule in
 * production while the unit tests on the detector keep passing.
 * The Gmail/judge pipeline is mocked, same seam as firewall-promo-autoread.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../mail/activity-sync.js", () => ({
  ensureRecentMailSync: vi.fn(async () => {}),
}));

const findUnique = vi.hoisted(() => vi.fn(async () => null));
const create = vi.hoisted(() => vi.fn(async () => ({ id: "e1" })));
const update = vi.hoisted(() => vi.fn(async () => ({})));
const markAsRead = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const judgeEmail = vi.hoisted(() => vi.fn());
const upsert = vi.hoisted(() => vi.fn(async () => {}));
const scheduleAgent = vi.hoisted(() => vi.fn());
const captureError = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => {
  const prisma = { emailMessage: { findUnique, create, update } };
  return { prisma, db: prisma };
});
vi.mock("../mail/gmail.js", () => ({ markAsRead }));
vi.mock("../judge/poc-judge.js", () => ({ judgeEmail }));
vi.mock("../judge/judge-context.js", () => ({ buildJudgeContext: vi.fn(async () => ({})) }));
vi.mock("../judge/attention-mirror.js", () => ({ upsertAttentionForEmailJudgement: upsert }));
vi.mock("../agentcore/email-action-trigger.js", () => ({
  scheduleAgentForActionableEmail: scheduleAgent,
}));
vi.mock("../llm/llm-credentials.js", () => ({ getUserLlmCredentials: vi.fn(async () => ({})) }));
vi.mock("../resolve-user-email.js", () => ({ resolveUserEmail: vi.fn(async () => "me@x.com") }));
vi.mock("../mail/email-priority.js", () => ({
  classifyPriority: vi.fn(() => "NORMAL"),
  classifyNeedsReplyFromSignals: vi.fn(() => ({ needsReply: false, reason: null, confidence: 0 })),
}));
vi.mock("../pim/commitment-ingestion.js", () => ({
  extractAndUpsertCommitmentsFromText: vi.fn(async () => {}),
}));
vi.mock("../mail/email-attachments.js", () => ({
  upsertEmailAttachments: vi.fn(async () => {}),
  analyzePendingEmailAttachments: vi.fn(async () => 0),
}));
vi.mock("../sentry.js", () => ({ captureError }));

import { persistGmailEmail } from "../judge/email-firewall.js";

function rawEmail(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    gmailId: "g-1",
    threadId: "t-1",
    from: "sender@x.com",
    to: "me@x.com",
    cc: null,
    subject: "Hello",
    snippet: "snippet",
    body: "body",
    htmlBody: null,
    labels: [] as string[],
    isRead: false,
    isStarred: false,
    receivedAt: new Date("2026-06-25T00:00:00Z"),
    attachments: [] as unknown[],
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: test fixture shape
  } as any;
}

beforeEach(() => {
  findUnique.mockReset();
  findUnique.mockResolvedValue(null);
  create.mockReset();
  create.mockResolvedValue({ id: "e1" });
  judgeEmail.mockReset();
  judgeEmail.mockResolvedValue({
    tier: "SILENT",
    reason: "promo",
    features: {},
    source: "fast-path",
  });
  upsert.mockClear();
  scheduleAgent.mockClear();
  captureError.mockClear();
});

describe("persistGmailEmail — bulk-mail signal reaches the judge", () => {
  it("forwards hasListUnsubscribe=true into judgeEmail", async () => {
    await persistGmailEmail("u1", rawEmail({ hasListUnsubscribe: true }));
    await vi.waitFor(() => expect(judgeEmail).toHaveBeenCalledTimes(1));
    expect(judgeEmail.mock.calls[0][0]).toMatchObject({ hasListUnsubscribe: true });
  });

  it("forwards hasListUnsubscribe=false (header absent) as false", async () => {
    await persistGmailEmail("u1", rawEmail({ hasListUnsubscribe: false }));
    await vi.waitFor(() => expect(judgeEmail).toHaveBeenCalledTimes(1));
    expect(judgeEmail.mock.calls[0][0]).toMatchObject({ hasListUnsubscribe: false });
  });
});
