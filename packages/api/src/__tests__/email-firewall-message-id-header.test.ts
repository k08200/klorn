/**
 * persistGmailEmail stores the RFC 5322 Message-ID an IMAP producer read from the
 * envelope (attachment-bytes.ts looks a moved message up by it). Gmail and Outlook
 * producers leave it out, so their rows keep null. A re-sync fills a row that
 * predates the column once and never rewrites a stored value.
 *
 * Prisma is mocked at the db.js boundary (repo convention), and every
 * fire-and-forget collaborator is stubbed, as in email-firewall-authentication.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.hoisted(() => vi.fn());
const create = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({
  prisma: { emailMessage: { findUnique, create, update } },
  db: {},
}));
vi.mock("../judge/attention-mirror.js", () => ({ upsertAttentionForEmailJudgement: vi.fn() }));
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
vi.mock("../mail/email-priority.js", () => ({
  classifyNeedsReplyFromSignals: vi.fn(() => ({ needsReply: false, reason: null, confidence: 0 })),
  classifyPriority: vi.fn(() => "NORMAL"),
}));
vi.mock("../mail/gmail.js", () => ({ markAsRead: vi.fn(() => Promise.resolve()) }));
vi.mock("../judge/judge-context.js", () => ({
  buildJudgeContext: vi.fn(() => Promise.resolve({})),
}));
vi.mock("../judge/judge-health.js", () => ({ recordJudgeSource: vi.fn() }));
vi.mock("../judge/keyword-policy.js", () => ({ isClearMarketing: vi.fn(() => false) }));
vi.mock("../llm/llm-credentials.js", () => ({
  getUserLlmCredentials: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("../judge/poc-judge.js", () => ({ judgeEmail: vi.fn(() => Promise.resolve("QUEUE")) }));
vi.mock("../resolve-user-email.js", () => ({
  resolveUserEmail: vi.fn(() => Promise.resolve("me@example.com")),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { persistGmailEmail } from "../judge/email-firewall.js";
import type { GmailRawEmail } from "../mail/gmail-fetch.js";

const MESSAGE_ID = "<abc@x.example.com>";

function rawEmail(overrides: Partial<GmailRawEmail> = {}): GmailRawEmail {
  return {
    gmailId: "icloud-imap:me@example.com:7",
    threadId: null,
    from: "Sam <sam@example.com>",
    to: "me@example.com",
    cc: "",
    subject: "hello",
    snippet: "hi there",
    body: "hi there",
    htmlBody: "",
    labels: ["INBOX", "UNREAD"],
    isRead: false,
    isStarred: false,
    receivedAt: new Date("2026-11-01T10:00:00Z"),
    attachments: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(null);
  create.mockResolvedValue({ id: "e-new" });
  update.mockResolvedValue({ id: "e-existing" });
});

describe("persistGmailEmail — messageIdHeader", () => {
  it("writes it on create when the producer has one", async () => {
    await persistGmailEmail("u1", rawEmail({ messageIdHeader: MESSAGE_ID }));

    expect(create.mock.calls[0][0].data.messageIdHeader).toBe(MESSAGE_ID);
  });

  it("leaves the column out for a producer without one (Gmail, Outlook)", async () => {
    await persistGmailEmail("u1", rawEmail({ gmailId: "18c0ffee" }));
    await persistGmailEmail("u1", rawEmail({ messageIdHeader: null }));

    for (const call of create.mock.calls) {
      expect("messageIdHeader" in call[0].data).toBe(false);
    }
  });

  it("fills a re-synced row that predates the column", async () => {
    findUnique.mockResolvedValue({
      id: "e-existing",
      body: "hi there",
      snippet: "hi there",
      messageIdHeader: null,
    });

    await persistGmailEmail("u1", rawEmail({ messageIdHeader: MESSAGE_ID }));

    expect(update.mock.calls[0][0].data.messageIdHeader).toBe(MESSAGE_ID);
  });

  it("never rewrites or clears a stored value on re-sync", async () => {
    findUnique.mockResolvedValue({
      id: "e-existing",
      body: "hi there",
      snippet: "hi there",
      messageIdHeader: MESSAGE_ID,
    });

    await persistGmailEmail("u1", rawEmail({ messageIdHeader: "<new@x.example.com>" }));
    await persistGmailEmail("u1", rawEmail({ messageIdHeader: null }));
    await persistGmailEmail("u1", rawEmail());

    expect(update).toHaveBeenCalledTimes(3);
    for (const call of update.mock.calls) {
      expect("messageIdHeader" in call[0].data).toBe(false);
    }
  });
});
