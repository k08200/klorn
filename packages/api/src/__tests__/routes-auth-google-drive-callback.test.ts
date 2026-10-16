/**
 * D5b: the one branch the Google OAuth callback gains. A state signed with the
 * `__link_drive__` marker (only the dark POST /api/drive/google/link signs one)
 * is handed to `completeGoogleDriveLink` after the state check and BEFORE the
 * callback's own code exchange: the callback never exchanges a drive code
 * itself, and with the flag off nobody does. Every other branch is pinned by
 * routes-auth-google-callback-pinned.test.ts.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
}));
vi.mock("../db.js", () => ({ prisma: db, db }));

import { signToken } from "../auth.js";
import { completeGoogleDriveLink } from "../drive/providers/google-auth.js";
import { authRoutes } from "../routes/auth.js";

const WEB = "http://localhost:8001";
const GRANTED =
  "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file";

async function callback(marker = "__link_drive__") {
  const state = signToken({ userId: "u1", email: marker }, "10m");
  const app = Fastify();
  await app.register(authRoutes, { prefix: "/api/auth" });
  const res = await app.inject({
    method: "GET",
    url: `/api/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`,
  });
  await app.close();
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
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

describe("the __link_drive__ branch", () => {
  it.each([
    "success",
    "failed",
    "unverified",
    "scope-missing",
    "limit",
  ])("hands the code and the signed user over, and lands on /files?drive=%s", async (outcome) => {
    drive.override = async () => outcome;
    const res = await callback();
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${WEB}/files?drive=${outcome}`);
    expect(vi.mocked(completeGoogleDriveLink)).toHaveBeenCalledWith({ code: "abc", userId: "u1" });
    // The callback's own exchange is after the branch: it never ran.
    expect(google.getToken).not.toHaveBeenCalled();
  });

  it.each([
    "DRIVE_ENABLED",
    "GOOGLE_DRIVE_ENABLED",
  ])("with %s off nobody exchanges the code and nothing is written", async (flag) => {
    vi.stubEnv(flag, "false");
    const res = await callback();
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${WEB}/files?drive=failed`);
    expect(google.getToken).not.toHaveBeenCalled();
    expect(db.linkedDriveAccount.upsert).not.toHaveBeenCalled();
  });

  it("with both flags on the link is completed and only the drive table is written", async () => {
    const res = await callback();
    expect(res.headers.location).toBe(`${WEB}/files?drive=success`);
    expect(google.getToken).toHaveBeenCalledTimes(1);
    expect(db.linkedDriveAccount.upsert).toHaveBeenCalledTimes(1);
    expect(db.userToken.upsert).not.toHaveBeenCalled();
    expect(db.linkedCalendarAccount.upsert).not.toHaveBeenCalled();
    expect(db.linkedInboxAccount.upsert).not.toHaveBeenCalled();
  });

  it("no other marker reaches the drive completion", async () => {
    for (const marker of ["__link_calendar__", "__link_inbox__", "__oauth_state__", "__x__"]) {
      await callback(marker);
    }
    expect(vi.mocked(completeGoogleDriveLink)).not.toHaveBeenCalled();
  });
});
