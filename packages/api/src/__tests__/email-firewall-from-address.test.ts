/**
 * persistGmailEmail must populate the normalized `fromAddress` column on BOTH
 * the create (new mail) and the update (re-synced mail) path, using the same
 * extractEmailAddress helper the judge query uses — so the indexed equality
 * lookup (SENDER_ADDRESS_INDEX_ENABLED) always matches the JS-side parse.
 *
 * Prisma is mocked at the db.js boundary (repo convention); no real DB. All the
 * fire-and-forget collaborators persistGmailEmail kicks off are stubbed so the
 * test asserts only the persisted EmailMessage data.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.hoisted(() => vi.fn());
const create = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({
  prisma: {
    emailMessage: { findUnique, create, update },
  },
  db: {},
}));

// Stub every collaborator persistGmailEmail touches so nothing hits a real DB
// or LLM; we only care about the create/update data shape.
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
  classifyNeedsReplyFromSignals: vi.fn(() => ({
    needsReply: false,
    reason: null,
    confidence: 0,
  })),
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

function rawEmail(overrides: Record<string, unknown> = {}) {
  return {
    gmailId: "g1",
    threadId: "t1",
    from: "Jane Doe <jane@acme.com>",
    to: "me@example.com",
    cc: null,
    subject: "hello",
    snippet: "hi there",
    body: null,
    htmlBody: null,
    labels: ["INBOX"],
    isRead: false,
    isStarred: false,
    receivedAt: new Date("2026-07-01T00:00:00Z"),
    attachments: [],
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
  } as any;
}

beforeEach(() => {
  findUnique.mockReset();
  create.mockReset();
  update.mockReset();
  create.mockResolvedValue({ id: "e-new" });
  update.mockResolvedValue({ id: "e-existing" });
});

describe("persistGmailEmail — fromAddress population", () => {
  it("sets the normalized fromAddress on create for a new email", async () => {
    findUnique.mockResolvedValue(null);
    await persistGmailEmail("u1", rawEmail({ from: "Jane Doe <jane@acme.com>" }));

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data.fromAddress).toBe("jane@acme.com");
  });

  it("lowercases and strips display name when deriving fromAddress on create", async () => {
    findUnique.mockResolvedValue(null);
    await persistGmailEmail("u1", rawEmail({ from: "Support <SUPPORT@Corp.COM>" }));

    expect(create.mock.calls[0][0].data.fromAddress).toBe("support@corp.com");
  });

  it("sets fromAddress on update when the email already exists (re-sync backfills it)", async () => {
    findUnique.mockResolvedValue({ id: "e-existing" });
    await persistGmailEmail("u1", rawEmail({ from: "Jane Doe <jane@acme.com>" }));

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].data.fromAddress).toBe("jane@acme.com");
  });
});

describe("persistGmailEmail refreshBody (IMAP re-poll)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    update.mockResolvedValue({});
  });

  it("rewrites body and snippet of an existing row when the caller asks and they changed", async () => {
    findUnique.mockResolvedValue({
      id: "row-1",
      body: "--b1\r\nContent-Type: text/plain",
      snippet: "--b1",
    });

    await persistGmailEmail("u1", rawEmail({ body: "decoded text", snippet: "decoded" }) as never, {
      refreshBody: true,
    });

    expect(update.mock.calls[0]?.[0]?.data).toMatchObject({
      body: "decoded text",
      snippet: "decoded",
    });
  });

  it("does not rewrite an unchanged body (no dead tuples per poll)", async () => {
    findUnique.mockResolvedValue({ id: "row-1", body: "decoded text", snippet: "decoded" });

    await persistGmailEmail("u1", rawEmail({ body: "decoded text", snippet: "decoded" }) as never, {
      refreshBody: true,
    });

    const data = update.mock.calls[0]?.[0]?.data ?? {};
    expect(data).not.toHaveProperty("body");
    expect(data).not.toHaveProperty("snippet");
  });

  it("never touches the body of an existing row without the option (Gmail path)", async () => {
    findUnique.mockResolvedValue({ id: "row-1", body: "old", snippet: "old" });

    await persistGmailEmail("u1", rawEmail({ body: "new", snippet: "new" }) as never);

    const data = update.mock.calls[0]?.[0]?.data ?? {};
    expect(data).not.toHaveProperty("body");
    expect(data).not.toHaveProperty("snippet");
  });
});
