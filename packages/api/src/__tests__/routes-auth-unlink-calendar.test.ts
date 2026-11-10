/**
 * C2 gate (b): unlinking a calendar account deletes that account's CalendarEvent
 * rows (and the AttentionItems mirrored from them) in the SAME transaction as
 * the account itself, so a linked event can never outlive its account on screen.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

const m = vi.hoisted(() => ({
  log: [] as string[],
  accountFindFirst: vi.fn(),
  accountDeleteMany: vi.fn(),
  eventFindMany: vi.fn(),
  eventDeleteMany: vi.fn(),
  attentionDeleteMany: vi.fn(),
  txStarts: 0,
  txOptions: undefined as unknown,
}));

vi.mock("../mail/gmail.js", () => ({
  getAuthUrl: vi.fn(() => "https://example.com/oauth"),
  getLoginAuthUrl: vi.fn(() => "https://example.com/oauth-login"),
  getLinkInboxAuthUrl: vi.fn(() => "https://example.com/oauth-link-inbox"),
  getLinkCalendarAuthUrl: vi.fn(() => "https://example.com/oauth-link-calendar"),
  getAuthedClient: vi.fn(async () => ({})),
  getGoogleConnectionStatus: vi.fn(async () => ({ connected: true })),
  isGoogleAuthError: vi.fn(() => false),
  markGoogleTokenForReconnect: vi.fn(async () => {}),
  getGoogleUserInfo: vi.fn(),
  getOAuth2Client: vi.fn(),
}));
vi.mock("../mail/email.js", () => ({
  sendVerificationEmail: vi.fn(async () => true),
  sendPasswordResetEmail: vi.fn(async () => true),
  sendBetaInviteEmail: vi.fn(async () => true),
}));
vi.mock("../mail/email-sync.js", () => ({
  syncLinkedInboxesForUser: vi.fn(async () => ({ newCount: 0 })),
  syncEmails: vi.fn(async () => ({ synced: 0, newCount: 0, source: "gmail" })),
  summarizeUnsummarizedEmails: vi.fn(async () => 0),
}));
vi.mock("../notify/welcome-email.js", () => ({ maybeSendWelcomeEmail: vi.fn(async () => {}) }));

function record(scope: "tx" | "global", name: string, fn: (...a: never[]) => unknown) {
  return (...args: never[]) => {
    m.log.push(`${scope}:${name}`);
    return fn(...args);
  };
}

vi.mock("../db.js", () => {
  // Two separate table sets: a call made through the transaction client logs
  // "tx:", one made through the global client logs "global:", whatever the timing.
  const tables = (scope: "tx" | "global") => ({
    linkedCalendarAccount: {
      findFirst: record(scope, "account.findFirst", m.accountFindFirst),
      deleteMany: record(scope, "account.deleteMany", m.accountDeleteMany),
    },
    calendarEvent: {
      findMany: record(scope, "event.findMany", m.eventFindMany),
      deleteMany: record(scope, "event.deleteMany", m.eventDeleteMany),
    },
    attentionItem: { deleteMany: record(scope, "attention.deleteMany", m.attentionDeleteMany) },
  });
  const prisma = {
    ...tables("global"),
    $transaction: async (cb: (tx: unknown) => Promise<unknown>, options?: unknown) => {
      m.txStarts += 1;
      m.txOptions = options;
      return cb(tables("tx"));
    },
    user: { findUnique: vi.fn(async () => ({ id: "u1", plan: "PRO", role: "USER" })) },
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma, INTERACTIVE_TX_OPTIONS: { maxWait: 10_000, timeout: 15_000 } };
});

import { authRoutes } from "../routes/auth.js";

const TOKEN = signToken({ userId: "u1", email: "owner@example.com" });
const headers = { authorization: `Bearer ${TOKEN}` };

async function unlink(id: string) {
  const app = Fastify();
  await app.register(authRoutes, { prefix: "/api/auth" });
  const res = await app.inject({
    method: "DELETE",
    url: `/api/auth/google/linked-calendars/${id}`,
    headers,
  });
  await app.close();
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.log.length = 0;
  m.txStarts = 0;
  m.accountFindFirst.mockResolvedValue({ id: "acct-1" });
  m.accountDeleteMany.mockResolvedValue({ count: 1 });
  m.eventFindMany.mockResolvedValue([{ id: "ev-1" }, { id: "ev-2" }]);
  m.eventDeleteMany.mockResolvedValue({ count: 2 });
  m.attentionDeleteMany.mockResolvedValue({ count: 1 });
});

describe("DELETE /api/auth/google/linked-calendars/:id", () => {
  it("removes the account and its events in ONE transaction, nothing outside it", async () => {
    const res = await unlink("acct-1");

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect(m.txStarts).toBe(1);
    expect(m.log.length).toBeGreaterThan(0);
    expect(m.log.every((entry) => entry.startsWith("tx:"))).toBe(true);
    expect(m.log).toContain("tx:account.deleteMany");
    expect(m.log).toContain("tx:event.deleteMany");
  });

  it("deletes the events and their attention items BEFORE the account, which the database would cascade", async () => {
    await unlink("acct-1");

    const order = (entry: string) => m.log.indexOf(entry);
    expect(order("tx:event.findMany")).toBeLessThan(order("tx:account.deleteMany"));
    expect(order("tx:attention.deleteMany")).toBeLessThan(order("tx:account.deleteMany"));
    expect(order("tx:event.deleteMany")).toBeLessThan(order("tx:account.deleteMany"));
  });

  it("runs the transaction with the pool-sized interactive options (repo rule, #845)", async () => {
    await unlink("acct-1");

    expect(m.txOptions).toEqual({ maxWait: 10_000, timeout: 15_000 });
  });

  it("deletes exactly this user's rows tagged with this account, never primary or LOCAL rows", async () => {
    await unlink("acct-1");

    // GOOGLE only: this Google-surface route can never remove another provider's
    // account by id (the mail route for linked inboxes does the same).
    expect(m.accountFindFirst).toHaveBeenCalledWith({
      where: { id: "acct-1", userId: "u1", provider: "GOOGLE" },
      select: { id: true },
    });
    expect(m.accountDeleteMany).toHaveBeenCalledWith({
      where: { id: "acct-1", userId: "u1", provider: "GOOGLE" },
    });
    expect(m.eventDeleteMany).toHaveBeenCalledWith({
      where: { userId: "u1", sourceAccountId: "acct-1" },
    });
  });

  it("also clears the AttentionItems mirrored from those events", async () => {
    await unlink("acct-1");

    expect(m.eventFindMany).toHaveBeenCalledWith({
      where: { userId: "u1", sourceAccountId: "acct-1" },
      select: { id: true },
    });
    expect(m.attentionDeleteMany).toHaveBeenCalledWith({
      where: { userId: "u1", source: "CALENDAR_EVENT", sourceId: { in: ["ev-1", "ev-2"] } },
    });
  });

  it("skips the attention delete when the account had no synced events", async () => {
    m.eventFindMany.mockResolvedValue([]);

    const res = await unlink("acct-1");

    expect(res.statusCode).toBe(200);
    expect(m.attentionDeleteMany).not.toHaveBeenCalled();
  });

  it("answers 404 and deletes nothing when the account is not this user's", async () => {
    m.accountFindFirst.mockResolvedValue(null);

    const res = await unlink("someone-elses-account");

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Linked calendar not found" });
    expect(m.eventDeleteMany).not.toHaveBeenCalled();
    expect(m.attentionDeleteMany).not.toHaveBeenCalled();
    expect(m.accountDeleteMany).not.toHaveBeenCalled();
  });

  it("answers 404 when a concurrent unlink already removed the account (the delete count decides)", async () => {
    m.accountDeleteMany.mockResolvedValue({ count: 0 });

    const res = await unlink("acct-1");

    expect(res.statusCode).toBe(404);
  });

  it("fails the request, and never reports success, when deleting the events fails", async () => {
    m.eventDeleteMany.mockRejectedValue(new Error("db down"));

    const res = await unlink("acct-1");

    expect(res.statusCode).toBe(500);
    expect(res.json()).not.toEqual({ success: true });
  });
});
