/**
 * Characterisation pins of GET /api/auth/google/callback for what
 * routes-auth-google-link-pinned.test.ts (#1451) does not pin: the checks made
 * before the state is read, the desktop login's success page, and the login's
 * `attr` and `appScheme` sub-branches. Recorded against main before D5b
 * (2026-10-15) and unchanged since; the account-link markers park their code
 * now, and are pinned there and in routes-auth-link-csrf.test.ts.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const google = vi.hoisted(() => ({
  getToken: vi.fn(),
  getLoginAuthUrl: vi.fn((_state: string) => "https://example.com/oauth-login"),
  getGoogleUserInfo: vi.fn(),
  registerGmailWatch: vi.fn(async () => ({})),
}));

vi.mock("../mail/gmail.js", () => ({
  getAuthUrl: vi.fn(() => "https://example.com/oauth"),
  getLoginAuthUrl: google.getLoginAuthUrl,
  getLinkInboxAuthUrl: vi.fn(() => "https://example.com/oauth-link-inbox"),
  getLinkCalendarAuthUrl: vi.fn(() => "https://example.com/oauth-link-calendar"),
  getAuthedClient: vi.fn(),
  getGoogleConnectionStatus: vi.fn(async () => ({ connected: false })),
  isGoogleAuthError: vi.fn(() => false),
  markGoogleTokenForReconnect: vi.fn(async () => {}),
  getGoogleUserInfo: google.getGoogleUserInfo,
  getOAuth2Client: vi.fn(() => ({ getToken: google.getToken })),
  registerGmailWatch: google.registerGmailWatch,
}));
vi.mock("../billing/mail-account-entitlement.js", () => ({
  canConnectNewMailAccount: vi.fn(async () => true),
  findOwnedLinkedAccount: vi.fn(async () => null),
  keepIfOnlyMailSource: vi.fn(async () => true),
  keepPrimaryGoogleIfOnlyMailSource: vi.fn(async () => true),
  mayConnectMailAccount: vi.fn(async () => true),
  mayConnectPrimaryGoogle: vi.fn(async () => true),
  requireMailLinkStart: vi.fn(() => async () => {}),
  SECOND_MAIL_ACCOUNT_REFUSAL: { error: "second mail account" },
}));
vi.mock("../mail/email.js", () => ({
  sendVerificationEmail: vi.fn(async () => true),
  sendPasswordResetEmail: vi.fn(async () => true),
}));
vi.mock("../mail/email-sync.js", () => ({
  syncLinkedInboxesForUser: vi.fn(async () => ({ newCount: 0 })),
}));
vi.mock("../notify/welcome-email.js", () => ({ maybeSendWelcomeEmail: vi.fn(async () => {}) }));
vi.mock("../crypto-tokens.js", () => ({
  encryptToken: (t: string) => `enc:${t}`,
  encryptOptional: (t?: string | null) => (t ? `enc:${t}` : null),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const USER = {
  id: "u1",
  email: "owner@example.com",
  name: "Owner",
  emailVerified: true,
  passwordHash: null,
  plan: "PRO",
  role: "USER",
};

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), update: vi.fn(async () => ({})), create: vi.fn() },
  userToken: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({ id: "tok" })) },
  linkedCalendarAccount: { upsert: vi.fn(async () => ({ id: "cal" })) },
  linkedInboxAccount: {
    count: vi.fn(async () => 0),
    upsert: vi.fn(async () => ({ id: "inbox" })),
  },
  automationConfig: { upsert: vi.fn(async () => ({})) },
  device: {
    create: vi.fn(async () => ({ id: "d1" })),
    findMany: vi.fn(async () => []),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  },
  waitlist: { findUnique: vi.fn(async () => null) },
}));

vi.mock("../db.js", () => ({ prisma: db, db }));

import { createHash } from "node:crypto";
import { signToken, verifyToken } from "../auth.js";
import { authRoutes } from "../routes/auth.js";

const WEB = "http://localhost:8001";

async function callback(query: string) {
  const app = Fastify();
  await app.register(authRoutes, { prefix: "/api/auth" });
  const res = await app.inject({ method: "GET", url: `/api/auth/google/callback?${query}` });
  await app.close();
  return res;
}

/** A state carrying the login's optional fields (attr, appScheme), as the login start signs them. */
const withLoginState = (marker: string, extra: { attr?: string; appScheme?: string }) =>
  `code=abc&state=${encodeURIComponent(
    signToken(
      // A web sign-in's state carries its browser's login binding.
      {
        userId: "nonce-1",
        email: marker,
        lb: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        ...extra,
      } as Parameters<typeof signToken>[0],
      "10m",
    ),
  )}`;

