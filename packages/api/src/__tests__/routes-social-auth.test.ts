/**
 * Apple/Naver social login routes + the providers advertisement + /me's
 * hasAnyMailSource. Provider network calls (token exchange, profile fetch,
 * id_token verify) are mocked; everything from the callback inward — state
 * verification, account resolution, user/identity writes, device session,
 * exchange-code redirect — runs real against a mocked prisma.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

vi.mock("../mail/gmail.js", () => ({
  getAuthUrl: vi.fn(() => "https://example.com/oauth"),
  getLoginAuthUrl: vi.fn(() => "https://example.com/oauth-login"),
  getLinkInboxAuthUrl: vi.fn(() => "https://example.com/oauth-link-inbox"),
  getLinkCalendarAuthUrl: vi.fn(() => "https://example.com/oauth-link-calendar"),
  getAuthedClient: vi.fn(),
  getGoogleConnectionStatus: vi.fn(async () => ({ connected: false, needsReconnect: false })),
  isGoogleAuthError: vi.fn(() => false),
  markGoogleTokenForReconnect: vi.fn(async () => {}),
  getGoogleUserInfo: vi.fn(),
  getOAuth2Client: vi.fn(),
  registerGmailWatch: vi.fn(async () => ({})),
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

const welcomeEmail = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../notify/welcome-email.js", () => ({ maybeSendWelcomeEmail: welcomeEmail }));

const naverExchange = vi.hoisted(() => vi.fn(async (): Promise<string | null> => "naver-at"));
const naverProfile = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{ id: string; email: string; name?: string } | null> => ({
      id: "naver-uid-1",
      email: "user@naver.com",
      name: "네이버유저",
    }),
  ),
);
vi.mock("../auth/naver.js", () => ({
  buildNaverAuthUrl: (state: string) =>
    `https://nid.naver.com/oauth2.0/authorize?client_id=cid&state=${encodeURIComponent(state)}`,
  exchangeNaverCode: naverExchange,
  fetchNaverProfile: naverProfile,
  isNaverVerifiedEmail: (email: string) => /@naver\.com$/i.test(email.trim()),
}));

const appleVerify = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true as const,
    claims: { sub: "apple-sub-1", email: "relay@privaterelay.appleid.com", emailVerified: true },
  })),
);
const appleExchange = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true as const, idToken: "apple-id-token" })),
);
vi.mock("../auth/apple.js", () => ({
  buildAppleAuthUrl: (state: string) =>
    `https://appleid.apple.com/auth/authorize?client_id=cid&state=${encodeURIComponent(state)}`,
  exchangeAppleCode: appleExchange,
  verifyAppleIdToken: appleVerify,
}));

const identityFindUnique = vi.hoisted(() => vi.fn());
const identityUpsert = vi.hoisted(() => vi.fn());
const identityUpdate = vi.hoisted(() => vi.fn());
const userFindUnique = vi.hoisted(() => vi.fn());
const userCreate = vi.hoisted(() => vi.fn());
const userUpdate = vi.hoisted(() => vi.fn());
const waitlistFindUnique = vi.hoisted(() => vi.fn());
const userCount = vi.hoisted(() => vi.fn(async () => 0));
const automationUpsert = vi.hoisted(() => vi.fn(async () => ({})));
const DEVICE_ROW = vi.hoisted(() => ({
  id: "dev1",
  revokedAt: null,
  lastActiveAt: new Date(),
  createdAt: new Date(),
}));
const deviceCreate = vi.hoisted(() => vi.fn(async () => ({ id: "dev1" })));
const deviceFindUnique = vi.hoisted(() => vi.fn());
const deviceFindFirst = vi.hoisted(() => vi.fn());
const linkedCount = vi.hoisted(() => vi.fn(async () => 0));
// Users minted by prisma.user.create in a test, so the post-create reload and
// registerDevice's plan lookup find them (default findUnique consults this).
const createdUsers = vi.hoisted(
  () => [] as Array<{ id: string; email: string } & Record<string, unknown>>,
);

vi.mock("../db.js", () => {
  const prisma = {
    userIdentity: {
      findUnique: identityFindUnique,
      upsert: identityUpsert,
      update: identityUpdate,
    },
    user: {
      findUnique: userFindUnique,
      create: userCreate,
      update: userUpdate,
      count: userCount,
    },
    waitlist: { findUnique: waitlistFindUnique },
    automationConfig: { upsert: automationUpsert },
    device: {
      create: deviceCreate,
      findUnique: deviceFindUnique,
      findFirst: deviceFindFirst,
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      update: vi.fn(async () => DEVICE_ROW),
      updateMany: vi.fn(async () => ({ count: 1 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    linkedInboxAccount: { count: linkedCount },
    note: { findFirst: vi.fn(async () => ({ id: "n1" })) },
  };
  return { prisma, db: prisma };
});

import { exchangeCodes } from "../auth/exchange-codes.js";
import { authRoutes } from "../routes/auth.js";
import { appleAuthProvider, naverAuthProvider, socialAuthRoutes } from "../routes/social-auth.js";

const USER_ROW = {
  id: "u1",
  email: "user@naver.com",
  name: "기존유저",
  plan: "FREE",
  role: "USER",
  emailVerified: true,
  passwordHash: null,
  sessionsInvalidatedAt: null,
  timezone: "Asia/Seoul",
};

async function buildApp() {
  const app = Fastify();
  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(socialAuthRoutes(naverAuthProvider), { prefix: "/api/auth/naver" });
  await app.register(socialAuthRoutes(appleAuthProvider), { prefix: "/api/auth/apple" });
  return app;
}

function naverState(marker = "__naver_login__") {
  return signToken(
    { userId: "__login__", email: marker, lb: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    "10m",
  );
}

beforeEach(() => {
  identityFindUnique.mockReset().mockResolvedValue(null);
  identityUpsert.mockReset().mockResolvedValue({});
  identityUpdate.mockReset().mockResolvedValue({});
  createdUsers.length = 0;
  // Default user lookup: only users created within the test exist (by id or
  // email) — the post-create reload and registerDevice both go through here.
  userFindUnique
    .mockReset()
    .mockImplementation(async (args: { where?: { id?: string; email?: string } }) => {
      const where = args?.where ?? {};
      return (
        createdUsers.find(
          (u) => (where.id && u.id === where.id) || (where.email && u.email === where.email),
        ) ?? null
      );
    });
  userCreate.mockReset().mockImplementation(async (args: { data: { email: string } }) => {
    const row = { ...USER_ROW, id: "u-new", email: args.data.email };
    createdUsers.push(row);
    return row;
  });
  userUpdate.mockReset().mockResolvedValue(USER_ROW);
  waitlistFindUnique.mockReset().mockResolvedValue(null);
  automationUpsert.mockClear();
  deviceCreate.mockClear();
  welcomeEmail.mockClear();
  naverExchange.mockClear().mockResolvedValue("naver-at");
  naverProfile
    .mockClear()
    .mockResolvedValue({ id: "naver-uid-1", email: "user@naver.com", name: "네이버유저" });
  appleVerify.mockClear().mockResolvedValue({
    ok: true,
    claims: { sub: "apple-sub-1", email: "relay@privaterelay.appleid.com", emailVerified: true },
  });
  appleExchange.mockClear().mockResolvedValue({ ok: true, idToken: "apple-id-token" });
  linkedCount.mockClear().mockResolvedValue(0);
  deviceFindUnique.mockReset().mockResolvedValue(DEVICE_ROW);
  deviceFindFirst.mockReset().mockResolvedValue(DEVICE_ROW);
  delete process.env.APPLE_LOGIN_ENABLED;
  delete process.env.NAVER_LOGIN_ENABLED;
  delete process.env.BETA_GATE_ENABLED;
});

describe("dark-provider cloak", () => {
  it("answers Fastify's default 404 while the flag is off", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/auth/naver/login" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      message: "Route GET:/api/auth/naver/login not found",
      error: "Not Found",
      statusCode: 404,
    });
    const apple = await app.inject({ method: "POST", url: "/api/auth/apple/callback" });
    expect(apple.statusCode).toBe(404);
  });
});

describe("GET /api/auth/providers", () => {
  it("advertises only Google while the flags are off", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/auth/providers" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ providers: [{ id: "google" }] });
  });

  it("advertises Apple and Naver once their flags flip", async () => {
    process.env.APPLE_LOGIN_ENABLED = "true";
    process.env.NAVER_LOGIN_ENABLED = "true";
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/auth/providers" });
    expect(res.json().providers.map((p: { id: string }) => p.id)).toEqual([
      "google",
      "apple",
      "naver",
    ]);
  });
});

describe("Naver login flow", () => {
  beforeEach(() => {
    process.env.NAVER_LOGIN_ENABLED = "true";
  });

  it("/login bounces to the Naver consent URL with a signed state", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/naver/login?lb=${"A".repeat(43)}`,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("https://nid.naver.com/oauth2.0/authorize");
    expect(res.headers.location).toContain("state=");
  });

  it("creates a user + identity for a new @naver.com sign-in and redirects with an exchange code", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/naver/callback?code=abc&state=${encodeURIComponent(naverState())}`,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(
      /^http:\/\/localhost:8001\/auth\/callback\?code=[a-f0-9]{40}$/,
    );
    expect(userCreate).toHaveBeenCalledTimes(1);
    const createArgs = userCreate.mock.calls[0][0] as {
      data: { identities: { create: { provider: string; subject: string } } };
    };
    expect(createArgs.data.identities.create).toMatchObject({
      provider: "naver",
      subject: "naver-uid-1",
    });
    expect(deviceCreate).toHaveBeenCalledTimes(1);
    expect(welcomeEmail).toHaveBeenCalledTimes(1);
  });

  it("refuses to start a web sign-in that names no browser (login CSRF)", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/auth/naver/login" });
    expect(res.headers.location).toBe("http://localhost:8001/login?error=session_expired");
  });

  it("refuses a callback whose state names no browser, before any account is touched", async () => {
    const app = await buildApp();
    const unbound = signToken({ userId: "__login__", email: "__naver_login__" }, "10m");
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/naver/callback?code=abc&state=${encodeURIComponent(unbound)}`,
    });
    expect(res.headers.location).toBe("http://localhost:8001/login?error=session_expired");
    expect(userCreate).not.toHaveBeenCalled();
    expect(deviceCreate).not.toHaveBeenCalled();
  });

  it("binds the exchange code to the browser that started the sign-in", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/naver/callback?code=abc&state=${encodeURIComponent(naverState())}`,
    });
    const code = new URL(res.headers.location as string).searchParams.get("code") ?? "";
    expect(exchangeCodes.get(code)?.binding).toBe("A".repeat(43));
  });

  it("signs a returning identity straight in without creating anything", async () => {
    identityFindUnique.mockResolvedValue({
      id: "i1",
      userId: "u1",
      provider: "naver",
      subject: "naver-uid-1",
      email: "user@naver.com",
    });
    userFindUnique.mockResolvedValue(USER_ROW);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/naver/callback?code=abc&state=${encodeURIComponent(naverState())}`,
    });
    expect(res.headers.location).toContain("/auth/callback?code=");
    expect(userCreate).not.toHaveBeenCalled();
    expect(welcomeEmail).not.toHaveBeenCalled();
  });

  it("refuses to attach an unverified (non-@naver.com) email to an existing account", async () => {
    naverProfile.mockResolvedValue({ id: "naver-uid-2", email: "victim@gmail.com" });
    userFindUnique.mockResolvedValue({ ...USER_ROW, id: "victim", email: "victim@gmail.com" });
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/naver/callback?code=abc&state=${encodeURIComponent(naverState())}`,
    });
    expect(res.headers.location).toBe("http://localhost:8001/login?error=naver_email_in_use");
    expect(userCreate).not.toHaveBeenCalled();
    expect(identityUpsert).not.toHaveBeenCalled();
  });

  it("refuses to pre-claim an unclaimed unverified email", async () => {
    naverProfile.mockResolvedValue({ id: "naver-uid-2", email: "someone@gmail.com" });
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/naver/callback?code=abc&state=${encodeURIComponent(naverState())}`,
    });
    expect(res.headers.location).toBe("http://localhost:8001/login?error=naver_email_unverified");
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("never resolves into the shared demo account", async () => {
    identityFindUnique.mockResolvedValue({
      id: "i-demo",
      userId: "demo-user",
      provider: "naver",
      subject: "naver-uid-1",
      email: "user@naver.com",
    });
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/naver/callback?code=abc&state=${encodeURIComponent(naverState())}`,
    });
    expect(res.headers.location).toBe("http://localhost:8001/login?error=naver_failed");
    expect(deviceCreate).not.toHaveBeenCalled();
  });

  it("rejects a session-shaped state (real userId instead of the __login__ placeholder)", async () => {
    // Registration doesn't enforce email format, so a session JWT could carry
    // the marker string as its email — the userId placeholder check is what
    // keeps such a token from standing in as a state.
    const sessionShapedState = signToken({ userId: "u1", email: "__naver_login__" }, "10m");
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/naver/callback?code=abc&state=${encodeURIComponent(sessionShapedState)}`,
    });
    expect(res.headers.location).toBe("http://localhost:8001/login?error=naver_failed");
  });

  it("rejects a state minted for a different flow", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/naver/callback?code=abc&state=${encodeURIComponent(naverState("__google_login__"))}`,
    });
    expect(res.headers.location).toBe("http://localhost:8001/login?error=naver_failed");
  });

  it("routes consent denial to a friendly login error", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/naver/callback?error=access_denied",
    });
    expect(res.headers.location).toBe("http://localhost:8001/login?error=naver_denied");
  });

  it("enforces the beta waitlist on the third signup door too", async () => {
    process.env.BETA_GATE_ENABLED = "true";
    waitlistFindUnique.mockResolvedValue({ status: "PENDING" });
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/naver/callback?code=abc&state=${encodeURIComponent(naverState())}`,
    });
    expect(res.headers.location).toBe("http://localhost:8001/login?error=invite_only");
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("a new Naver account starts on FREE whatever the BETA_* flags say", async () => {
    // Founder decision 2026-10-24: Pro is paid. Gate approval and the retired
    // auto-pro flags must not set a plan on the new row.
    process.env.BETA_GATE_ENABLED = "true";
    process.env.BETA_AUTO_PRO_ENABLED = "true";
    process.env.BETA_AUTO_PRO_LIMIT = "50";
    waitlistFindUnique.mockResolvedValue({ status: "APPROVED" });
    userCount.mockClear();
    try {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: `/api/auth/naver/callback?code=abc&state=${encodeURIComponent(naverState())}`,
      });
      expect(res.headers.location).toMatch(/\/auth\/callback\?code=/);
      expect(userCreate).toHaveBeenCalledTimes(1);
      const { data } = userCreate.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(data).not.toHaveProperty("plan");
      expect(data).not.toHaveProperty("betaProGrantedAt");
      expect(userCount).not.toHaveBeenCalled();
    } finally {
      delete process.env.BETA_AUTO_PRO_ENABLED;
      delete process.env.BETA_AUTO_PRO_LIMIT;
    }
  });
});

describe("Apple login flow (form_post callback)", () => {
  beforeEach(() => {
    process.env.APPLE_LOGIN_ENABLED = "true";
  });

  it("accepts Apple's urlencoded POST callback and creates the relay-email user", async () => {
    const app = await buildApp();
    const state = signToken(
      {
        userId: "__login__",
        email: "__apple_login__",
        lb: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
      "10m",
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/apple/callback",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `code=abc&state=${encodeURIComponent(state)}`,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("/auth/callback?code=");
    expect(userCreate).toHaveBeenCalledTimes(1);
    const createArgs = userCreate.mock.calls[0][0] as {
      data: { email: string; identities: { create: { provider: string } } };
    };
    expect(createArgs.data.email).toBe("relay@privaterelay.appleid.com");
    expect(createArgs.data.identities.create.provider).toBe("apple");
  });

  it("a new Apple account starts on FREE with the retired auto-pro flag still set", async () => {
    process.env.BETA_AUTO_PRO_ENABLED = "true";
    try {
      const app = await buildApp();
      const state = signToken(
        {
          userId: "__login__",
          email: "__apple_login__",
          lb: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
        "10m",
      );
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/apple/callback",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: `code=abc&state=${encodeURIComponent(state)}`,
      });
      expect(res.headers.location).toContain("/auth/callback?code=");
      const { data } = userCreate.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(data).not.toHaveProperty("plan");
      expect(data).not.toHaveProperty("betaProGrantedAt");
    } finally {
      delete process.env.BETA_AUTO_PRO_ENABLED;
    }
  });

  // `apple_failed` covered four unrelated causes, so a broken deployment and a
  // user who declined to share an email produced the same URL and the same
  // toast. Diagnosing it required server logs the operator may not have.
  it.each([
    [
      "config",
      { ok: false, reason: "config" as const, detail: "APPLE_KEY_ID missing" },
      "apple_config",
    ],
    [
      "exchange",
      { ok: false, reason: "exchange" as const, detail: "invalid_client" },
      "apple_exchange",
    ],
  ])("reports a %s failure in the redirect", async (_label, exchangeResult, expected) => {
    appleExchange.mockResolvedValue(exchangeResult as never);
    const app = await buildApp();
    const state = signToken(
      {
        userId: "__login__",
        email: "__apple_login__",
        lb: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
      "10m",
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/apple/callback",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `code=abc&state=${encodeURIComponent(state)}`,
    });

    expect(res.headers.location).toBe(`http://localhost:8001/login?error=${expected}`);
  });

  it.each([
    ["token", "apple_token"],
    ["claims", "apple_claims"],
  ])("reports an id_token %s failure in the redirect", async (reason, expected) => {
    appleVerify.mockResolvedValue({ ok: false, reason } as never);
    const app = await buildApp();
    const state = signToken(
      {
        userId: "__login__",
        email: "__apple_login__",
        lb: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
      "10m",
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/apple/callback",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `code=abc&state=${encodeURIComponent(state)}`,
    });

    expect(res.headers.location).toBe(`http://localhost:8001/login?error=${expected}`);
  });

  it("attaches a verified Apple identity to the existing owner of the email", async () => {
    appleVerify.mockResolvedValue({
      ok: true,
      claims: { sub: "apple-sub-9", email: "user@naver.com", emailVerified: true },
    });
    userFindUnique.mockImplementation(async (args: { where: { email?: string; id?: string } }) =>
      args.where.email === "user@naver.com" || args.where.id === "u1" ? USER_ROW : null,
    );
    const app = await buildApp();
    const state = signToken(
      {
        userId: "__login__",
        email: "__apple_login__",
        lb: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
      "10m",
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/apple/callback",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `code=abc&state=${encodeURIComponent(state)}`,
    });
    expect(res.headers.location).toContain("/auth/callback?code=");
    expect(identityUpsert).toHaveBeenCalledTimes(1);
    expect(userCreate).not.toHaveBeenCalled();
  });
});

describe("GET /api/auth/me hasAnyMailSource", () => {
  it("counts a linked/IMAP inbox as a mail source even without Google", async () => {
    userFindUnique.mockResolvedValue(USER_ROW);
    linkedCount.mockResolvedValue(1);
    const app = await buildApp();
    const token = signToken({ userId: "u1", email: "user@naver.com" });
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.hasAnyMailSource).toBe(true);
    expect(res.json().user.googleConnected).toBe(false);
  });

  it("is false with neither Google nor a linked inbox", async () => {
    userFindUnique.mockResolvedValue(USER_ROW);
    linkedCount.mockResolvedValue(0);
    const app = await buildApp();
    const token = signToken({ userId: "u1", email: "user@naver.com" });
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json().user.hasAnyMailSource).toBe(false);
  });
});
