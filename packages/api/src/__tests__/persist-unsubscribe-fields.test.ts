/**
 * persistGmailEmail — the parsed List-Unsubscribe targets must reach the DB
 * on BOTH paths: create (new mail) and update (re-sync backfills rows that
 * predate the columns, the fromAddress precedent). toJudgeableEmailRow is
 * the single derivation of the judge's bulk-mail boolean from the stored
 * columns, shared by the backfill sweep and the read-path heal.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../mail/activity-sync.js", () => ({
  ensureRecentMailSync: vi.fn(async () => {}),
}));

const findUnique = vi.hoisted(() => vi.fn(async () => null as unknown));
const create = vi.hoisted(() => vi.fn(async () => ({ id: "e1" })));
const update = vi.hoisted(() => vi.fn(async () => ({})));
const judgeEmail = vi.hoisted(() => vi.fn());
const captureError = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => {
  const prisma = { emailMessage: { findUnique, create, update } };
  return { prisma, db: prisma };
});
vi.mock("../mail/gmail.js", () => ({ markAsRead: vi.fn(async () => ({ success: true })) }));
vi.mock("../judge/poc-judge.js", () => ({ judgeEmail }));
vi.mock("../judge/judge-context.js", () => ({ buildJudgeContext: vi.fn(async () => ({})) }));
vi.mock("../judge/attention-mirror.js", () => ({
  upsertAttentionForEmailJudgement: vi.fn(async () => {}),
}));
vi.mock("../agentcore/email-action-trigger.js", () => ({
  scheduleAgentForActionableEmail: vi.fn(),
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
vi.mock("../judge/label-correction.js", () => ({
  reconcileLabelCorrection: vi.fn(async () => {}),
}));
vi.mock("../sentry.js", () => ({ captureError }));

import { persistGmailEmail, toJudgeableEmailRow } from "../judge/email-firewall.js";

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

const UNSUB = {
  listUnsubscribeMailto: "mailto:unsub@lists.x.com",
  listUnsubscribeUrl: "https://x.com/unsub",
  listUnsubscribeOneClick: true,
};

beforeEach(() => {
  findUnique.mockReset();
  findUnique.mockResolvedValue(null);
  create.mockReset();
  create.mockResolvedValue({ id: "e1" });
  update.mockReset();
  update.mockResolvedValue({});
  judgeEmail.mockReset();
  judgeEmail.mockResolvedValue({ tier: "QUEUE", reason: "r", features: {}, source: "llm" });
});

describe("persistGmailEmail — unsubscribe columns", () => {
  it("writes the parsed targets on create", async () => {
    await persistGmailEmail("u1", rawEmail(UNSUB));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining(UNSUB) }),
    );
  });

  it("backfills the targets on re-sync of an existing row", async () => {
    findUnique.mockResolvedValue({ id: "e1" });
    await persistGmailEmail("u1", rawEmail(UNSUB));
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining(UNSUB) }),
    );
  });
});

describe("toJudgeableEmailRow", () => {
  const base = {
    id: "e1",
    gmailId: "g-1",
    from: "a@b.com",
    subject: "s",
    snippet: null,
    body: null,
    labels: [],
    receivedAt: new Date(),
    linkedInboxAccountId: null,
  };

  it("derives hasListUnsubscribe=true from either stored target", () => {
    expect(
      toJudgeableEmailRow({
        ...base,
        listUnsubscribeMailto: "mailto:u@x.com",
        listUnsubscribeUrl: null,
      }).hasListUnsubscribe,
    ).toBe(true);
    expect(
      toJudgeableEmailRow({ ...base, listUnsubscribeMailto: null, listUnsubscribeUrl: "https://x" })
        .hasListUnsubscribe,
    ).toBe(true);
  });

  it("derives false when neither target is stored", () => {
    expect(
      toJudgeableEmailRow({ ...base, listUnsubscribeMailto: null, listUnsubscribeUrl: null })
        .hasListUnsubscribe,
    ).toBe(false);
  });
});

describe("update-path clobber guard", () => {
  it("does not touch the columns on re-sync when the producer never set them", async () => {
    // The IMAP/Outlook shape: no listUnsubscribe* keys at all. The guard
    // must skip the block entirely — writing nulls here would erase
    // Gmail-derived targets on every non-Gmail re-touch.
    findUnique.mockResolvedValue({ id: "e1" });
    await persistGmailEmail("u1", rawEmail());
    const data = (update.mock.calls[0] as Array<{ data: Record<string, unknown> }>)[0].data;
    expect(data).not.toHaveProperty("listUnsubscribeMailto");
    expect(data).not.toHaveProperty("listUnsubscribeUrl");
    expect(data).not.toHaveProperty("listUnsubscribeOneClick");
  });
});
