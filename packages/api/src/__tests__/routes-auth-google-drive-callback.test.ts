/**
 * D5b on the link binding of #1451: a state signed with the `__link_drive__`
 * marker (only the dark POST /api/drive/google/link signs one) makes the Google
 * callback PARK the code, never exchange it; POST /api/auth/link/complete hands
 * it to `completeGoogleDriveLink` for the session that started the flow, and
 * answers `{ next: "/files?drive=<outcome>" }`. While the drive is off the
 * callback parks nothing and the completion exchanges nothing.
 * routes-auth-link-csrf.test.ts holds the cross-session cases for this marker;
 * routes-auth-google-link-pinned.test.ts pins the other link markers.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetParkThrottleForTests } from "../auth/park-throttle.js";
import { _resetPendingLinksForTests, pendingLinkCount } from "../auth/pending-links.js";
import { callbackThenComplete, parkedHandle } from "./helpers/link-complete.js";

const google = vi.hoisted(() => ({
  getToken: vi.fn(),
  getGoogleUserInfo: vi.fn(),
}));
const drive = vi.hoisted(() => ({
  override: null as null | ((params: { code: string; userId: string }) => Promise<string>),
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
  registerGmailWatch: vi.fn(async () => ({})),
}));
vi.mock("../drive/providers/google-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../drive/providers/google-auth.js")>();
  return {
    ...actual,
    completeGoogleDriveLink: vi.fn(async (params: { code: string; userId: string }) =>
      drive.override ? drive.override(params) : actual.completeGoogleDriveLink(params),
    ),
  };
});
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
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  userToken: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({ id: "tok" })) },
  linkedCalendarAccount: { upsert: vi.fn(async () => ({ id: "cal" })) },
  linkedInboxAccount: { count: vi.fn(async () => 0), upsert: vi.fn(async () => ({ id: "i" })) },
  linkedDriveAccount: {
    findFirst: vi.fn(async () => null),
    count: vi.fn(async () => 0),
    upsert: vi.fn(async () => ({ id: "drv-1" })),
  },
  device: {
    findUnique: vi.fn(async () => ({ id: "d1", lastActiveAt: new Date() })),
    update: vi.fn(async () => ({})),
  },
}));
vi.mock("../db.js", () => ({ prisma: db, db }));

import { signToken } from "../auth.js";
import { completeGoogleDriveLink } from "../drive/providers/google-auth.js";
import { authRoutes } from "../routes/auth.js";
import { linkCompleteRoutes } from "../routes/link-complete.js";

const WEB = "http://localhost:8001";
const U1 = { authorization: `Bearer ${signToken({ userId: "u1", email: "u1@example.com" })}` };
const GRANTED =
  "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file";

async function buildApp() {
  const app = Fastify();
  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(linkCompleteRoutes(), { prefix: "/api/auth" });
  return app;
}

const callbackUrl = (marker = "__link_drive__") =>
  `/api/auth/google/callback?code=abc&state=${encodeURIComponent(
    signToken({ userId: "u1", email: marker }, "10m"),
  )}`;

/** The callback alone. */
async function callback(marker = "__link_drive__") {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: callbackUrl(marker) });
  await app.close();
  return res;
}

/** The callback, then u1's own completion. */
async function linkAsU1(marker = "__link_drive__") {
  const app = await buildApp();
  const res = await callbackThenComplete(app, callbackUrl(marker), U1);
  await app.close();
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  _resetPendingLinksForTests();
  _resetParkThrottleForTests();
  delete process.env.WEB_URL;
  drive.override = null;
  vi.stubEnv("DRIVE_ENABLED", "true");
  vi.stubEnv("GOOGLE_DRIVE_ENABLED", "true");
  google.getToken.mockResolvedValue({
    tokens: { access_token: "at", refresh_token: "rt", scope: GRANTED },
  });
  google.getGoogleUserInfo.mockResolvedValue({ email: "Me@Example.com", verified_email: true });
  db.user.findUnique.mockResolvedValue({ id: "u1", plan: "PRO", role: "USER" });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("the __link_drive__ callback parks, the completion finishes", () => {
  it("the callback parks the code without exchanging it or calling the drive completion", async () => {
    const res = await callback();
    parkedHandle(res);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(pendingLinkCount()).toBe(1);
    expect(google.getToken).not.toHaveBeenCalled();
    expect(vi.mocked(completeGoogleDriveLink)).not.toHaveBeenCalled();
  });

  it.each([
    "success",
    "failed",
    "unverified",
    "scope-missing",
    "limit",
  ])("u1's completion hands over the code and u1, and answers next=/files?drive=%s", async (outcome) => {
    drive.override = async () => outcome;
    const res = await linkAsU1();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ next: `/files?drive=${outcome}` });
    expect(vi.mocked(completeGoogleDriveLink)).toHaveBeenCalledWith({ code: "abc", userId: "u1" });
  });

  it.each([
    "DRIVE_ENABLED",
    "GOOGLE_DRIVE_ENABLED",
  ])("with %s off the callback parks nothing and lands on /files?drive=failed", async (flag) => {
    vi.stubEnv(flag, "false");
    const res = await callback();
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${WEB}/files?drive=failed`);
    expect(pendingLinkCount()).toBe(0);
    expect(google.getToken).not.toHaveBeenCalled();
    expect(vi.mocked(completeGoogleDriveLink)).not.toHaveBeenCalled();
  });

  it("with both flags on the link is completed and only the drive table is written", async () => {
    const res = await linkAsU1();
    expect(res.json()).toEqual({ next: "/files?drive=success" });
    expect(google.getToken).toHaveBeenCalledTimes(1);
    expect(google.getToken).toHaveBeenCalledWith("abc");
    expect(db.linkedDriveAccount.upsert).toHaveBeenCalledTimes(1);
    expect(db.userToken.upsert).not.toHaveBeenCalled();
    expect(db.linkedCalendarAccount.upsert).not.toHaveBeenCalled();
    expect(db.linkedInboxAccount.upsert).not.toHaveBeenCalled();
  });

  it("no other marker reaches the drive completion", async () => {
    for (const marker of ["__link_calendar__", "__link_inbox__", "__oauth_state__"]) {
      await linkAsU1(marker);
    }
    await callback("__x__");
    expect(vi.mocked(completeGoogleDriveLink)).not.toHaveBeenCalled();
  });
});
