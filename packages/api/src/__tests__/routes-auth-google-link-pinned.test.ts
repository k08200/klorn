/**
 * Characterisation pins for the Google OAuth callback's account-link branches
 * (__oauth_state__, __link_calendar__, __link_inbox__) and its login branches.
 *
 * Every branch's outcome is pinned as either a redirect path or a status +
 * error, together with the writes it makes. The pins were recorded against the
 * GET callback that exchanged the code itself (Location = WEB + path); they hold
 * unchanged now that the callback parks the code and POST
 * /api/auth/link/complete finishes the link for the session that started it
 * (`next` = path). Only the driver below changed, never a pin.
 *
 * The login markers never park: they are pinned straight through the callback.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

const WEB = "https://app.example.com";
const GENERIC = "Google authorization failed. Please try again.";
const EXPIRY = Date.parse("2026-10-15T12:00:00Z");
const OWNER = {
  id: "u1",
  email: "owner@example.com",
  name: "Owner",
  plan: "PRO",
  role: "USER",
  emailVerified: true,
  passwordHash: null,
};

const m = vi.hoisted(() => ({
  getToken: vi.fn(),
  profile: vi.fn(),
  registerGmailWatch: vi.fn(async () => ({})),
  isEntitled: vi.fn(() => true),
  mayConnectMailAccount: vi.fn(async () => true),
  mayConnectPrimaryGoogle: vi.fn(async () => true),
  keepIfOnlyMailSource: vi.fn(async () => true),
  keepPrimaryGoogleIfOnlyMailSource: vi.fn(async () => true),
  findOwnedLinkedAccount: vi.fn(async () => null as null | { id: string; email: string }),
  userFindUnique: vi.fn(),
  tokenFindUnique: vi.fn(),
  tokenUpsert: vi.fn(),
  calendarUpsert: vi.fn(),
  inboxCount: vi.fn(),
  inboxUpsert: vi.fn(),
  captureError: vi.fn(),
}));

vi.mock("../mail/gmail.js", () => ({
  getAuthUrl: vi.fn(() => "https://accounts.example.com/connect"),
  getLoginAuthUrl: vi.fn(() => "https://accounts.example.com/login"),
  getLinkInboxAuthUrl: vi.fn(() => "https://accounts.example.com/link-inbox"),
  getLinkCalendarAuthUrl: vi.fn(() => "https://accounts.example.com/link-calendar"),
  getAuthedClient: vi.fn(),
  getGoogleConnectionStatus: vi.fn(async () => ({ connected: false })),
  isGoogleAuthError: vi.fn(() => false),
  markGoogleTokenForReconnect: vi.fn(async () => {}),
  registerGmailWatch: m.registerGmailWatch,
  getGoogleUserInfo: m.profile,
  getOAuth2Client: vi.fn(() => ({ getToken: m.getToken })),
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
vi.mock("../crypto-tokens.js", () => ({
  encryptToken: (t: string) => `enc:${t}`,
  encryptOptional: (t?: string | null) => (t ? `enc:${t}` : null),
}));
vi.mock("../sentry.js", () => ({ captureError: m.captureError }));
vi.mock("../billing/stripe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../billing/stripe.js")>()),
  isEntitled: m.isEntitled,
}));
vi.mock("../billing/mail-account-entitlement.js", () => ({
  SECOND_MAIL_ACCOUNT_REFUSAL: { error: "second", code: "ENTITLEMENT_REQUIRED" },
  canConnectNewMailAccount: vi.fn(async () => true),
  findOwnedLinkedAccount: m.findOwnedLinkedAccount,
  keepIfOnlyMailSource: m.keepIfOnlyMailSource,
  keepPrimaryGoogleIfOnlyMailSource: m.keepPrimaryGoogleIfOnlyMailSource,
  mayConnectMailAccount: m.mayConnectMailAccount,
  mayConnectPrimaryGoogle: m.mayConnectPrimaryGoogle,
  requireMailLinkStart: vi.fn(() => async () => {}),
}));
vi.mock("../db.js", () => {
  const prisma = {
    user: { findUnique: m.userFindUnique, update: vi.fn(async () => OWNER) },
    userToken: { findUnique: m.tokenFindUnique, upsert: m.tokenUpsert },
    linkedCalendarAccount: { upsert: m.calendarUpsert },
    linkedInboxAccount: { count: m.inboxCount, upsert: m.inboxUpsert },
    automationConfig: { upsert: vi.fn(async () => ({})) },
    waitlist: { findUnique: vi.fn(async () => null) },
    device: {
      create: vi.fn(async () => ({ id: "d1" })),
      findUnique: vi.fn(async () => ({ id: "d1", lastActiveAt: new Date() })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
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

type Pin = { redirect: string } | { status: number; error: string };
type App = Awaited<ReturnType<typeof buildApp>>;

const callbackUrl = (state: string) =>
  `/api/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`;

const U1 = { authorization: `Bearer ${signToken({ userId: "u1", email: OWNER.email })}` };

/**
 * Drive one flow for u1 and assert its pinned outcome. The callback must park
 * (no exchange, a handle in the fragment); u1's own session then completes it,
 * and the pin is what that completion answers: a pinned redirect is now the
 * `next` path, a pinned status is the same status and error.
 */
