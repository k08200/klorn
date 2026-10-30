import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * requireAdmin must not hand admin routes to an UNVERIFIED account that merely
 * sits on an ADMIN_EMAILS address. Register returns a working session before
 * the address is verified, so without this check anyone could pre-register an
 * ADMIN_EMAILS address that has no account yet and then set any user's plan or
 * role through /api/admin. GET /api/auth/me already requires a verified email
 * before promoting such an account (security audit 2026-07-21); the route
 * gate must agree.
 */

const userState: {
  user: { id: string; email: string; role: string; emailVerified: boolean } | null;
} = { user: null };

vi.mock("../db.js", () => {
  const device = {
    findUnique: vi.fn(async () => ({ id: "d1", userId: "u-1", lastActiveAt: new Date() })),
    update: vi.fn(async () => ({})),
  };
  const prisma = { device, user: { findUnique: vi.fn(async () => userState.user) } };
  return { prisma, db: prisma };
});

const { requireAdmin, signToken } = await import("../auth.js");

function fakeReply() {
  const reply = {
    statusCode: 200,
    code: vi.fn((status: number) => {
      reply.statusCode = status;
      return reply;
    }),
    send: vi.fn(() => reply),
  };
  return reply;
}

async function callRequireAdmin() {
  const token = signToken({ userId: "u-1", email: "ops@example.com" });
  const request = { headers: { authorization: `Bearer ${token}` } } as never;
  const reply = fakeReply();
  await requireAdmin(request, reply as never);
  return { request: request as { userId?: string }, reply };
}

describe("requireAdmin — ADMIN_EMAILS needs a verified address", () => {
  const savedAdminEmails = process.env.ADMIN_EMAILS;

  beforeEach(() => {
    process.env.ADMIN_EMAILS = "ops@example.com";
  });

  afterEach(() => {
    if (savedAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = savedAdminEmails;
    userState.user = null;
  });

  it("refuses an unverified account on an ADMIN_EMAILS address", async () => {
    userState.user = { id: "u-1", email: "ops@example.com", role: "USER", emailVerified: false };
    const { request, reply } = await callRequireAdmin();
    expect(reply.statusCode).toBe(403);
    expect(request.userId).toBeUndefined();
  });

  it("admits a verified account on an ADMIN_EMAILS address", async () => {
    userState.user = { id: "u-1", email: "ops@example.com", role: "USER", emailVerified: true };
    const { request, reply } = await callRequireAdmin();
    expect(reply.code).not.toHaveBeenCalled();
    expect(request.userId).toBe("u-1");
  });

  it("admits a role ADMIN account whatever its address", async () => {
    userState.user = {
      id: "u-1",
      email: "someone@example.com",
      role: "ADMIN",
      emailVerified: false,
    };
    const { request, reply } = await callRequireAdmin();
    expect(reply.code).not.toHaveBeenCalled();
    expect(request.userId).toBe("u-1");
  });

  it("refuses a plain USER account", async () => {
    userState.user = { id: "u-1", email: "someone@example.com", role: "USER", emailVerified: true };
    const { reply } = await callRequireAdmin();
    expect(reply.statusCode).toBe(403);
  });
});
