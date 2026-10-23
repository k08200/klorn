/**
 * The Klorn mailbox's mapper output through the REAL persistGmailEmail (step E1b
 * of docs/providers/unified-platform-plan.md): what the EmailMessage create
 * receives for a received message. Prisma is mocked at the db.js boundary (repo
 * convention) and every fire-and-forget collaborator is stubbed.
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
import { type ResendReceivedContent, resendToRawEmail } from "../mail/klorn-inbound-map.js";

const EMAIL_ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";

const event = {
  email_id: EMAIL_ID,
  created_at: "2026-10-22T10:00:00.000Z",
  from: "kim@example.com",
  to: ["jane@klorn.ai"],
  cc: [],
  bcc: [],
  received_for: [],
  message_id: "<m1@example.com>",
  subject: "ignored: the content's subject is stored",
  attachments: [],
};

const content = {
  object: "email",
  id: EMAIL_ID,
  to: ["jane@klorn.ai"],
  from: "kim@example.com",
  created_at: "2026-10-22T10:00:00.000Z",
  subject: "Quarterly numbers",
  bcc: null,
  cc: null,
  reply_to: null,
  received_for: [],
  html: "<p>ignored when text is present</p>",
  text: "Hi Jane,\nthe numbers are attached.",
  headers: {
    From: `=?UTF-8?B?${Buffer.from("김철수", "utf8").toString("base64")}?= <Kim@Example.com>`,
    To: "Jane <jane@klorn.ai>",
    "List-Unsubscribe": "<https://example.com/u?id=1>",
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  },
  message_id: "<m1@example.com>",
  attachments: [],
  authentication: { spf: "pass", dkim: "pass", dmarc: "fail" },
} as unknown as ResendReceivedContent;

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(null);
  create.mockResolvedValue({ id: "e-new" });
});

describe("a Klorn mailbox message in the shared store", () => {
  it("is created with exactly the mapped fields", async () => {
    await persistGmailEmail("u-jane", resendToRawEmail(content, event), {
      userEmail: null,
      linkedInboxAccountId: "lia-jane",
    });

    expect(findUnique).toHaveBeenCalledWith({
      where: { userId_gmailId: { userId: "u-jane", gmailId: `klorn:${EMAIL_ID}` } },
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data).toEqual({
      userId: "u-jane",
      gmailId: `klorn:${EMAIL_ID}`,
      linkedInboxAccountId: "lia-jane",
      threadId: null,
      from: "김철수 <Kim@Example.com>",
      fromAddress: "kim@example.com",
      to: "Jane <jane@klorn.ai>",
      cc: null,
      subject: "Quarterly numbers",
      snippet: "Hi Jane, the numbers are attached.",
      body: "Hi Jane,\nthe numbers are attached.",
      htmlBody: null,
      labels: ["INBOX", "UNREAD"],
      isRead: false,
      isStarred: false,
      priority: "NORMAL",
      needsReply: false,
      needsReplyReason: null,
      needsReplyConfidence: 0,
      receivedAt: new Date("2026-10-22T10:00:00.000Z"),
      listUnsubscribeMailto: null,
      listUnsubscribeUrl: "https://example.com/u?id=1",
      listUnsubscribeOneClick: true,
      authentication: { spf: "pass", dkim: "pass", dmarc: "fail" },
    });
  });
});