async function expectPinned(app: App, marker: string, pin: Pin) {
  const parked = await app.inject({
    method: "GET",
    url: callbackUrl(signToken({ userId: "u1", email: marker }, "10m")),
  });
  expect(parked.statusCode).toBe(302);
  const handle = /\/link\/complete#h=([0-9a-f]{64})$/.exec(parked.headers.location as string)?.[1];
  expect(handle).toBeDefined();
  expect(m.getToken).not.toHaveBeenCalled();

  const res = await app.inject({
    method: "POST",
    url: "/api/auth/link/complete",
    headers: U1,
    payload: { handle },
  });
  if ("redirect" in pin) {
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ next: pin.redirect });
  } else {
    expect(res.statusCode).toBe(pin.status);
    expect(res.json()).toEqual({ error: pin.error });
  }
}

const tokens = (over: Record<string, unknown> = {}) => ({
  tokens: { access_token: "at", refresh_token: "rt", expiry_date: EXPIRY, ...over },
});
const throwOnExchange = () => m.getToken.mockRejectedValueOnce(new Error("ENOTFOUND oauth.local"));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WEB_URL = WEB;
  m.getToken.mockResolvedValue(tokens());
  m.profile.mockResolvedValue({ email: "Linked@Example.com", verified_email: true, name: "L" });
  m.isEntitled.mockReturnValue(true);
  m.mayConnectMailAccount.mockResolvedValue(true);
  m.mayConnectPrimaryGoogle.mockResolvedValue(true);
  m.keepIfOnlyMailSource.mockResolvedValue(true);
  m.keepPrimaryGoogleIfOnlyMailSource.mockResolvedValue(true);
  m.findOwnedLinkedAccount.mockResolvedValue(null);
  m.userFindUnique.mockImplementation(
    async ({ where }: { where: { id?: string; email?: string } }) =>
      where.email ? { ...OWNER, email: where.email } : OWNER,
  );
  m.tokenFindUnique.mockResolvedValue(null);
  m.tokenUpsert.mockResolvedValue({ id: "tok-1" });
  m.calendarUpsert.mockResolvedValue({ id: "cal-1" });
  m.inboxCount.mockResolvedValue(0);
  m.inboxUpsert.mockResolvedValue({ id: "inbox-1" });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.WEB_URL;
});

function expectNoWrites() {
  expect(m.calendarUpsert).not.toHaveBeenCalled();
  expect(m.inboxUpsert).not.toHaveBeenCalled();
  expect(m.tokenUpsert).not.toHaveBeenCalled();
}

describe("__link_calendar__ pins", () => {
  const MARKER = "__link_calendar__";

  it.each([
    [
      "no access token",
      () => m.getToken.mockResolvedValueOnce({ tokens: {} }),
      "/calendar?linked=failed",
    ],
    [
      "an unverified Google address",
      () => m.profile.mockResolvedValueOnce({ email: "x@example.com", verified_email: false }),
      "/calendar?linked=unverified",
    ],
    [
      "a linking user that no longer exists",
      () => m.userFindUnique.mockResolvedValue(null),
      "/calendar?linked=failed",
    ],
    [
      "a linking user no longer entitled",
      () => m.isEntitled.mockReturnValue(false),
      "/calendar?linked=failed",
    ],
    [
      "the user's own primary address",
      () => m.profile.mockResolvedValueOnce({ email: " Owner@Example.com ", verified_email: true }),
      "/settings?inbox=self",
    ],
  ])("%s → %s, nothing written", async (_label, arrange, path) => {
    arrange();
    const app = await buildApp();
    await expectPinned(app, MARKER, { redirect: path });
    expectNoWrites();
    await app.close();
  });

  it("success → /calendar?linked=success with the exact upsert", async () => {
    const app = await buildApp();
    await expectPinned(app, MARKER, { redirect: "/calendar?linked=success" });
    expect(m.calendarUpsert).toHaveBeenCalledTimes(1);
    expect(m.calendarUpsert).toHaveBeenCalledWith({
      where: {
        userId_provider_email: { userId: "u1", provider: "GOOGLE", email: "linked@example.com" },
      },
      update: {
        accessToken: "enc:at",
        refreshToken: "enc:rt",
        expiresAt: new Date(EXPIRY),
        needsReconnect: false,
      },
      create: {
        userId: "u1",
        provider: "GOOGLE",
        email: "linked@example.com",
        accessToken: "enc:at",
        refreshToken: "enc:rt",
        expiresAt: new Date(EXPIRY),
      },
    });
    await app.close();
  });

  it("a failed code exchange → 500 with the generic error, reported", async () => {
    throwOnExchange();
    const app = await buildApp();
    await expectPinned(app, MARKER, { status: 500, error: GENERIC });
    expectNoWrites();
    expect(m.captureError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { scope: "auth.oauth.callback" },
    });
    await app.close();
  });
});

