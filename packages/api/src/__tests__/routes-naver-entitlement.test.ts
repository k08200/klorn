/**
 * Multi-account gating: connecting a SECOND inbox (Naver IMAP) beyond the
 * primary Google account is a paid feature. Boots the real naver-imap routes
 * with the real guards at PAYWALL_ENABLED=true and pins the gate: free →
 * POST /connect = 403; pro → not 403; GET /status stays open to everyone.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ plan: "FREE", role: "USER" }));

vi.mock("../db.js", () => {
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({
        id: "user-1",
        plan: state.plan,
        role: state.role,
        naverImapEmail: null,
        naverImapHost: null,
        naverImapConnectedAt: null,
      })),
      update: vi.fn(async () => ({ id: "user-1" })),
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
vi.mock("../mail/naver-imap.js", () => ({
  verifyNaverImapCredentials: vi.fn(async () => ({ ok: true })),
}));

const ORIGINAL_PAYWALL = process.env.PAYWALL_ENABLED;

async function buildApp() {
  process.env.PAYWALL_ENABLED = "true";
  vi.resetModules();
  const { signToken, requireAuth } = await import("../auth.js");
  const { naverImapRoutes } = await import("../routes/naver-imap.js");
  const app = Fastify();
  app.addHook("preHandler", requireAuth);
  await app.register(naverImapRoutes, { prefix: "/api/naver-imap" });
  await app.ready();
  const token = signToken({ userId: "user-1", email: "test@example.com" });
  return { app, headers: { authorization: `Bearer ${token}` } };
}

beforeEach(() => {
  state.plan = "FREE";
  state.role = "USER";
});

afterEach(() => {
  if (ORIGINAL_PAYWALL === undefined) delete process.env.PAYWALL_ENABLED;
  else process.env.PAYWALL_ENABLED = ORIGINAL_PAYWALL;
  vi.resetModules();
});

describe("Naver multi-account gating (PAYWALL_ENABLED=true)", () => {
  it("403s a FREE user trying to connect a second inbox", async () => {
    const { app, headers } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/naver-imap/connect",
      headers,
      payload: { email: "me@naver.com", password: "app-pass" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("ENTITLEMENT_REQUIRED");
    await app.close();
  });

  it("lets a PRO user past the multi-account gate (not 403)", async () => {
    state.plan = "PRO";
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

  it("keeps GET /status open to a FREE user (see/remove a previously-linked inbox)", async () => {
    const { app, headers } = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/naver-imap/status",
      headers,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
