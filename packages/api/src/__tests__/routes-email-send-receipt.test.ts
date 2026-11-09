/**
 * Deterministic floor on the user-initiated send routes (send-receipt.ts):
 *   POST /api/email/send and POST /api/email/:id/reply.
 *
 * MANUAL_SEND_RECEIPTS_ENABLED off (default): no SendReceipt is read or
 * written and both responses are exactly what they were.
 * On: the receipt row is written BEFORE the provider is called (a failed write
 * refuses the send with 503 and nothing leaves), it binds the bytes the provider
 * receives, it is settled with the outcome (SENT + provider id, REFUSED), and the
 * success response gains `receipt: { id, v, action, payloadHash, approvedAt }`
 * whose payloadHash equals sendEmailPayloadHash of the sent { to, subject, body }.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";
import { sendEmailPayloadHash } from "../judge/attention-floor.js";

const order = vi.hoisted(() => [] as string[]);
const db = vi.hoisted(() => ({
  receiptCreate: vi.fn(),
  receiptUpdateMany: vi.fn(),
  linkedFindFirst: vi.fn(),
  emailFindFirst: vi.fn(),
  emailUpdateMany: vi.fn(async () => ({ count: 1 })),
  sentUpsert: vi.fn(async () => ({})),
}));
const gmail = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  createEmailDraft: vi.fn(),
  getAuthedClient: vi.fn(),
  getReplyHeaders: vi.fn(),
  markAsRead: vi.fn(),
  toggleReadGmail: vi.fn(),
  toggleStarGmail: vi.fn(),
  trashEmail: vi.fn(),
  untrashEmail: vi.fn(),
  archiveEmail: vi.fn(),
  unarchiveEmail: vi.fn(),
  GMAIL_TOOLS: [],
}));

vi.mock("../db.js", () => {
  const prisma = {
    sendReceipt: { create: db.receiptCreate, updateMany: db.receiptUpdateMany },
    linkedInboxAccount: { findFirst: db.linkedFindFirst },
    emailMessage: { findFirst: db.emailFindFirst, updateMany: db.emailUpdateMany },
    sentMessage: { upsert: db.sentUpsert },
    user: {
      findUnique: vi.fn(async () => ({
        id: "user-1",
        email: "test@example.com",
        role: "USER",
        sessionsInvalidatedAt: null,
      })),
    },
    device: {
      findUnique: vi.fn(async () => ({
        id: "device-1",
        lastActiveAt: new Date(),
        createdAt: new Date(),
      })),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../mail/gmail.js", () => gmail);
vi.mock("../mail/email-sync.js", () => ({ syncEmailByGmailId: vi.fn() }));
vi.mock("../analytics.js", () => ({ recordEvent: vi.fn() }));
vi.mock("../learning/contact-engagement.js", () => ({
  recordContactEngagement: vi.fn(async () => {}),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../billing/entitlement-guard.js", () => ({ requireEntitled: vi.fn(async () => {}) }));
vi.mock("../routes/email.js", () => ({ safeAttachmentFilename: (name: string) => name }));
vi.mock("../llm/llm-credentials.js", () => ({ getUserLlmCredentials: vi.fn(async () => ({})) }));
vi.mock("../learning/voice-profile-extractor.js", () => ({
  buildVoicePromptHint: vi.fn(async () => ""),
}));
vi.mock("../llm/openai.js", () => ({ createCompletion: vi.fn(), DRAFT_MODEL: "test-draft-model" }));
vi.mock("../mail/email-attachments.js", () => ({
  listEmailAttachments: vi.fn(async () => []),
  buildAttachmentCandidateProfile: vi.fn(() => null),
}));
vi.mock("../mail/email-candidate-intake.js", () => ({ updateCandidateIntake: vi.fn() }));

const TOKEN = signToken({ userId: "user-1", email: "test@example.com" });

async function inject(url: string, payload: Record<string, unknown>) {
  const { registerEmailMutationsRoutes } = await import("../routes/email-mutations.js");
  const { registerEmailRepliesRoutes } = await import("../routes/email-replies.js");
  const app = Fastify();
  await app.register(
    async (instance) => {
      await registerEmailMutationsRoutes(instance);
      await registerEmailRepliesRoutes(instance);
    },
    { prefix: "/api/email" },
  );
  const res = await app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    payload: JSON.stringify(payload),
  });
  await app.close();
  return res;
}

const MAIL = { to: "Alice@Example.com", subject: "Hi", body: "Hello" };
const EMAIL = {
  id: "e1",
  gmailId: "g1",
  threadId: "t1",
  from: "Boss <boss@corp.com>",
  subject: "Need your reply today",
  linkedInboxAccountId: null as string | null,
};

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  vi.stubEnv("MANUAL_SEND_RECEIPTS_ENABLED", "true");
  db.receiptCreate.mockImplementation(async () => {
    order.push("receipt");
    return { id: "rcpt-1" };
  });
  db.receiptUpdateMany.mockResolvedValue({ count: 1 });
  db.linkedFindFirst.mockResolvedValue(null);
  db.emailFindFirst.mockResolvedValue(EMAIL);
  gmail.sendEmail.mockImplementation(async () => {
    order.push("send");
    return { success: true, messageId: "sent-1", threadId: "t-9" };
  });
  gmail.getReplyHeaders.mockResolvedValue({ messageId: "<orig@corp.com>" });
});

afterEach(() => vi.unstubAllEnvs());

describe("flag off (default): both routes exactly as before", () => {
  beforeEach(() => vi.stubEnv("MANUAL_SEND_RECEIPTS_ENABLED", ""));

  it("POST /send writes no receipt and answers the provider result unchanged", async () => {
    const res = await inject("/api/email/send", MAIL);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, messageId: "sent-1", threadId: "t-9" });
    expect(db.receiptCreate).not.toHaveBeenCalled();
    expect(db.receiptUpdateMany).not.toHaveBeenCalled();
  });

  it("POST /:id/reply writes no receipt and answers unchanged", async () => {
    const res = await inject("/api/email/e1/reply", { body: "3pm works." });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      messageId: "sent-1",
      threadId: "t-9",
      to: "boss@corp.com",
      threaded: true,
    });
    expect(db.receiptCreate).not.toHaveBeenCalled();
  });
});

describe("POST /api/email/send with receipts on", () => {
  it("writes the receipt before sending, settles it SENT and returns it", async () => {
    const res = await inject("/api/email/send", MAIL);
    expect(res.statusCode).toBe(200);
    const payloadHash = sendEmailPayloadHash(MAIL);
    expect(res.json()).toEqual({
      success: true,
      messageId: "sent-1",
      threadId: "t-9",
      receipt: {
        id: "rcpt-1",
        v: "v1",
        action: "send_email",
        payloadHash,
        approvedAt: expect.any(String),
      },
    });
    expect(order).toEqual(["receipt", "send"]);
    expect(db.receiptCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user-1",
          route: "send",
          payloadHash,
          inbox: "primary",
          emailId: null,
          receipt: expect.objectContaining({ target: "alice@example.com", approvedBy: "user-1" }),
        }),
      }),
    );
    expect(db.receiptUpdateMany).toHaveBeenCalledWith({
      where: { id: "rcpt-1", userId: "user-1", status: "PENDING" },
      data: { status: "SENT", providerMessageId: "sent-1", completedAt: expect.any(Date) },
    });
  });

  it("a receipt that cannot be written refuses the send (503) — no send without a receipt", async () => {
    db.receiptCreate.mockRejectedValue(new Error("db down"));
    const res = await inject("/api/email/send", MAIL);
    expect(res.statusCode).toBe(503);
    expect(gmail.sendEmail).not.toHaveBeenCalled();
  });

  it("a provider refusal settles REFUSED and keeps the 400 body unchanged", async () => {
    gmail.sendEmail.mockResolvedValue({ error: "Gmail not connected." });
    const res = await inject("/api/email/send", MAIL);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Gmail not connected." });
    expect(db.receiptUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "REFUSED" }) }),
    );
  });

  it("a thrown send settles UNKNOWN (it may have gone out) and still fails the request", async () => {
    gmail.sendEmail.mockRejectedValue(new Error("socket hang up"));
    const res = await inject("/api/email/send", MAIL);
    expect(res.statusCode).toBe(500);
    expect(db.receiptUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "UNKNOWN" }) }),
    );
  });

  it("records the linked account the mail leaves from", async () => {
    db.linkedFindFirst.mockResolvedValue({ id: "li-1", provider: "GOOGLE" });
    await inject("/api/email/send", { ...MAIL, linkedInboxAccountId: "li-1" });
    expect(db.receiptCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ inbox: "li-1" }) }),
    );
  });

  it("validation failures write no receipt", async () => {
    await inject("/api/email/send", { to: "a@b.com", subject: "Hi" });
    await inject("/api/email/send", { ...MAIL, linkedInboxAccountId: "not-mine" });
    expect(db.receiptCreate).not.toHaveBeenCalled();
  });

  it("a reply-linked send (web AI draft) binds the same bytes and stores the answered mail", async () => {
    const res = await inject("/api/email/send", { ...MAIL, inReplyToEmailId: "e1" });
    expect(res.statusCode).toBe(200);
    // Threading is server-resolved from the user's own row, outside the v1 hash.
    const payloadHash = sendEmailPayloadHash(MAIL);
    expect(res.json().receipt).toMatchObject({ id: "rcpt-1", payloadHash });
    expect(order).toEqual(["receipt", "send"]);
    expect(db.receiptCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ route: "send", payloadHash, emailId: "e1" }),
      }),
    );
  });

  it("mail that is not the caller's writes no receipt (404 first)", async () => {
    db.emailFindFirst.mockResolvedValue(null);
    const res = await inject("/api/email/send", { ...MAIL, inReplyToEmailId: "not-mine" });
    expect(res.statusCode).toBe(404);
    expect(db.receiptCreate).not.toHaveBeenCalled();
    expect(gmail.sendEmail).not.toHaveBeenCalled();
  });
});

describe("POST /api/email/:id/reply with receipts on", () => {
  it("binds the server-derived recipient and subject, then sends and returns the receipt", async () => {
    const res = await inject("/api/email/e1/reply", { body: "3pm works." });
    expect(res.statusCode).toBe(200);
    const payloadHash = sendEmailPayloadHash({
      to: "boss@corp.com",
      subject: "Re: Need your reply today",
      body: "3pm works.",
    });
    expect(res.json()).toMatchObject({
      success: true,
      to: "boss@corp.com",
      threaded: true,
      receipt: { id: "rcpt-1", v: "v1", action: "send_email", payloadHash },
    });
    expect(order).toEqual(["receipt", "send"]);
    expect(db.receiptCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          route: "reply",
          emailId: "e1",
          inbox: "primary",
          payloadHash,
        }),
      }),
    );
    expect(db.receiptUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SENT", providerMessageId: "sent-1" }),
      }),
    );
  });

  it("a reply on a linked inbox records that account", async () => {
    db.emailFindFirst.mockResolvedValue({ ...EMAIL, linkedInboxAccountId: "li-7" });
    db.linkedFindFirst.mockResolvedValue({ provider: "GOOGLE" });
    await inject("/api/email/e1/reply", { body: "ok" });
    expect(db.receiptCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ inbox: "li-7" }) }),
    );
  });

  it("a receipt that cannot be written refuses the reply (503) and nothing is sent", async () => {
    db.receiptCreate.mockRejectedValue(new Error("db down"));
    const res = await inject("/api/email/e1/reply", { body: "ok" });
    expect(res.statusCode).toBe(503);
    expect(gmail.sendEmail).not.toHaveBeenCalled();
  });

  it("mail that is not the caller's writes no receipt (404 first)", async () => {
    db.emailFindFirst.mockResolvedValue(null);
    const res = await inject("/api/email/nope/reply", { body: "ok" });
    expect(res.statusCode).toBe(404);
    expect(db.receiptCreate).not.toHaveBeenCalled();
  });

  it("a provider refusal settles REFUSED (409 body unchanged)", async () => {
    gmail.sendEmail.mockResolvedValue({ error: "Recipient rejected." });
    const res = await inject("/api/email/e1/reply", { body: "ok" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "Recipient rejected." });
    expect(db.receiptUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "REFUSED" }) }),
    );
  });
});
