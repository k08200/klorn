/**
 * Multi-account gating (founder decision 2026-10-15): the FIRST mailbox is free
 * whatever the provider; a SECOND one is Pro. Boots the real naver-imap routes
 * at PAYWALL_ENABLED=true and pins the gate: free + no source → connects; free +
 * any other source → 403 before any IMAP connection; pro → connects; GET /status
 * stays open to everyone.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ plan: "FREE", role: "USER" }));
const tokenFindFirst = vi.hoisted(() => vi.fn(async (_args?: unknown) => null as unknown));
const linkedFindFirst = vi.hoisted(() => vi.fn(async (_args?: unknown) => null as unknown));
const linkedDeleteMany = vi.hoisted(() => vi.fn(async (_args?: unknown) => ({ count: 0 })));
const verifyImapCredentials = vi.hoisted(() => vi.fn(async (_args?: unknown) => ({ ok: true })));

vi.mock("../db.js", () => {
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({
        id: "user-1",
        plan: state.plan,
        role: state.role,
      })),
      update: vi.fn(async () => ({ id: "user-1" })),
    },
    userToken: { findFirst: tokenFindFirst },
    // Phase 0b: the naver routes read/write LinkedInboxAccount (provider
    // NAVER) instead of the four User columns.
    linkedInboxAccount: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      findFirst: linkedFindFirst,
      count: vi.fn(async () => 0),
      upsert: vi.fn(async () => ({ id: "row-1" })),
      deleteMany: linkedDeleteMany,
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
vi.mock("../crypto-tokens.js", () => ({ encryptToken: vi.fn(() => "cipher") }));
vi.mock("../mail/is-allowed-imap-host.js", () => ({ isAllowedImapHost: vi.fn(() => true) }));
vi.mock("../mail/imap-sync.js", () => ({ verifyImapCredentials }));
vi.mock("../mail/imap-first-sync.js", () => ({ startFirstImapSync: vi.fn(() => true) }));

const ORIGINAL_PAYWALL = process.env.PAYWALL_ENABLED;

async function buildApp() {
  process.env.PAYWALL_ENABLED = "true";
  vi.resetModules();
  const { signToken, requireAuth } = await import("../auth.js");
  const { imapConnectRoutes } = await import("../routes/imap-connect.js");
  const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");
  const app = Fastify();
  app.addHook("preHandler", requireAuth);
  await app.register(imapConnectRoutes(IMAP_PROVIDERS.NAVER), { prefix: "/api/naver-imap" });
  await app.ready();
  const token = signToken({ userId: "user-1", email: "test@example.com" });
  return { app, headers: { authorization: `Bearer ${token}` } };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.plan = "FREE";
  state.role = "USER";
  tokenFindFirst.mockResolvedValue(null);
  linkedFindFirst.mockResolvedValue(null);
});

const connect = (app: Awaited<ReturnType<typeof buildApp>>["app"], headers: object) =>
  app.inject({
    method: "POST",
    url: "/api/naver-imap/connect",
    headers: headers as Record<string, string>,
    payload: { email: "me@naver.com", password: "app-pass" },
  });

afterEach(() => {
  if (ORIGINAL_PAYWALL === undefined) delete process.env.PAYWALL_ENABLED;
  else process.env.PAYWALL_ENABLED = ORIGINAL_PAYWALL;
  vi.resetModules();
});

describe("Naver multi-account gating (PAYWALL_ENABLED=true)", () => {
  it("lets a FREE user with no mail source connect Naver as their first mailbox", async () => {
    const { app, headers } = await buildApp();
    const res = await connect(app, headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(linkedDeleteMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("403s a FREE user whose primary Google inbox is already their first mailbox", async () => {
    tokenFindFirst.mockResolvedValue({ id: "google-token" });
    const { app, headers } = await buildApp();
    const res = await connect(app, headers);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      error: "Connecting a second mail account is a Pro feature.",
      code: "ENTITLEMENT_REQUIRED",
    });
    // Refused before any IMAP connection is opened.
    expect(verifyImapCredentials).not.toHaveBeenCalled();
    await app.close();
  });

  it("403s a FREE user who already has another linked mailbox (even one needing reconnect)", async () => {
    linkedFindFirst.mockResolvedValue({ id: "icloud-row" });
    const { app, headers } = await buildApp();
    const res = await connect(app, headers);
    expect(res.statusCode).toBe(403);
    expect(verifyImapCredentials).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not count the account being re-connected against itself", async () => {
    const { app, headers } = await buildApp();
    await connect(app, headers);
    expect(linkedFindFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { userId: "user-1", NOT: { provider: "NAVER", email: "me@naver.com" } },
    });
    await app.close();
  });

  it("removes a NEW row when a parallel first connect committed meanwhile (check-after-insert)", async () => {
    // Pre-check: nothing else. Post-insert check: another mailbox now exists.
    linkedFindFirst.mockResolvedValueOnce(null).mockResolvedValue({ id: "parallel-row" });
    const { app, headers } = await buildApp();
    const res = await connect(app, headers);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("ENTITLEMENT_REQUIRED");
    expect(linkedDeleteMany).toHaveBeenCalledWith({ where: { id: "row-1", userId: "user-1" } });
    await app.close();
  });

  it("lets a PRO user connect a second mailbox (multi_account)", async () => {
    state.plan = "PRO";
    tokenFindFirst.mockResolvedValue({ id: "google-token" });
    const { app, headers } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/naver-imap/connect",
      headers,
      payload: { email: "me@naver.com", password: "app-pass" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    await app.close();
  });

  it("GET /status says canConnect=false once a FREE user has a mailbox", async () => {
    tokenFindFirst.mockResolvedValue({ id: "google-token" });
    const { app, headers } = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/naver-imap/status", headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().canConnect).toBe(false);
    await app.close();
  });

  it("keeps GET /status open to a FREE user (see/remove a previously-linked inbox)", async () => {
    const { app, headers } = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/naver-imap/status",
      headers,
    });
    expect(res.statusCode).toBe(200);
    // No source yet: the first mailbox is free, so the UI may offer the form.
    expect(res.json().canConnect).toBe(true);
    await app.close();
  });
});