const withState = (marker: string, userId = "u1") =>
  `code=abc&state=${encodeURIComponent(signToken({ userId, email: marker, lb: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, "10m"))}`;

/** Every table write the callback can issue, by model, so a case can say "nothing else". */
function writes(): Record<string, number> {
  return {
    userToken: db.userToken.upsert.mock.calls.length,
    linkedCalendarAccount: db.linkedCalendarAccount.upsert.mock.calls.length,
    linkedInboxAccount: db.linkedInboxAccount.upsert.mock.calls.length,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.WEB_URL;
  google.getToken.mockResolvedValue({
    tokens: { access_token: "at", refresh_token: "rt", expiry_date: Date.now() + 3_600_000 },
  });
  google.getGoogleUserInfo.mockResolvedValue({
    email: "Linked@Example.com",
    verified_email: true,
    name: "Linked",
    picture: "",
  });
  db.user.findUnique.mockResolvedValue(USER);
  db.userToken.findUnique.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("before the state is read", () => {
  it("a provider error lands on the login page, nothing exchanged", async () => {
    const res = await callback("error=access_denied");
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${WEB}/login?error=google_denied`);
    expect(google.getToken).not.toHaveBeenCalled();
  });

  it("no code is a 400", async () => {
    const res = await callback("state=x");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Missing authorization code" });
    expect(google.getToken).not.toHaveBeenCalled();
  });

  it("no state is a 400", async () => {
    const res = await callback("code=abc");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Missing state parameter" });
    expect(google.getToken).not.toHaveBeenCalled();
  });

  it("a state the server did not sign is a 400", async () => {
    const res = await callback("code=abc&state=not-a-jwt");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Invalid or expired OAuth state" });
    expect(google.getToken).not.toHaveBeenCalled();
  });
});

describe("the desktop login", () => {
  it("__google_login_desktop__ answers the desktop hand-off page", async () => {
    const res = await callback(withState("__google_login_desktop__", "ignored"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(google.getToken).toHaveBeenCalledWith("abc");
    expect(writes()).toEqual({ userToken: 0, linkedCalendarAccount: 0, linkedInboxAccount: 0 });
  });
});

describe("the login's attr and appScheme sub-branches", () => {
  it("attr: a NEW user is created with the signed attribution", async () => {
    db.user.findUnique.mockResolvedValue(null);
    db.user.create.mockResolvedValue({ ...USER, id: "new-1", email: "linked@example.com" });
    const res = await callback(withLoginState("__google_login__", { attr: "hn-launch" }));
    expect(res.headers.location).toMatch(new RegExp(`^${WEB}/auth/callback\\?code=`));
    expect(db.user.findUnique).toHaveBeenCalledWith({ where: { email: "linked@example.com" } });
    expect(db.user.create).toHaveBeenCalledTimes(1);
    expect(db.user.create.mock.calls[0]?.[0]).toMatchObject({
      data: { email: "linked@example.com", emailVerified: true, attribution: "hn-launch" },
    });
  });

  it("no attr: a new user is created without an attribution", async () => {
    db.user.findUnique.mockResolvedValue(null);
    db.user.create.mockResolvedValue({ ...USER, id: "new-1", email: "linked@example.com" });
    await callback(withLoginState("__google_login__", {}));
    const data = (db.user.create.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data).not.toHaveProperty("attribution");
  });

  it("attr: an EXISTING user is never re-attributed", async () => {
    db.user.findUnique.mockResolvedValue({ ...USER, email: "linked@example.com" });
    await callback(withLoginState("__google_login__", { attr: "hn-launch" }));
    expect(db.user.create).not.toHaveBeenCalled();
    for (const call of db.user.update.mock.calls as unknown as Array<[{ data: object }]>) {
      expect(call[0].data).not.toHaveProperty("attribution");
    }
  });

  it("appScheme on the allowlist: the deep-link hand-off page, no-store, a one-time code", async () => {
    const res = await callback(withLoginState("__google_login_desktop__", { appScheme: "klorn" }));
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toMatch(/klorn:\/\/oauth-callback\?code=[0-9a-f]{40}/);
    expect(res.body).toContain("Klorn Desktop is finishing sign-in.");
    expect(res.body).not.toContain("Return to the Klorn desktop app.");
  });

  it("appScheme off the allowlist: the legacy page, no deep link", async () => {
    const res = await callback(withLoginState("__google_login_desktop__", { appScheme: "evil" }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Return to the Klorn desktop app.");
    expect(res.body).not.toContain("oauth-callback");
    expect(res.headers["cache-control"]).toBeUndefined();
  });
});

describe("login CSRF: a web sign-in completes only in the browser that started it", () => {
  // The browser keeps a nonce to itself and sends only its SHA-256 (the
  // binding) through the sign-in; the exchange code redeems with the nonce.
  const nonce = "browser-nonce-0123456789-abcdefghijklmnop";
  const binding = createHash("sha256").update(nonce).digest("base64url");
  const boundState = (lb?: string) =>
    `code=abc&state=${encodeURIComponent(
      signToken({ userId: "__login__", email: "__google_login__", ...(lb ? { lb } : {}) }, "10m"),
    )}`;

  async function withApp<T>(run: (app: ReturnType<typeof Fastify>) => Promise<T>): Promise<T> {
    const app = Fastify();
    await app.register(authRoutes, { prefix: "/api/auth" });
    try {
      return await run(app);
    } finally {
      await app.close();
    }
  }

  it("refuses to start a web sign-in that names no browser", async () => {
    const res = await withApp((app) =>
      app.inject({ method: "GET", url: "/api/auth/google/login" }),
    );
    expect(res.headers.location).toBe(`${WEB}/login?error=session_expired`);
  });

  it("carries the browser's binding to Google in the signed state", async () => {
    const res = await withApp((app) =>
      app.inject({ method: "GET", url: `/api/auth/google/login?lb=${binding}` }),
    );
    expect(res.statusCode).toBe(302);
    expect(google.getLoginAuthUrl).toHaveBeenCalledTimes(1);
    const state = (google.getLoginAuthUrl.mock.calls[0] as [string])[0];
    expect(verifyToken(state)).toMatchObject({ email: "__google_login__", lb: binding });
  });

  it("refuses a callback whose state names no browser, before Google's code is spent", async () => {
    const res = await callback(boundState());
    expect(res.headers.location).toBe(`${WEB}/login?error=session_expired`);
    expect(google.getToken).not.toHaveBeenCalled();
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it("redeems the exchange code only with the browser's nonce", async () => {
    await withApp(async (app) => {
      const cb = await app.inject({
        method: "GET",
        url: `/api/auth/google/callback?${boundState(binding)}`,
      });
      const code = new URL(cb.headers.location as string).searchParams.get("code");
      expect(code).toBeTruthy();

      // Another browser (the victim's, handed the attacker's code): refused,
      // and the code is gone, so it cannot be retried with a guess.
      const stolen = await app.inject({
        method: "POST",
        url: "/api/auth/exchange-code",
        payload: { code, nonce: "someone-elses-nonce" },
      });
      expect(stolen.statusCode).toBe(403);
      const again = await app.inject({
        method: "POST",
        url: "/api/auth/exchange-code",
        payload: { code, nonce },
      });
      expect(again.statusCode).toBe(404);
    });
  });

  it("hands the session to the browser that started the sign-in", async () => {
    await withApp(async (app) => {
      const cb = await app.inject({
        method: "GET",
        url: `/api/auth/google/callback?${boundState(binding)}`,
      });
      const code = new URL(cb.headers.location as string).searchParams.get("code");
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/exchange-code",
        payload: { code, nonce },
      });
      expect(res.statusCode).toBe(200);
      expect(typeof res.json().token).toBe("string");
    });
  });

  it("refuses a bound code redeemed with no nonce at all", async () => {
    await withApp(async (app) => {
      const cb = await app.inject({
        method: "GET",
        url: `/api/auth/google/callback?${boundState(binding)}`,
      });
      const code = new URL(cb.headers.location as string).searchParams.get("code");
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/exchange-code",
        payload: { code },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
