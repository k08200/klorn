/**
 * Founder decision 2026-10-15 (LOCKED) on the linked-Google surface: the FIRST
 * mailbox is free whatever the provider, a SECOND one is Pro. Boots the real
 * auth routes at PAYWALL_ENABLED=true for a FREE user.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../mail/gmail.js", () => ({
  getAuthUrl: vi.fn(() => "https://example.com/oauth"),
  getLoginAuthUrl: vi.fn(() => "https://example.com/oauth-login"),
  getLinkInboxAuthUrl: vi.fn(() => "https://example.com/oauth-link-inbox"),
  getLinkCalendarAuthUrl: vi.fn(() => "https://example.com/oauth-link-calendar"),
  getAuthedClient: vi.fn(),
  getGoogleConnectionStatus: vi.fn(async () => ({ connected: false })),
  isGoogleAuthError: vi.fn(() => false),
  markGoogleTokenForReconnect: vi.fn(async () => {}),
  registerGmailWatch: vi.fn(async () => {}),
  getGoogleUserInfo: vi.fn(async () => ({ email: "Linked@Example.com", verified_email: true })),
  getOAuth2Client: vi.fn(() => ({
    getToken: vi.fn(async () => ({
      tokens: { access_token: "at", refresh_token: "rt", expiry_date: Date.now() + 3600_000 },
    })),
  })),
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
vi.mock("../crypto-tokens.js", () => ({
  encryptToken: (t: string) => `enc:${t}`,
  encryptOptional: (t?: string | null) => (t ? `enc:${t}` : null),
}));

const state = vi.hoisted(() => ({ plan: "FREE", role: "USER" }));
const linked = vi.hoisted(() => ({
  findUnique: vi.fn(async (_a?: unknown) => null as unknown),
  findFirst: vi.fn(async (_a?: unknown) => null as unknown),
  findMany: vi.fn(async (_a?: unknown) => [] as unknown[]),
  count: vi.fn(async (_a?: unknown) => 0),
  upsert: vi.fn(async (_a?: unknown) => ({ id: "new-row" })),
  deleteMany: vi.fn(async (_a?: unknown) => ({ count: 1 })),
}));
const tokenFindFirst = vi.hoisted(() => vi.fn(async (_a?: unknown) => null as unknown));
const tokenFindUnique = vi.hoisted(() => vi.fn(async (_a?: unknown) => null as unknown));
const tokenUpsert = vi.hoisted(() => vi.fn(async (_a?: unknown) => ({ id: "tok" })));
const tokenDeleteMany = vi.hoisted(() => vi.fn(async (_a?: unknown) => ({ count: 1 })));

vi.mock("../db.js", () => {
  const prisma = {
    linkedInboxAccount: linked,
    userToken: {
      findFirst: tokenFindFirst,
      findUnique: tokenFindUnique,
      upsert: tokenUpsert,
      deleteMany: tokenDeleteMany,
    },
    user: {
      findUnique: vi.fn(async () => ({
        id: "u1",
        email: "u1@x.com",
        plan: state.plan,
        role: state.role,
      })),
    },
    device: {
      findUnique: vi.fn(async () => ({ id: "device-1" })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});

const ORIGINAL_PAYWALL = process.env.PAYWALL_ENABLED;

async function buildApp() {
  process.env.PAYWALL_ENABLED = "true";
  vi.resetModules();
  const { signToken } = await import("../auth.js");
  const { authRoutes } = await import("../routes/auth.js");
  const app = Fastify();
  await app.register(authRoutes, { prefix: "/api/auth" });
  const headers = { authorization: `Bearer ${signToken({ userId: "u1", email: "u1@x.com" })}` };
  const linkState = signToken({ userId: "u1", email: "__link_inbox__" });
  const connectState = signToken({ userId: "u1", email: "__oauth_state__" });
  return { app, headers, linkState, connectState };
}

async function callback() {
  const { app, linkState } = await buildApp();
  const res = await app.inject({
    method: "GET",
    url: `/api/auth/google/callback?code=abc&state=${encodeURIComponent(linkState)}`,
  });
  await app.close();
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.plan = "FREE";
  state.role = "USER";
  tokenFindFirst.mockResolvedValue(null);
  linked.findFirst.mockResolvedValue(null);
  linked.findUnique.mockResolvedValue(null);
  tokenFindUnique.mockResolvedValue(null);
});

afterEach(() => {
  if (ORIGINAL_PAYWALL === undefined) delete process.env.PAYWALL_ENABLED;
  else process.env.PAYWALL_ENABLED = ORIGINAL_PAYWALL;
  vi.resetModules();
});

describe("POST /google/link-inbox (start)", () => {
  it("lets a FREE user with no mailbox start linking a Google inbox", async () => {
    const { app, headers } = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/auth/google/link-inbox", headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toContain("oauth-link-inbox");
    await app.close();
  });

  it("403s a FREE user who already has a mailbox (primary Google)", async () => {
    tokenFindFirst.mockResolvedValue({ id: "google-token" });
    const { app, headers } = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/auth/google/link-inbox", headers });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      error: "Connecting a second mail account is a Pro feature.",
      code: "ENTITLEMENT_REQUIRED",
    });
    await app.close();
  });
});

describe("GET /google/callback (__link_inbox__)", () => {
  it("links a FREE user's first mailbox", async () => {
    const res = await callback();
    expect(res.headers.location).toContain("inbox=success");
    expect(linked.upsert).toHaveBeenCalledTimes(1);
    expect(linked.deleteMany).not.toHaveBeenCalled();
  });

  it("refuses (inbox=pro) when the FREE user has another mailbox, without writing", async () => {
    linked.findFirst.mockResolvedValue({ id: "icloud-row" });
    const res = await callback();
    expect(res.headers.location).toContain("inbox=pro");
    expect(linked.upsert).not.toHaveBeenCalled();
  });

  it("checks with the real, normalized address so the same account never counts against itself", async () => {
    await callback();
    expect(linked.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { userId: "u1", NOT: { provider: "GOOGLE", email: "linked@example.com" } },
    });
  });

  it("removes a NEW row when a parallel first connect committed meanwhile", async () => {
    linked.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ id: "parallel-row" });
    const res = await callback();
    expect(res.headers.location).toContain("inbox=pro");
    expect(linked.deleteMany).toHaveBeenCalledWith({ where: { id: "new-row", userId: "u1" } });
  });

  it("never deletes on a re-link of an existing row", async () => {
    linked.findUnique.mockResolvedValue({ id: "existing" });
    linked.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ id: "other" });
    const res = await callback();
    expect(res.headers.location).toContain("inbox=success");
    expect(linked.deleteMany).not.toHaveBeenCalled();
  });
});

describe("GET /google/linked-inboxes", () => {
  it("stays open to FREE and reports canConnect", async () => {
    const { app, headers } = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/google/linked-inboxes",
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accounts: [], canConnect: true });
    await app.close();
  });
});

describe("primary Google slot: POST /google/start + __oauth_state__ callback", () => {
  async function connectCallback() {
    const { app, connectState } = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/google/callback?code=abc&state=${encodeURIComponent(connectState)}`,
    });
    await app.close();
    return res;
  }

  it("lets a FREE user with no linked mailbox start (first connect or primary repair)", async () => {
    tokenFindFirst.mockResolvedValue({ id: "google-token" });
    const { app, headers } = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/auth/google/start", headers });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("403s a FREE user whose first mailbox is a linked one", async () => {
    linked.findFirst.mockResolvedValue({ id: "icloud-row" });
    const { app, headers } = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/auth/google/start", headers });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("ENTITLEMENT_REQUIRED");
    await app.close();
  });

  it("callback refuses (google=pro) without writing when a linked mailbox exists", async () => {
    linked.findFirst.mockResolvedValue({ id: "icloud-row" });
    const res = await connectCallback();
    expect(res.headers.location).toContain("google=pro");
    expect(tokenUpsert).not.toHaveBeenCalled();
  });

  it("callback connects a FREE user's first mailbox", async () => {
    const res = await connectCallback();
    expect(res.headers.location).toContain("google=connected");
    expect(tokenUpsert).toHaveBeenCalledTimes(1);
    expect(tokenDeleteMany).not.toHaveBeenCalled();
  });

  it("removes a NEW primary token when a linked mailbox committed meanwhile", async () => {
    linked.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ id: "parallel-row" });
    const res = await connectCallback();
    expect(res.headers.location).toContain("google=pro");
    expect(tokenDeleteMany).toHaveBeenCalledWith({ where: { userId: "u1", provider: "google" } });
  });

  it("never removes a primary token that existed before (a repair)", async () => {
    tokenFindUnique.mockResolvedValue({ refreshToken: "enc:old" });
    linked.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ id: "other" });
    const res = await connectCallback();
    expect(res.headers.location).toContain("google=connected");
    expect(tokenDeleteMany).not.toHaveBeenCalled();
  });
});