describe("__link_inbox__ pins", () => {
  const MARKER = "__link_inbox__";

  it.each([
    [
      "no access token",
      () => m.getToken.mockResolvedValueOnce({ tokens: {} }),
      "/settings?inbox=failed",
    ],
    [
      "an unverified Google address",
      () => m.profile.mockResolvedValueOnce({ email: "x@example.com", verified_email: false }),
      "/settings?inbox=unverified",
    ],
    [
      "a linking user that no longer exists",
      () => m.userFindUnique.mockResolvedValue(null),
      "/settings?inbox=failed",
    ],
    [
      "a second mailbox on Free",
      () => m.mayConnectMailAccount.mockResolvedValueOnce(false),
      "/settings?inbox=pro",
    ],
    [
      "a NEW link at the cap",
      () => m.inboxCount.mockResolvedValueOnce(10),
      "/settings?inbox=limit",
    ],
  ])("%s → %s, nothing written", async (_label, arrange, path) => {
    arrange();
    const app = await buildApp();
    await expectPinned(app, MARKER, { redirect: path });
    expectNoWrites();
    await app.close();
  });

  it("success → /settings?inbox=success with the exact upsert", async () => {
    const app = await buildApp();
    await expectPinned(app, MARKER, { redirect: "/settings?inbox=success" });
    expect(m.mayConnectMailAccount).toHaveBeenCalledWith("u1", {
      provider: "GOOGLE",
      email: "linked@example.com",
    });
    expect(m.inboxUpsert).toHaveBeenCalledWith({
      where: {
        userId_provider_email: { userId: "u1", provider: "GOOGLE", email: "linked@example.com" },
      },
      update: {
        accessToken: "enc:at",
        refreshToken: "enc:rt",
        expiresAt: new Date(EXPIRY),
        needsReconnect: false,
      },
      create: {
        userId: "u1",
        email: "linked@example.com",
        accessToken: "enc:at",
        refreshToken: "enc:rt",
        expiresAt: new Date(EXPIRY),
      },
    });
    expect(m.keepIfOnlyMailSource).toHaveBeenCalledWith("u1", {
      provider: "GOOGLE",
      email: "linked@example.com",
      id: "inbox-1",
    });
    await app.close();
  });

  it("a re-link is never capped and keeps the stored address", async () => {
    m.findOwnedLinkedAccount.mockResolvedValueOnce({ id: "old", email: "Linked@Example.com" });
    m.inboxCount.mockResolvedValue(99);
    const app = await buildApp();
    await expectPinned(app, MARKER, { redirect: "/settings?inbox=success" });
    expect(m.inboxCount).not.toHaveBeenCalled();
    expect(m.inboxUpsert.mock.calls[0]?.[0]).toMatchObject({
      where: { userId_provider_email: { email: "Linked@Example.com" } },
    });
    expect(m.keepIfOnlyMailSource).not.toHaveBeenCalled();
    await app.close();
  });

  it("a parallel first connect → /settings?inbox=pro after the write", async () => {
    m.keepIfOnlyMailSource.mockResolvedValueOnce(false);
    const app = await buildApp();
    await expectPinned(app, MARKER, { redirect: "/settings?inbox=pro" });
    expect(m.inboxUpsert).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("a failed code exchange → 500 with the generic error", async () => {
    throwOnExchange();
    const app = await buildApp();
    await expectPinned(app, MARKER, { status: 500, error: GENERIC });
    expectNoWrites();
    await app.close();
  });
});

describe("__oauth_state__ (primary connect) pins", () => {
  const MARKER = "__oauth_state__";

  it("a user that no longer exists → 404 User not found", async () => {
    m.userFindUnique.mockResolvedValue(null);
    const app = await buildApp();
    await expectPinned(app, MARKER, { status: 404, error: "User not found" });
    expectNoWrites();
    await app.close();
  });

  it("no refresh token and none stored → offline_access_denied", async () => {
    m.getToken.mockResolvedValueOnce({ tokens: { access_token: "at" } });
    const app = await buildApp();
    await expectPinned(app, MARKER, { redirect: "/settings?google=offline_access_denied" });
    expectNoWrites();
    expect(m.registerGmailWatch).not.toHaveBeenCalled();
    await app.close();
  });

  it("a second mailbox on Free → google=pro, nothing written", async () => {
    m.mayConnectPrimaryGoogle.mockResolvedValueOnce(false);
    const app = await buildApp();
    await expectPinned(app, MARKER, { redirect: "/settings?google=pro" });
    expectNoWrites();
    await app.close();
  });

  it("a parallel first connect on a NEW token → google=pro after the write", async () => {
    m.keepPrimaryGoogleIfOnlyMailSource.mockResolvedValueOnce(false);
    const app = await buildApp();
    await expectPinned(app, MARKER, { redirect: "/settings?google=pro" });
    expect(m.tokenUpsert).toHaveBeenCalledTimes(1);
    expect(m.keepPrimaryGoogleIfOnlyMailSource).toHaveBeenCalledWith("u1", "tok-1");
    expect(m.registerGmailWatch).not.toHaveBeenCalled();
    await app.close();
  });

  it("a repair keeps the stored refresh token and is never rolled back", async () => {
    m.tokenFindUnique.mockResolvedValueOnce({ refreshToken: "enc:old" });
    m.getToken.mockResolvedValueOnce({ tokens: { access_token: "at2", expiry_date: EXPIRY } });
    const app = await buildApp();
    await expectPinned(app, MARKER, { redirect: "/settings?google=connected" });
    expect(m.keepPrimaryGoogleIfOnlyMailSource).not.toHaveBeenCalled();
    expect(m.tokenUpsert).toHaveBeenCalledWith({
      where: { userId_provider: { userId: "u1", provider: "google" } },
      create: {
        userId: "u1",
        provider: "google",
        accessToken: "enc:at2",
        refreshToken: null,
        expiresAt: new Date(EXPIRY),
      },
      update: { accessToken: "enc:at2", expiresAt: new Date(EXPIRY) },
    });
    await app.close();
  });

  it("success → google=connected, the exact upsert, and the Gmail watch", async () => {
    const app = await buildApp();
    await expectPinned(app, MARKER, { redirect: "/settings?google=connected" });
    expect(m.tokenUpsert).toHaveBeenCalledWith({
      where: { userId_provider: { userId: "u1", provider: "google" } },
      create: {
        userId: "u1",
        provider: "google",
        accessToken: "enc:at",
        refreshToken: "enc:rt",
        expiresAt: new Date(EXPIRY),
      },
      update: { accessToken: "enc:at", refreshToken: "enc:rt", expiresAt: new Date(EXPIRY) },
    });
    expect(m.registerGmailWatch).toHaveBeenCalledWith("u1");
    await app.close();
  });

  it("a failed code exchange → 500 with the generic error", async () => {
    throwOnExchange();
    const app = await buildApp();
    await expectPinned(app, MARKER, { status: 500, error: GENERIC });
    expectNoWrites();
    await app.close();
  });
});

describe("login markers are unchanged: exchanged in the callback, never parked", () => {
  const login = (app: App, marker: string, userId = "ignored") =>
    app.inject({ method: "GET", url: callbackUrl(signToken({ userId, email: marker }, "10m")) });

  it("__google_login__ success → /auth/callback?code=<40 hex>, no credential written", async () => {
    const app = await buildApp();
    const res = await login(app, "__google_login__");
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(
      /^https:\/\/app\.example\.com\/auth\/callback\?code=[0-9a-f]{40}$/,
    );
    expect(m.getToken).toHaveBeenCalledWith("abc");
    expectNoWrites();
    await app.close();
  });

  it.each([
    [
      "no access token",
      () => m.getToken.mockResolvedValueOnce({ tokens: {} }),
      "/login?error=google_failed",
    ],
    [
      "an unverified Google address",
      () => m.profile.mockResolvedValueOnce({ email: "x@example.com", verified_email: false }),
      "/login?error=google_unverified",
    ],
    ["a failed code exchange", throwOnExchange, `/login?error=${encodeURIComponent(GENERIC)}`],
  ])("__google_login__ with %s → %s", async (_label, arrange, path) => {
    arrange();
    const app = await buildApp();
    const res = await login(app, "__google_login__");
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${WEB}${path}`);
    await app.close();
  });

  it("__google_login_desktop__ with a failed exchange → the desktop failure page", async () => {
    throwOnExchange();
    const app = await buildApp();
    const res = await login(app, "__google_login_desktop__", "nonce-1");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Login Failed");
    await app.close();
  });

  it("an unknown marker still exchanges, then 400s with Invalid OAuth state", async () => {
    const app = await buildApp();
    const res = await login(app, "someone@example.com", "u1");
    expect(m.getToken).toHaveBeenCalledWith("abc");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Invalid OAuth state" });
    expectNoWrites();
    await app.close();
  });
});
