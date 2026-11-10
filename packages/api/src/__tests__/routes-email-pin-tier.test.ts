/**
 * POST/DELETE /api/email/:id/pin-tier — sender pin CRUD. Focus: ownership
 * scoping, exact parsed-address derivation (display names must not leak into
 * the rule), tier validation, upsert-not-duplicate, idempotent unpin.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

const emailFindFirst = vi.hoisted(() => vi.fn());
const ruleFindMany = vi.hoisted(() => vi.fn());
const ruleCreate = vi.hoisted(() => vi.fn());
const ruleDeleteMany = vi.hoisted(() => vi.fn());
const dbTransaction = vi.hoisted(() => vi.fn(async (ops: unknown[]) => Promise.all(ops)));

vi.mock("../mail/email.js", () => ({
  sendVerificationEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
}));
vi.mock("../mail/gmail.js", () => ({
  getAuthUrl: vi.fn(),
  getLoginAuthUrl: vi.fn(),
  getGoogleUserInfo: vi.fn(),
  getOAuth2Client: vi.fn(),
  getAuthedClient: vi.fn(async () => null),
  createEmailDraft: vi.fn(async () => ({ success: true, draftId: "draft-1" })),
  sendEmail: vi.fn(async () => ({ success: true })),
  toggleReadGmail: vi.fn(async () => {}),
  toggleStarGmail: vi.fn(async () => {}),
  trashEmail: vi.fn(async () => ({ success: true })),
  archiveEmail: vi.fn(async () => ({ success: true })),
  unarchiveEmail: vi.fn(async () => ({ success: true })),
  untrashEmail: vi.fn(async () => ({ success: true })),
}));
vi.mock("../mail/email-sync.js", () => ({
  syncEmails: vi.fn(async () => ({ synced: 0, newCount: 0, source: "gmail" })),
  syncEmailByGmailId: vi.fn(async () => ({ synced: 1, newCount: 1, emailId: "email-1" })),
  reconcileEmails: vi.fn(async () => ({ removed: 0, updated: 0 })),
  syncLinkedInboxesForUser: vi.fn(async () => ({ newCount: 0 })),
  summarizeUnsummarizedEmails: vi.fn(async () => 0),
  generateSmartReply: vi.fn(async () => "Reply"),
  classifyPriorityDetailed: vi.fn(() => ({ priority: "NORMAL", reason: "t", signals: [] })),
  checkAutoReplyRules: vi.fn(async () => null),
  getEmailThreads: vi.fn(async () => ({ threads: [], total: 0 })),
}));
vi.mock("../notify/push.js", () => ({ sendPushNotification: vi.fn() }));
vi.mock("../mail/meeting-context.js", () => ({ getMeetingContext: vi.fn(async () => null) }));
vi.mock("../user-timezone.js", () => ({ getUserTimeZone: vi.fn(async () => "Asia/Seoul") }));
vi.mock("../websocket.js", () => ({ pushNotification: vi.fn() }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

vi.mock("../db.js", () => {
  const prisma = {
    userToken: { findFirst: vi.fn(async () => null) },
    emailMessage: {
      findMany: vi.fn(async () => []),
      findFirst: emailFindFirst,
      count: vi.fn(async () => 0),
      groupBy: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
    },
    emailRule: {
      findMany: ruleFindMany,
      create: ruleCreate,
      deleteMany: ruleDeleteMany,
    },
    $transaction: dbTransaction,
    linkedInboxAccount: { findMany: vi.fn(async () => []) },
    user: { findUnique: vi.fn(async () => ({ id: "user-1", plan: "FREE", role: "USER" })) },
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});

const TOKEN = signToken({ userId: "user-1", email: "t@e.com" });
const auth = () => ({ authorization: `Bearer ${TOKEN}` });

async function buildApp() {
  const { emailRoutes } = await import("../routes/email.js");
  const app = Fastify();
  await app.register(emailRoutes, { prefix: "/api/email" });
  return app;
}

beforeEach(() => {
  emailFindFirst.mockReset();
  ruleFindMany.mockReset();
  ruleCreate.mockReset();
  ruleDeleteMany.mockReset();
  dbTransaction.mockClear();
  emailFindFirst.mockResolvedValue({ from: "Boss Person <Boss@Acme.com>" });
  ruleFindMany.mockResolvedValue([]);
  ruleCreate.mockResolvedValue({ id: "r1" });
  ruleDeleteMany.mockResolvedValue({ count: 1 });
});

describe("POST /api/email/:id/pin-tier", () => {
  it("creates a PIN_TIER rule keyed by the exact lowercased address", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/e1/pin-tier",
      headers: auth(),
      payload: { tier: "SILENT" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pinned: true, sender: "boss@acme.com", tier: "SILENT" });
    // Ownership enforced in the email lookup itself.
    expect(emailFindFirst.mock.calls[0][0].where.userId).toBe("user-1");
    const { data } = ruleCreate.mock.calls[0][0];
    expect(data).toMatchObject({
      userId: "user-1",
      actionType: "PIN_TIER",
      actionValue: "SILENT",
      conditions: { from: ["boss@acme.com"] },
    });
    await app.close();
  });

  it("replaces the sender's existing rule(s) atomically instead of duplicating", async () => {
    // Two stale rows (a healed double-submit) plus a multi-address rule that
    // must NOT be touched — exact-shape [sender] scoping.
    ruleFindMany.mockResolvedValue([
      { id: "r-old-1", conditions: { from: ["boss@acme.com"] } },
      { id: "r-old-2", conditions: { from: ["Boss@Acme.com"] } },
      { id: "r-multi", conditions: { from: ["boss@acme.com", "other@x.com"] } },
    ]);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/e1/pin-tier",
      headers: auth(),
      payload: { tier: "PUSH" },
    });
    expect(res.statusCode).toBe(200);
    // delete + create ran inside one transaction
    expect(dbTransaction).toHaveBeenCalledTimes(1);
    expect(ruleDeleteMany.mock.calls[0][0]).toEqual({
      where: { id: { in: ["r-old-1", "r-old-2"] }, userId: "user-1" },
    });
    expect(ruleCreate.mock.calls[0][0].data.actionValue).toBe("PUSH");
    await app.close();
  });

  it("rejects unknown tiers and unowned emails", async () => {
    const app = await buildApp();
    const bad = await app.inject({
      method: "POST",
      url: "/api/email/e1/pin-tier",
      headers: auth(),
      payload: { tier: "VIP" },
    });
    expect(bad.statusCode).toBe(400);

    emailFindFirst.mockResolvedValue(null);
    const missing = await app.inject({
      method: "POST",
      url: "/api/email/e1/pin-tier",
      headers: auth(),
      payload: { tier: "PUSH" },
    });
    expect(missing.statusCode).toBe(404);
    expect(ruleCreate).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("DELETE /api/email/:id/pin-tier", () => {
  it("deletes every matching rule when present, no-ops when absent", async () => {
    ruleFindMany.mockResolvedValue([
      { id: "r1", conditions: { from: ["boss@acme.com"] } },
      { id: "r2", conditions: { from: ["boss@acme.com"] } },
    ]);
    const app = await buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/email/e1/pin-tier",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pinned: false, sender: "boss@acme.com" });
    expect(ruleDeleteMany.mock.calls[0][0]).toEqual({
      where: { id: { in: ["r1", "r2"] }, userId: "user-1" },
    });

    ruleFindMany.mockResolvedValue([]);
    ruleDeleteMany.mockClear();
    const again = await app.inject({
      method: "DELETE",
      url: "/api/email/e1/pin-tier",
      headers: auth(),
    });
    expect(again.statusCode).toBe(200);
    expect(ruleDeleteMany).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("pin-tier scope=domain", () => {
  it("creates a fromDomain rule keyed by the sender's exact lowercased domain", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/e1/pin-tier",
      headers: auth(),
      payload: { tier: "SILENT", scope: "domain" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pinned: true, domain: "acme.com", tier: "SILENT" });
    expect(ruleCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "Pin: @acme.com",
          conditions: { fromDomain: ["acme.com"] },
          actionType: "PIN_TIER",
          actionValue: "SILENT",
        }),
      }),
    );
    await app.close();
  });

  it("replaces the domain's existing pin atomically, leaving sender pins alone", async () => {
    ruleFindMany.mockResolvedValue([
      { id: "old-domain", conditions: { fromDomain: ["acme.com"] } },
      { id: "sender-pin", conditions: { from: ["boss@acme.com"] } },
    ]);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/e1/pin-tier",
      headers: auth(),
      payload: { tier: "INFO", scope: "domain" },
    });
    expect(res.statusCode).toBe(200);
    expect(ruleDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["old-domain"] }, userId: "user-1" },
    });
    expect(dbTransaction).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("refuses to pin a public mailbox domain — that would pin strangers", async () => {
    emailFindFirst.mockResolvedValue({ from: "Someone <someone@gmail.com>" });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/e1/pin-tier",
      headers: auth(),
      payload: { tier: "SILENT", scope: "domain" },
    });
    expect(res.statusCode).toBe(400);
    expect(ruleCreate).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects an unknown scope", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/e1/pin-tier",
      headers: auth(),
      payload: { tier: "SILENT", scope: "galaxy" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("DELETE ?scope=domain removes only the domain pin", async () => {
    ruleFindMany.mockResolvedValue([
      { id: "old-domain", conditions: { fromDomain: ["acme.com"] } },
      { id: "sender-pin", conditions: { from: ["boss@acme.com"] } },
    ]);
    const app = await buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/email/e1/pin-tier?scope=domain",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pinned: false, domain: "acme.com" });
    expect(ruleDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["old-domain"] }, userId: "user-1" },
    });
    await app.close();
  });
});
