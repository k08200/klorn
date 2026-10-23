/**
 * persistGmailEmail stores a message's SPF/DKIM/DMARC verdicts when its producer
 * has them (the Klorn mailbox, step E1b of docs/providers/unified-platform-plan.md)
 * and leaves the column alone for every other producer.
 *
 * Prisma is mocked at the db.js boundary (repo convention), and every
 * fire-and-forget collaborator is stubbed, as in email-firewall-from-address.
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

function rawEmail(overrides: Partial<GmailRawEmail> = {}): GmailRawEmail {
  return {
    gmailId: "klorn:jane@klorn.ai:e1",
    threadId: null,
    from: "Sam <sam@example.com>",
    to: "jane@klorn.ai",
    cc: "",
    subject: "hello",
    snippet: "hi there",
    body: "hi there",
    htmlBody: "",
    labels: ["INBOX", "UNREAD"],
    isRead: false,
    isStarred: false,
    receivedAt: new Date("2026-10-22T10:00:00Z"),
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

describe("persistGmailEmail — authentication", () => {
  it("writes the verdicts on create when the producer has them", async () => {
    const authentication = { spf: "pass", dkim: "fail", dmarc: "unknown" };
    await persistGmailEmail("u1", rawEmail({ authentication }), {
      userEmail: "jane@klorn.ai",
      linkedInboxAccountId: "lia-1",
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data.authentication).toEqual(authentication);
  });

  it("leaves the column out for a producer without them (Gmail, IMAP, Outlook)", async () => {
    await persistGmailEmail("u1", rawEmail());
    await persistGmailEmail("u1", rawEmail({ authentication: null }));

    expect(create).toHaveBeenCalledTimes(2);
    for (const call of create.mock.calls) {
      expect("authentication" in call[0].data).toBe(false);
    }
  });

  it("never touches the column when an existing row is re-synced", async () => {
    findUnique.mockResolvedValue({ id: "e-existing", body: "hi there", snippet: "hi there" });
    await persistGmailEmail(
      "u1",
      rawEmail({ authentication: { spf: "pass", dkim: "pass", dmarc: "pass" } }),
    );

    expect(update).toHaveBeenCalledTimes(1);
    expect("authentication" in update.mock.calls[0][0].data).toBe(false);
  });
});
