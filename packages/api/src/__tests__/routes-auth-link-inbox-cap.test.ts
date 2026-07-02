/**
 * Linked-inbox cap at link time.
 *
 * The Google OAuth callback's __link_inbox__ branch upserts a
 * linkedInboxAccount with no ceiling, so a user could attach unbounded
 * inboxes. A NEW link is rejected once the user is at MAX_LINKED_INBOXES;
 * re-linking an already-linked email (the update path) is always allowed.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

vi.mock("../gmail.js", () => ({
  getAuthUrl: vi.fn(() => "https://example.com/oauth"),
  getLoginAuthUrl: vi.fn(() => "https://example.com/oauth-login"),
  getLinkInboxAuthUrl: vi.fn(() => "https://example.com/oauth-link-inbox"),
  getLinkCalendarAuthUrl: vi.fn(() => "https://example.com/oauth-link-calendar"),
  getAuthedClient: vi.fn(),
  getGoogleConnectionStatus: vi.fn(async () => ({ connected: false })),
  isGoogleAuthError: vi.fn(() => false),
  markGoogleTokenForReconnect: vi.fn(async () => {}),
  getGoogleUserInfo: vi.fn(async () => ({ email: "linked@example.com", verified_email: true })),
  getOAuth2Client: vi.fn(() => ({
    getToken: vi.fn(async () => ({
      tokens: { access_token: "at", refresh_token: "rt", expiry_date: Date.now() + 3600_000 },
    })),
  })),
}));

vi.mock("../email.js", () => ({
  sendVerificationEmail: vi.fn(async () => true),
  sendPasswordResetEmail: vi.fn(async () => true),
  sendBetaInviteEmail: vi.fn(async () => true),
}));

vi.mock("../crypto-tokens.js", () => ({
  encryptToken: (t: string) => `enc:${t}`,
  encryptOptional: (t?: string | null) => (t ? `enc:${t}` : null),
}));

const linkedFindUnique = vi.hoisted(() => vi.fn());
const linkedCount = vi.hoisted(() => vi.fn());
const linkedUpsert = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => {
  const prisma = {
    linkedInboxAccount: {
      findUnique: linkedFindUnique,
      count: linkedCount,
      upsert: linkedUpsert,
    },
  };
  return { prisma, db: prisma };
});

import { authRoutes } from "../routes/auth.js";

async function buildApp() {
  const app = Fastify();
  await app.register(authRoutes, { prefix: "/api/auth" });
  return app;
}

/** Drive the __link_inbox__ callback for a logged-in user linking a 2nd inbox. */
async function linkInbox(app: ReturnType<typeof Fastify>, userId = "u1") {
  const state = signToken({ userId, email: "__link_inbox__" });
  return app.inject({
    method: "GET",
    url: `/api/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`,
  });
}

beforeEach(() => {
  linkedFindUnique.mockReset();
  linkedCount.mockReset();
  linkedUpsert.mockReset();
  linkedUpsert.mockResolvedValue({});
});

describe("__link_inbox__ cap", () => {
  it("allows re-linking an already-linked email regardless of the count", async () => {
    // Existing row for (userId, email) → the update path, never count-blocked.
    linkedFindUnique.mockResolvedValue({ id: "existing" });
    linkedCount.mockResolvedValue(999);
    const app = await buildApp();

    const res = await linkInbox(app);

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("inbox=success");
    expect(linkedUpsert).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("rejects a NEW link when the user is at the cap, without upserting", async () => {
    linkedFindUnique.mockResolvedValue(null); // brand-new email
    linkedCount.mockResolvedValue(10); // at MAX_LINKED_INBOXES
    const app = await buildApp();

    const res = await linkInbox(app);

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("inbox=limit");
    expect(linkedUpsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("allows a NEW link when the user is under the cap", async () => {
    linkedFindUnique.mockResolvedValue(null); // brand-new email
    linkedCount.mockResolvedValue(9); // under MAX_LINKED_INBOXES
    const app = await buildApp();

    const res = await linkInbox(app);

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("inbox=success");
    expect(linkedUpsert).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
