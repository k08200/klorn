/**
 * Incremental auth: the Google LOGIN callback must be identity-only — it signs
 * the user in and must NOT persist Google API tokens or register a Gmail
 * watch (login no longer requests Gmail/Calendar scopes, so any token saved
 * there would be identity-only and would poison "connected" status and every
 * scheduler that treats a UserToken row as "has Gmail").
 *
 * The CONNECT flow (__oauth_state__, reached via POST /api/auth/google/start and
 * finished by POST /api/auth/link/complete) is now the only place the primary
 * Google grant is stored — and it must also
 * register the Gmail Pub/Sub watch immediately, which previously only happened
 * on the login path (fresh connects otherwise wait for the hourly renewal
 * sweep before real-time push works).
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";
import { callbackThenComplete } from "./helpers/link-complete.js";

const registerGmailWatch = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("../mail/gmail.js", () => ({
  getAuthUrl: vi.fn(() => "https://example.com/oauth"),
  getLoginAuthUrl: vi.fn(() => "https://example.com/oauth-login"),
  getLinkInboxAuthUrl: vi.fn(() => "https://example.com/oauth-link-inbox"),
  getLinkCalendarAuthUrl: vi.fn(() => "https://example.com/oauth-link-calendar"),
  getAuthedClient: vi.fn(),
  getGoogleConnectionStatus: vi.fn(async () => ({ connected: false })),
  isGoogleAuthError: vi.fn(() => false),
  markGoogleTokenForReconnect: vi.fn(async () => {}),
  getGoogleUserInfo: vi.fn(async () => ({
    email: "login@example.com",
    verified_email: true,
    name: "Login User",
    picture: "",
  })),
  getOAuth2Client: vi.fn(() => ({
    getToken: vi.fn(async () => ({
      tokens: { access_token: "at", refresh_token: "rt", expiry_date: Date.now() + 3600_000 },
    })),
  })),
  registerGmailWatch,
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

vi.mock("../notify/welcome-email.js", () => ({
  maybeSendWelcomeEmail: vi.fn(async () => {}),
}));

vi.mock("../crypto-tokens.js", () => ({
  encryptToken: (t: string) => `enc:${t}`,
  encryptOptional: (t?: string | null) => (t ? `enc:${t}` : null),
}));

const userFindUnique = vi.hoisted(() => vi.fn());
const userUpdate = vi.hoisted(() => vi.fn());
const userTokenFindUnique = vi.hoisted(() => vi.fn());
const userTokenUpsert = vi.hoisted(() => vi.fn());
const automationConfigUpsert = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => {
  const prisma = {
    user: { findUnique: userFindUnique, update: userUpdate },
    userToken: { findUnique: userTokenFindUnique, upsert: userTokenUpsert },
    automationConfig: { upsert: automationConfigUpsert },
    device: {
      create: vi.fn(async () => ({ id: "d1" })),
      // requireAuth on the link completion looks the session's device up.
      findUnique: vi.fn(async () => ({ id: "d1", lastActiveAt: new Date() })),
      update: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    waitlist: { findUnique: vi.fn(async () => null) },
  };
  return { prisma, db: prisma };
});

import { authRoutes } from "../routes/auth.js";
import { linkCompleteRoutes } from "../routes/link-complete.js";

async function buildApp() {
  const app = Fastify();
  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(linkCompleteRoutes(), { prefix: "/api/auth" });
  return app;
}

const U1 = { authorization: `Bearer ${signToken({ userId: "u1", email: "login@example.com" })}` };

const EXISTING_USER = {
  id: "u1",
  email: "login@example.com",
  name: "Login User",
  emailVerified: true,
  passwordHash: null,
  plan: "PRO",
  role: "USER",
};

beforeEach(() => {
  registerGmailWatch.mockClear();
  userFindUnique.mockReset();
  userFindUnique.mockResolvedValue(EXISTING_USER);
  userUpdate.mockReset();
  userTokenFindUnique.mockReset();
  userTokenFindUnique.mockResolvedValue(null);
  userTokenUpsert.mockReset();
  userTokenUpsert.mockResolvedValue({});
  automationConfigUpsert.mockReset();
  automationConfigUpsert.mockResolvedValue({});
});

describe("Google login callback (identity-only)", () => {
  it("signs the user in without persisting Google tokens or registering a watch", async () => {
    const state = signToken({
      userId: "ignored",
      email: "__google_login__",
      lb: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: `/api/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`,
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("/auth/callback?code=");
    // Login no longer knows anything about the Gmail/Calendar integration, so
    // it must not claim a connection state in the redirect.
    expect(res.headers.location).not.toContain("google=");
    expect(userTokenUpsert).not.toHaveBeenCalled();
    expect(userTokenFindUnique).not.toHaveBeenCalled();
    expect(registerGmailWatch).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("Google connect callback → complete (__oauth_state__)", () => {
  it("stores the grant and registers the Gmail watch immediately", async () => {
    const state = signToken({ userId: "u1", email: "__oauth_state__" });
    const app = await buildApp();

    const res = await callbackThenComplete(
      app,
      `/api/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`,
      U1,
    );

    expect(res.statusCode).toBe(200);
    expect(res.json().next).toBe("/settings?google=connected");
    expect(userTokenUpsert).toHaveBeenCalledTimes(1);
    expect(registerGmailWatch).toHaveBeenCalledWith("u1");
    await app.close();
  });

  it("refuses a grant without a usable refresh token and registers nothing", async () => {
    const state = signToken({ userId: "u1", email: "__oauth_state__" });
    const app = await buildApp();
    const { getOAuth2Client } = await import("../mail/gmail.js");
    vi.mocked(getOAuth2Client).mockReturnValueOnce({
      getToken: vi.fn(async () => ({ tokens: { access_token: "at" } })),
    } as unknown as ReturnType<typeof getOAuth2Client>);

    const res = await callbackThenComplete(
      app,
      `/api/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`,
      U1,
    );

    expect(res.statusCode).toBe(200);
    expect(res.json().next).toBe("/settings?google=offline_access_denied");
    expect(userTokenUpsert).not.toHaveBeenCalled();
    expect(registerGmailWatch).not.toHaveBeenCalled();
    await app.close();
  });
});
