/**
 * D5b characterisation: every branch of GET /api/auth/google/callback as main
 * has it, pinned before the Drive link branch is added (the plan, D5b: "a
 * characterisation test pinning the four existing auth URLs and the callback's
 * existing branches to main"). Each case pins where the browser lands, whether
 * the code was exchanged, and which table was written, so the new branch can
 * be shown to change nothing else.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const google = vi.hoisted(() => ({
  getToken: vi.fn(),
  getGoogleUserInfo: vi.fn(),
  registerGmailWatch: vi.fn(async () => ({})),
}));

vi.mock("../mail/gmail.js", () => ({
  getAuthUrl: vi.fn(() => "https://example.com/oauth"),
  getLoginAuthUrl: vi.fn(() => "https://example.com/oauth-login"),
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

import { signToken } from "../auth.js";
import {
  keepIfOnlyMailSource,
  mayConnectMailAccount,
} from "../billing/mail-account-entitlement.js";
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
      { userId: "nonce-1", email: marker, ...extra } as Parameters<typeof signToken>[0],
      "10m",
    ),
  )}`;

const NO_ACCESS_TOKEN = { tokens: { refresh_token: "rt" } };

const withState = (marker: string, userId = "u1") =>
  `code=abc&state=${encodeURIComponent(signToken({ userId, email: marker }, "10m"))}`;

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

describe("each marker's branch", () => {
  it("__link_calendar__ exchanges the code and writes one linked calendar", async () => {
    const res = await callback(withState("__link_calendar__"));
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${WEB}/calendar?linked=success`);
    expect(google.getToken).toHaveBeenCalledWith("abc");
    expect(writes()).toEqual({ userToken: 0, linkedCalendarAccount: 1, linkedInboxAccount: 0 });
  });

  it("__link_inbox__ exchanges the code and writes one linked inbox", async () => {
    const res = await callback(withState("__link_inbox__"));
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${WEB}/settings?inbox=success`);
    expect(google.getToken).toHaveBeenCalledWith("abc");
    expect(writes()).toEqual({ userToken: 0, linkedCalendarAccount: 0, linkedInboxAccount: 1 });
  });

  it("__google_login__ signs in through a one-time code and stores no Google token", async () => {
    const res = await callback(withState("__google_login__", "ignored"));
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(new RegExp(`^${WEB}/auth/callback\\?code=`));
    expect(google.getToken).toHaveBeenCalledWith("abc");
    expect(writes()).toEqual({ userToken: 0, linkedCalendarAccount: 0, linkedInboxAccount: 0 });
  });

  it("__google_login_desktop__ answers the desktop hand-off page", async () => {
    const res = await callback(withState("__google_login_desktop__", "ignored"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(google.getToken).toHaveBeenCalledWith("abc");
    expect(writes()).toEqual({ userToken: 0, linkedCalendarAccount: 0, linkedInboxAccount: 0 });
  });

  it("__oauth_state__ stores the primary grant and lands on settings", async () => {
    const res = await callback(withState("__oauth_state__"));
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${WEB}/settings?google=connected`);
    expect(google.getToken).toHaveBeenCalledWith("abc");
    expect(writes()).toEqual({ userToken: 1, linkedCalendarAccount: 0, linkedInboxAccount: 0 });
  });

  it("any other marker is exchanged and then refused with 400, writing nothing", async () => {
    const res = await callback(withState("__some_other_marker__"));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Invalid OAuth state" });
    expect(google.getToken).toHaveBeenCalledWith("abc");
    expect(writes()).toEqual({ userToken: 0, linkedCalendarAccount: 0, linkedInboxAccount: 0 });
  });

  it("a failed exchange answers the generic 500, never the library's message", async () => {
    google.getToken.mockRejectedValue(new Error("internal-host.example: invalid_grant"));
    const res = await callback(withState("__oauth_state__"));
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "Google authorization failed. Please try again." });
    expect(writes()).toEqual({ userToken: 0, linkedCalendarAccount: 0, linkedInboxAccount: 0 });
  });

  it("a failed exchange on a link lands on the same 500", async () => {
    google.getToken.mockRejectedValue(new Error("boom"));
    const res = await callback(withState("__link_calendar__"));
    expect(res.statusCode).toBe(500);
    expect(writes()).toEqual({ userToken: 0, linkedCalendarAccount: 0, linkedInboxAccount: 0 });
  });
});

describe("the calendar link's other outcomes", () => {
  it("no access token: failed, nothing written", async () => {
    google.getToken.mockResolvedValue(NO_ACCESS_TOKEN);
    const res = await callback(withState("__link_calendar__"));
    expect(res.headers.location).toBe(`${WEB}/calendar?linked=failed`);
    expect(google.getGoogleUserInfo).not.toHaveBeenCalled();
    expect(writes()).toEqual({ userToken: 0, linkedCalendarAccount: 0, linkedInboxAccount: 0 });
  });

  it("an unverified address: unverified, nothing written", async () => {
    google.getGoogleUserInfo.mockResolvedValue({ email: "x@example.com", verified_email: false });
    const res = await callback(withState("__link_calendar__"));
    expect(res.headers.location).toBe(`${WEB}/calendar?linked=unverified`);
    expect(writes()).toEqual({ userToken: 0, linkedCalendarAccount: 0, linkedInboxAccount: 0 });
  });

  it("a user who no longer exists: failed, nothing written", async () => {
    db.user.findUnique.mockResolvedValue(null);
    const res = await callback(withState("__link_calendar__"));
    expect(res.headers.location).toBe(`${WEB}/calendar?linked=failed`);
    expect(writes()).toEqual({ userToken: 0, linkedCalendarAccount: 0, linkedInboxAccount: 0 });
  });

  it("the user's own primary address: self, on settings, nothing written", async () => {
    google.getGoogleUserInfo.mockResolvedValue({
      email: " Owner@Example.com",
      verified_email: true,
    });
    const res = await callback(withState("__link_calendar__"));
    expect(res.headers.location).toBe(`${WEB}/settings?inbox=self`);
    expect(writes()).toEqual({ userToken: 0, linkedCalendarAccount: 0, linkedInboxAccount: 0 });
  });
});

describe("the inbox link's other outcomes", () => {
  it("no access token: failed, nothing written", async () => {
    google.getToken.mockResolvedValue(NO_ACCESS_TOKEN);
    const res = await callback(withState("__link_inbox__"));
    expect(res.headers.location).toBe(`${WEB}/settings?inbox=failed`);
    expect(writes()).toEqual({ userToken: 0, linkedCalendarAccount: 0, linkedInboxAccount: 0 });
  });

  it("an unverified address: unverified, nothing written", async () => {
    google.getGoogleUserInfo.mockResolvedValue({ email: "x@example.com", verified_email: false });
    const res = await callback(withState("__link_inbox__"));
    expect(res.headers.location).toBe(`${WEB}/settings?inbox=unverified`);
    expect(writes()).toEqual({ userToken: 0, linkedCalendarAccount: 0, linkedInboxAccount: 0 });
  });

  it("a user who no longer exists: failed, nothing written", async () => {
    db.user.findUnique.mockResolvedValue(null);
    const res = await callback(withState("__link_inbox__"));
    expect(res.headers.location).toBe(`${WEB}/settings?inbox=failed`);
    expect(writes()).toEqual({ userToken: 0, linkedCalendarAccount: 0, linkedInboxAccount: 0 });
  });

  it("a second mailbox without the plan: pro, nothing written", async () => {
    vi.mocked(mayConnectMailAccount).mockResolvedValueOnce(false);
    const res = await callback(withState("__link_inbox__"));
    expect(res.headers.location).toBe(`${WEB}/settings?inbox=pro`);
    expect(writes()).toEqual({ userToken: 0, linkedCalendarAccount: 0, linkedInboxAccount: 0 });
  });

  it("a parallel first connect won meanwhile: pro, after the check-after-insert", async () => {
    vi.mocked(keepIfOnlyMailSource).mockResolvedValueOnce(false);
    const res = await callback(withState("__link_inbox__"));
    expect(res.headers.location).toBe(`${WEB}/settings?inbox=pro`);
    expect(writes()).toEqual({ userToken: 0, linkedCalendarAccount: 0, linkedInboxAccount: 1 });
  });

  it("the tenth Google inbox already linked: limit, nothing written", async () => {
    db.linkedInboxAccount.count.mockResolvedValueOnce(10);
    const res = await callback(withState("__link_inbox__"));
    expect(res.headers.location).toBe(`${WEB}/settings?inbox=limit`);
    expect(db.linkedInboxAccount.count).toHaveBeenCalledWith({
      where: { userId: "u1", provider: "GOOGLE" },
    });
    expect(writes()).toEqual({ userToken: 0, linkedCalendarAccount: 0, linkedInboxAccount: 0 });
  });

  it("nine linked: the tenth is allowed", async () => {
    db.linkedInboxAccount.count.mockResolvedValueOnce(9);
    const res = await callback(withState("__link_inbox__"));
    expect(res.headers.location).toBe(`${WEB}/settings?inbox=success`);
  });
});

describe("the login's other branches", () => {
  it("no access token: google_failed", async () => {
    google.getToken.mockResolvedValue(NO_ACCESS_TOKEN);
    const res = await callback(withState("__google_login__", "ignored"));
    expect(res.headers.location).toBe(`${WEB}/login?error=google_failed`);
  });

  it("an unverified address: google_unverified, no user looked up", async () => {
    google.getGoogleUserInfo.mockResolvedValue({ email: "x@example.com", verified_email: false });
    const res = await callback(withState("__google_login__", "ignored"));
    expect(res.headers.location).toBe(`${WEB}/login?error=google_unverified`);
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

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
