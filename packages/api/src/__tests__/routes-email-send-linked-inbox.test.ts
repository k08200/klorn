/**
 * POST /api/email/send — per-account send routing (CLAUDE.md multi-inbox rule:
 * every Gmail action threads the linked inbox account id end to end).
 *
 *   - no linkedInboxAccountId (or null / "primary"): the primary inbox, with the
 *     exact provider call the route always made — web and Mac send unchanged;
 *   - an id the caller owns: the ownership is checked against the caller's own
 *     LinkedInboxAccount rows, the provider is dispatched from that row
 *     (mailActionsFor) and the id rides into sendEmail's options, so the message
 *     leaves from that account and "waiting on" records it there;
 *   - an id that is not the caller's: 404 and nothing is sent — never a silent
 *     fall back to the primary inbox;
 *   - a value that is not an id: 400;
 *   - a linked mailbox whose provider cannot send from Klorn: 501, as the reply
 *     route answers.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

const db = vi.hoisted(() => ({
  linkedFindFirst: vi.fn(),
  sentUpsert: vi.fn(async () => ({})),
}));
const gmail = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  createEmailDraft: vi.fn(),
  getReplyHeaders: vi.fn(),
  markAsRead: vi.fn(),
  toggleReadGmail: vi.fn(),
  toggleStarGmail: vi.fn(),
  trashEmail: vi.fn(),
  untrashEmail: vi.fn(),
  archiveEmail: vi.fn(),
  unarchiveEmail: vi.fn(),
}));

vi.mock("../db.js", () => {
  const prisma = {
    linkedInboxAccount: { findFirst: db.linkedFindFirst },
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

const TOKEN = signToken({ userId: "user-1", email: "test@example.com" });

async function send(payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  const { registerEmailMutationsRoutes } = await import("../routes/email-mutations.js");
  const app = Fastify();
  await app.register(registerEmailMutationsRoutes, { prefix: "/api/email" });
  const res = await app.inject({
    method: "POST",
    url: "/api/email/send",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
    payload: JSON.stringify(payload),
  });
  await app.close();
  return res;
}

const MAIL = { to: "alice@example.com", subject: "Hi", body: "Hello" };

beforeEach(() => {
  vi.clearAllMocks();
  gmail.sendEmail.mockResolvedValue({ success: true, messageId: "sent-1", threadId: "t-1" });
  db.linkedFindFirst.mockResolvedValue(null);
});

describe("auth", () => {
  it("401 without a token, and nothing is sent or looked up", async () => {
    const res = await send({ ...MAIL, linkedInboxAccountId: "li-1" }, { authorization: "" });
    expect(res.statusCode).toBe(401);
    expect(gmail.sendEmail).not.toHaveBeenCalled();
    expect(db.linkedFindFirst).not.toHaveBeenCalled();
  });
});

describe("primary inbox (default unchanged)", () => {
  it.each([
    ["absent", {}],
    ["null", { linkedInboxAccountId: null }],
    ["primary", { linkedInboxAccountId: "primary" }],
  ])("%s → the exact send the route always made", async (_label, extra) => {
    const res = await send({ ...MAIL, ...extra });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, messageId: "sent-1", threadId: "t-1" });
    expect(gmail.sendEmail).toHaveBeenCalledTimes(1);
    expect(gmail.sendEmail.mock.calls[0]).toEqual([
      "user-1",
      "alice@example.com",
      "Hi",
      "Hello",
      [],
      undefined,
    ]);
    expect(db.linkedFindFirst).not.toHaveBeenCalled();
    expect(db.sentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ inbox: "primary" }) }),
    );
  });
});

describe("linked inbox", () => {
  it("an owned linked Google account sends from that account, end to end", async () => {
    db.linkedFindFirst.mockResolvedValue({ id: "li-1", provider: "GOOGLE" });
    const res = await send({ ...MAIL, linkedInboxAccountId: "li-1" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, messageId: "sent-1", threadId: "t-1" });
    // Ownership: the caller's own row, never a bare id.
    expect(db.linkedFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "li-1", userId: "user-1" } }),
    );
    expect(gmail.sendEmail).toHaveBeenCalledWith("user-1", "alice@example.com", "Hi", "Hello", [], {
      linkedInboxAccountId: "li-1",
    });
    // "Waiting on" reads the sent copy live from the same account.
    expect(db.sentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ inbox: "li-1", gmailId: "sent-1" }),
      }),
    );
  });

  it("an id that is not the caller's is 404 and nothing is sent — no fall back to primary", async () => {
    db.linkedFindFirst.mockResolvedValue(null);
    const res = await send({ ...MAIL, linkedInboxAccountId: "someone-elses" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Linked inbox not found" });
    expect(gmail.sendEmail).not.toHaveBeenCalled();
    expect(db.sentUpsert).not.toHaveBeenCalled();
  });

  it.each([
    [42],
    [""],
    ["   "],
    [{ id: "li-1" }],
    ["x".repeat(129)],
  ])("a value that is not an account id (%j) is 400 and nothing is sent", async (value) => {
    const res = await send({ ...MAIL, linkedInboxAccountId: value });
    expect(res.statusCode).toBe(400);
    expect(gmail.sendEmail).not.toHaveBeenCalled();
    expect(db.linkedFindFirst).not.toHaveBeenCalled();
  });

  it("a linked mailbox whose provider cannot send from Klorn is 501, never a primary send", async () => {
    db.linkedFindFirst.mockResolvedValue({ id: "li-naver", provider: "NAVER" });
    const res = await send({ ...MAIL, linkedInboxAccountId: "li-naver" });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({
      error: expect.stringContaining("does not support sending"),
    });
    expect(gmail.sendEmail).not.toHaveBeenCalled();
  });

  it("a soft provider error on a linked account is 400, like the primary path", async () => {
    db.linkedFindFirst.mockResolvedValue({ id: "li-1", provider: "GOOGLE" });
    gmail.sendEmail.mockResolvedValue({ error: "Gmail not connected." });
    const res = await send({ ...MAIL, linkedInboxAccountId: "li-1" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Gmail not connected." });
  });

  it("required fields are still checked before any account lookup", async () => {
    const res = await send({
      to: "alice@example.com",
      subject: "Hi",
      linkedInboxAccountId: "li-1",
    });
    expect(res.statusCode).toBe(400);
    expect(db.linkedFindFirst).not.toHaveBeenCalled();
  });
});
