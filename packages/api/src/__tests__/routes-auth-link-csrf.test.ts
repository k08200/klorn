/**
 * Account-link CSRF: an OAuth state was bound only to the user id that started
 * it, so an attacker could start a link, send the consent URL to a victim, and
 * have the callback store the VICTIM's grant on the ATTACKER's account.
 *
 * Now every account-link callback (Google primary connect, Google calendar and
 * inbox links, Outlook inbox and calendar links, the Google Drive link of D5b)
 * parks the authorization code
 * without exchanging it, and POST /api/auth/link/complete finishes the link only
 * for the session of the user who started the flow.
 */

import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetParkThrottleForTests, PARK_LIMIT_PER_IP } from "../auth/park-throttle.js";
import {
  _resetPendingLinksForTests,
  MAX_PENDING_LINKS,
  PENDING_LINK_TTL_MS,
  parkPendingLink,
  pendingLinkCount,
} from "../auth/pending-links.js";
import { signToken } from "../auth.js";
import {
  apiSourceFiles,
  oauthCallbackViolations,
  type SourceFile,
  stateVerifyingHandlers,
} from "./helpers/oauth-callback-guard.js";

const WEB = "https://app.example.com";
const HANDLE_REDIRECT = /^https:\/\/app\.example\.com\/link\/complete#h=([0-9a-f]{64})$/;

const m = vi.hoisted(() => ({
  getToken: vi.fn(),
  exchangeOutlookCode: vi.fn(),
  tokenUpsert: vi.fn(),
  calendarUpsert: vi.fn(),
  inboxUpsert: vi.fn(),
  driveUpsert: vi.fn(),
  captureError: vi.fn(),
}));

const consentUrl = vi.hoisted(
  () => (state: string) => `https://consent.example.com/?state=${state}`,
);

vi.mock("../mail/gmail.js", () => ({
  getAuthUrl: vi.fn(consentUrl),
  getLoginAuthUrl: vi.fn(consentUrl),
  getLinkInboxAuthUrl: vi.fn(consentUrl),
  getLinkCalendarAuthUrl: vi.fn(consentUrl),
  getAuthedClient: vi.fn(),
  getGoogleConnectionStatus: vi.fn(async () => ({ connected: false })),
  isGoogleAuthError: vi.fn(() => false),
  markGoogleTokenForReconnect: vi.fn(async () => {}),
  registerGmailWatch: vi.fn(async () => ({})),
  getGoogleUserInfo: vi.fn(async () => ({ email: "victim@gmail.com", verified_email: true })),
  getOAuth2Client: vi.fn(() => ({
    getToken: m.getToken,
    // The Drive link (D5b) builds its consent URL on the shared client.
    generateAuthUrl: (options: { state: string }) => consentUrl(options.state),
  })),
}));
vi.mock("../mail/outlook-oauth.js", () => ({
  exchangeOutlookCode: m.exchangeOutlookCode,
  fetchOutlookAccountEmail: vi.fn(async () => "victim@outlook.com"),
  getOutlookAuthUrl: vi.fn(consentUrl),
  outlookConfigured: vi.fn(() => true),
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
vi.mock("../sentry.js", () => ({ captureError: m.captureError }));
vi.mock("../billing/mail-account-entitlement.js", () => ({
  SECOND_MAIL_ACCOUNT_REFUSAL: { error: "second", code: "ENTITLEMENT_REQUIRED" },
  canConnectNewMailAccount: vi.fn(async () => true),
  findOwnedLinkedAccount: vi.fn(async () => null),
  keepIfOnlyMailSource: vi.fn(async () => true),
  keepPrimaryGoogleIfOnlyMailSource: vi.fn(async () => true),
  mayConnectMailAccount: vi.fn(async () => true),
  mayConnectPrimaryGoogle: vi.fn(async () => true),
  requireMailLinkStart: vi.fn(() => async () => {}),
}));
vi.mock("../notify/welcome-email.js", () => ({ maybeSendWelcomeEmail: vi.fn(async () => {}) }));
vi.mock("../db.js", () => {
  const user = (id: string) => ({ id, email: `${id}@klorn.test`, plan: "PRO", role: "USER" });
  // A Google LOGIN resolves its user by email; an existing, verified one.
  const byEmail = (email: string) => ({ ...user("login-user"), email, emailVerified: true });
  const prisma = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; email?: string } }) =>
        where.email ? byEmail(where.email) : user(where.id as string),
      ),
    },
    automationConfig: { upsert: vi.fn(async () => ({})) },
    userToken: { findUnique: vi.fn(async () => null), upsert: m.tokenUpsert },
    linkedCalendarAccount: {
      findUnique: vi.fn(async () => null),
      count: vi.fn(async () => 0),
      upsert: m.calendarUpsert,
    },
    linkedInboxAccount: { count: vi.fn(async () => 0), upsert: m.inboxUpsert },
    linkedDriveAccount: {
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
      upsert: m.driveUpsert,
    },
    device: {
      create: vi.fn(async () => ({ id: "d2" })),
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => ({ id: "d1", lastActiveAt: new Date() })),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});

import { authRoutes } from "../routes/auth.js";
import { googleDriveLinkRoutes, googleDriveRoutesEnabled } from "../routes/google-drive-link.js";
import { linkCompleteRoutes } from "../routes/link-complete.js";
import { outlookAuthRoutes } from "../routes/outlook-auth.js";

const gates = vi.hoisted(() => ({ inbox: true, calendar: true }));

async function buildApp() {
  const app = Fastify();
  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(
    outlookAuthRoutes({ gate: () => gates.inbox, calendarGate: () => gates.calendar }),
    { prefix: "/api/auth/outlook" },
  );
  await app.register(
    linkCompleteRoutes({
      outlookInboxGate: () => gates.inbox,
      outlookCalendarGate: () => gates.calendar,
    }),
    { prefix: "/api/auth" },
  );
  await app.register(googleDriveLinkRoutes({ gate: googleDriveRoutesEnabled }), {
    prefix: "/api/drive/google",
  });
  await app.ready();
  return app;
}
type App = Awaited<ReturnType<typeof buildApp>>;

const bearer = (userId: string) => ({
  authorization: `Bearer ${signToken({ userId, email: `${userId}@klorn.test` })}`,
});
const A = bearer("user-a");
const B = bearer("user-b");

interface Flow {
  marker: string;
  start: string;
  callback: string;
  success: string;
  mismatch: string;
  failed: string;
  exchange: () => ReturnType<typeof vi.fn>;
  write: () => ReturnType<typeof vi.fn>;
}

const FLOWS: Flow[] = [
  {
    marker: "__oauth_state__",
    start: "/api/auth/google/start",
    callback: "/api/auth/google/callback",
    success: "/settings?google=connected",
    mismatch: "/settings",
    failed: "/settings?google=failed",
    exchange: () => m.getToken,
    write: () => m.tokenUpsert,
  },
  {
    marker: "__link_calendar__",
    start: "/api/auth/google/link-calendar",
    callback: "/api/auth/google/callback",
    success: "/calendar?linked=success",
    mismatch: "/calendar",
    failed: "/calendar?linked=failed",
    exchange: () => m.getToken,
    write: () => m.calendarUpsert,
  },
  {
    marker: "__link_inbox__",
    start: "/api/auth/google/link-inbox",
    callback: "/api/auth/google/callback",
    success: "/settings?inbox=success",
    mismatch: "/settings",
    failed: "/settings?inbox=failed",
    exchange: () => m.getToken,
    write: () => m.inboxUpsert,
  },
  {
    marker: "__link_outlook__",
    start: "/api/auth/outlook/link-inbox",
    callback: "/api/auth/outlook/callback",
    success: "/settings?inbox=success",
    mismatch: "/settings",
    failed: "/settings?inbox=failed",
    exchange: () => m.exchangeOutlookCode,
    write: () => m.inboxUpsert,
  },
  {
    marker: "__link_outlook_calendar__",
    start: "/api/auth/outlook/link-calendar",
    callback: "/api/auth/outlook/callback",
    success: "/calendar?linked=success",
    mismatch: "/calendar",
    failed: "/calendar?linked=failed",
    exchange: () => m.exchangeOutlookCode,
    write: () => m.calendarUpsert,
  },
  {
    // D5b, behind DRIVE_ENABLED and GOOGLE_DRIVE_ENABLED (both on below).
    marker: "__link_drive__",
    start: "/api/drive/google/link",
    callback: "/api/auth/google/callback",
    success: "/files?drive=success",
    mismatch: "/files",
    failed: "/files?drive=failed",
    exchange: () => m.getToken,
    write: () => m.driveUpsert,
  },
];

/** Start the flow as `who` through its real start route and return the signed state. */
async function startFlow(app: App, flow: Flow, who = A, query = ""): Promise<string> {
  const res = await app.inject({ method: "POST", url: `${flow.start}${query}`, headers: who });
  expect(res.statusCode).toBe(200);
  return new URL(res.json().url).searchParams.get("state") as string;
}

async function callback(app: App, flow: Flow, state: string) {
  return app.inject({
    method: "GET",
    url: `${flow.callback}?code=victim-code&state=${encodeURIComponent(state)}`,
  });
}

/** Run start + callback as user A and return the parked handle. */
async function park(app: App, flow: Flow): Promise<string> {
  const res = await callback(app, flow, await startFlow(app, flow));
  expect(res.statusCode).toBe(302);
  const match = HANDLE_REDIRECT.exec(res.headers.location as string);
  expect(match).not.toBeNull();
  return (match as RegExpExecArray)[1] as string;
}

function complete(app: App, handle: string, who?: Record<string, string>) {
  return app.inject({
    method: "POST",
    url: "/api/auth/link/complete",
    payload: { handle },
    ...(who ? { headers: who } : {}),
  });
}

function expectNothingExchangedOrWritten(flow: Flow) {
  expect(flow.exchange()).not.toHaveBeenCalled();
  expect(m.tokenUpsert).not.toHaveBeenCalled();
  expect(m.calendarUpsert).not.toHaveBeenCalled();
  expect(m.inboxUpsert).not.toHaveBeenCalled();
  expect(m.driveUpsert).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetPendingLinksForTests();
  _resetParkThrottleForTests();
  gates.inbox = true;
  gates.calendar = true;
  process.env.WEB_URL = WEB;
  vi.stubEnv("DRIVE_ENABLED", "true");
  vi.stubEnv("GOOGLE_DRIVE_ENABLED", "true");
  m.getToken.mockResolvedValue({
    tokens: {
      access_token: "at",
      refresh_token: "rt",
      expiry_date: Date.now() + 3600_000,
      // The Drive link requires drive.file; the other Google flows ignore scope.
      scope:
        "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file",
    },
  });
  m.exchangeOutlookCode.mockResolvedValue({
    accessToken: "graph-at",
    refreshToken: "graph-rt",
    expiresAt: new Date("2026-10-15T12:00:00Z"),
  });
  m.tokenUpsert.mockResolvedValue({ id: "tok-1" });
  m.calendarUpsert.mockResolvedValue({ id: "cal-1" });
  m.inboxUpsert.mockResolvedValue({ id: "inbox-1" });
  m.driveUpsert.mockResolvedValue({ id: "drive-1" });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  delete process.env.WEB_URL;
});

describe.each(FLOWS)("$marker", (flow) => {
  it("the callback parks the code: no exchange, no write, a handle in the fragment", async () => {
    const app = await buildApp();
    await park(app, flow);
    expectNothingExchangedOrWritten(flow);
    await app.close();
  });

  it("a state started by A and completed with B's session → 409, nothing exchanged or written; A's retry → 404", async () => {
    const app = await buildApp();
    const handle = await park(app, flow);

    const res = await complete(app, handle, B);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ next: flow.mismatch });
    expectNothingExchangedOrWritten(flow);
    expect(m.captureError).toHaveBeenCalledTimes(1);
    const [, context] = m.captureError.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(context).toMatchObject({
      tags: { scope: "auth.link.mismatch" },
      extra: { startedBy: "user-a", completedBy: "user-b", marker: flow.marker },
    });
    expect(JSON.stringify(m.captureError.mock.calls)).not.toContain("victim-code");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("[LINK-CSRF]"));
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("victim-code");

    const retry = await complete(app, handle, A);
    expect(retry.statusCode).toBe(404);
    expectNothingExchangedOrWritten(flow);
    await app.close();
  });

  it("A's own session completes it: 200 with the flow's success path and a write for A", async () => {
    const app = await buildApp();
    const handle = await park(app, flow);

    const res = await complete(app, handle, A);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ next: flow.success });
    expect(flow.exchange()).toHaveBeenCalledTimes(1);
    expect(flow.exchange().mock.calls[0]?.[0]).toBe("victim-code");
    expect(flow.write()).toHaveBeenCalledTimes(1);
    const written = JSON.stringify(flow.write().mock.calls[0]?.[0]);
    expect(written).toContain('"userId":"user-a"');
    expect(written).not.toContain("user-b");
    await app.close();
  });

  it("a replay of a completed handle → 404 and no second exchange", async () => {
    const app = await buildApp();
    const handle = await park(app, flow);
    expect((await complete(app, handle, A)).statusCode).toBe(200);

    const replay = await complete(app, handle, A);

    expect(replay.statusCode).toBe(404);
    expect(flow.exchange()).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("after the TTL → 404, nothing exchanged", async () => {
    const app = await buildApp();
    const handle = await park(app, flow);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + PENDING_LINK_TTL_MS + 1);

    const res = await complete(app, handle, A);

    expect(res.statusCode).toBe(404);
    expectNothingExchangedOrWritten(flow);
    await app.close();
  });

  it("no Bearer → 401, and the handle is not spent", async () => {
    const app = await buildApp();
    const handle = await park(app, flow);

    const res = await complete(app, handle);

    expect(res.statusCode).toBe(401);
    expectNothingExchangedOrWritten(flow);
    expect((await complete(app, handle, A)).statusCode).toBe(200);
    await app.close();
  });

  it("a start with appScheme=klorn ends in the native handoff page with a link-complete deep link", async () => {
    const app = await buildApp();
    const state = await startFlow(app, flow, A, "?appScheme=klorn");

    const res = await callback(app, flow, state);

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["cache-control"]).toBe("no-store");
    const deepLink = /klorn:\/\/link-complete\?h=([0-9a-f]{64})/.exec(res.body);
    expect(deepLink).not.toBeNull();
    expect(res.body).not.toContain("<script");
    expectNothingExchangedOrWritten(flow);
    expect((await complete(app, (deepLink as RegExpExecArray)[1] as string, A)).statusCode).toBe(
      200,
    );
    await app.close();
  });

  it("a start with a disallowed appScheme gets the web redirect", async () => {
    const app = await buildApp();
    const state = await startFlow(app, flow, A, "?appScheme=evil");

    const res = await callback(app, flow, state);

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(HANDLE_REDIRECT);
    await app.close();
  });

  it("a hand-signed state with a disallowed appScheme still gets the web redirect", async () => {
    const app = await buildApp();
    const state = signToken({ userId: "user-a", email: flow.marker, appScheme: "evil" }, "10m");

    const res = await callback(app, flow, state);

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(HANDLE_REDIRECT);
    await app.close();
  });
});

describe("POST /api/auth/link/complete input", () => {
  it.each([
    ["a missing body", undefined],
    ["a malformed handle", { handle: "not-hex" }],
    ["upper-case hex", { handle: "A".repeat(64) }],
  ])("400s on %s", async (_label, payload) => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/link/complete",
      headers: A,
      ...(payload ? { payload } : {}),
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("a userId in the body cannot pick the account: B claiming to be A still gets 409", async () => {
    const app = await buildApp();
    const handle = await park(app, FLOWS[2] as Flow);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/link/complete",
      headers: B,
      payload: { handle, userId: "user-a" },
    });

    expect(res.statusCode).toBe(409);
    expectNothingExchangedOrWritten(FLOWS[2] as Flow);
    await app.close();
  });

  it("404s on a well-formed handle that was never parked, with the LINK_EXPIRED code", async () => {
    const app = await buildApp();
    const res = await complete(app, "a".repeat(64), A);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("LINK_EXPIRED");
    await app.close();
  });

  it("a primary connect whose user is gone stays a distinct 404 (no LINK_EXPIRED code)", async () => {
    const { prisma } = await import("../db.js");
    const app = await buildApp();
    const handle = await park(app, FLOWS[0] as Flow);
    const findUser = vi.mocked(prisma.user.findUnique);
    const original = findUser.getMockImplementation();
    findUser.mockResolvedValue(null as never);
    try {
      const res = await complete(app, handle, A);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "User not found" });
    } finally {
      if (original) findUser.mockImplementation(original);
      await app.close();
    }
  });
});

describe("park throttle: a per-IP cap on the unauthenticated callback's park path", () => {
  const inbox = FLOWS[2] as Flow;
  const fromIp = (app: App, state: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: "GET",
      url: `${inbox.callback}?code=c&state=${encodeURIComponent(state)}`,
      headers,
    });

  it(`parks ${PARK_LIMIT_PER_IP} per IP, then lands on the flow's failed path without parking`, async () => {
    const app = await buildApp();
    const state = await startFlow(app, inbox);
    for (let i = 0; i < PARK_LIMIT_PER_IP; i += 1) {
      expect((await fromIp(app, state)).headers.location).toMatch(HANDLE_REDIRECT);
    }

    const over = await fromIp(app, state);

    expect(over.statusCode).toBe(302);
    expect(over.headers.location).toBe(`${WEB}${inbox.failed}`);
    expectNothingExchangedOrWritten(inbox);
    await app.close();
  });

  it.each(FLOWS)("over the limit, $marker lands on $failed (never raw JSON)", async (flow) => {
    const app = await buildApp();
    const state = await startFlow(app, flow);
    for (let i = 0; i < PARK_LIMIT_PER_IP; i += 1) await callback(app, flow, state);

    const over = await callback(app, flow, state);

    expect(over.statusCode).toBe(302);
    expect(over.headers.location).toBe(`${WEB}${flow.failed}`);
    await app.close();
  });

  it("keys on the Cloudflare-verified address, and a forged X-Forwarded-For does not reset it", async () => {
    const app = await buildApp();
    const state = await startFlow(app, inbox);
    const blocked = { "cf-connecting-ip": "203.0.113.7" };
    for (let i = 0; i < PARK_LIMIT_PER_IP; i += 1) await fromIp(app, state, blocked);

    const forged = await fromIp(app, state, { ...blocked, "x-forwarded-for": "198.51.100.1" });
    const otherClient = await fromIp(app, state, { "cf-connecting-ip": "203.0.113.8" });

    expect(forged.headers.location).toBe(`${WEB}${inbox.failed}`);
    expect(otherClient.headers.location).toMatch(HANDLE_REDIRECT);
    await app.close();
  });

  it("leaves the login markers alone: a throttled IP still signs in through the callback", async () => {
    const app = await buildApp();
    const state = await startFlow(app, inbox);
    for (let i = 0; i <= PARK_LIMIT_PER_IP; i += 1) await fromIp(app, state);
    const loginState = signToken(
      {
        userId: "__login__",
        email: "__google_login__",
        lb: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
      "10m",
    );

    const res = await app.inject({
      method: "GET",
      url: `/api/auth/google/callback?code=login-code&state=${encodeURIComponent(loginState)}`,
    });

    expect(m.getToken).toHaveBeenCalledWith("login-code");
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(
      /^https:\/\/app\.example\.com\/auth\/callback\?code=[0-9a-f]{40}$/,
    );
    await app.close();
  });
});

describe("a full store", () => {
  it.each(FLOWS)("$marker lands on $failed, reported, never raw JSON", async (flow) => {
    for (let i = 0; i < MAX_PENDING_LINKS; i += 1) {
      parkPendingLink({ userId: `filler-${i}`, marker: "__link_inbox__", code: "x" });
    }
    const app = await buildApp();

    const res = await callback(app, flow, await startFlow(app, flow));

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${WEB}${flow.failed}`);
    expect(m.captureError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { scope: "auth.link.park_full" },
      extra: { marker: flow.marker },
    });
    await app.close();
  });
});

describe("Outlook flags are re-checked at completion", () => {
  it.each([
    ["__link_outlook__", "inbox", "/settings?inbox=failed"],
    ["__link_outlook_calendar__", "calendar", "/calendar?linked=failed"],
  ] as const)("%s parked while on, completed after the %s flag went off → failed, no exchange", async (marker, gate, path) => {
    const flow = FLOWS.find((f) => f.marker === marker) as Flow;
    const app = await buildApp();
    const handle = await park(app, flow);
    gates[gate] = false;

    const res = await complete(app, handle, A);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ next: path });
    expectNothingExchangedOrWritten(flow);
    await app.close();
  });
});

describe("the Drive flags (D5b)", () => {
  const drive = FLOWS.find((f) => f.marker === "__link_drive__") as Flow;

  it.each([
    "DRIVE_ENABLED",
    "GOOGLE_DRIVE_ENABLED",
  ])("parked while on, completed after %s went off → /files?drive=failed, no exchange", async (flag) => {
    const app = await buildApp();
    const handle = await park(app, drive);
    vi.stubEnv(flag, "false");

    const res = await complete(app, handle, A);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ next: "/files?drive=failed" });
    expectNothingExchangedOrWritten(drive);
    await app.close();
  });

  it.each([
    "DRIVE_ENABLED",
    "GOOGLE_DRIVE_ENABLED",
  ])("a state signed while on, called back after %s went off → not parked, /files?drive=failed", async (flag) => {
    const app = await buildApp();
    const state = await startFlow(app, drive);
    vi.stubEnv(flag, "false");

    const res = await callback(app, drive, state);

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${WEB}/files?drive=failed`);
    expect(pendingLinkCount()).toBe(0);
    expect(res.headers["cache-control"]).toBeUndefined();
    expectNothingExchangedOrWritten(drive);
    await app.close();
  });
});

describe("source guard: no state-verifying GET handler reaches a credential write", () => {
  const files = apiSourceFiles();

  it("scans every OAuth callback handler file, not a fixed list", () => {
    const handlers = stateVerifyingHandlers(files);
    expect(handlers).toEqual(
      expect.arrayContaining([
        "routes/auth.ts GET /google/callback",
        "routes/outlook-auth.ts GET /callback",
      ]),
    );
  });

  it("finds no violation anywhere in packages/api/src", () => {
    expect(oauthCallbackViolations(files)).toEqual([]);
  });

  it("the Google callback parks the link markers before any code exchange", () => {
    const auth = readFileSync(new URL("../routes/auth.ts", import.meta.url), "utf8");
    const start = auth.indexOf('"/google/callback"');
    const handOff = auth.indexOf("handOffAccountLink(", start);
    expect(handOff).toBeGreaterThan(start);
    expect(handOff).toBeLessThan(auth.indexOf("getToken(", start));
  });

  describe("self-test: the guard catches a violating callback", () => {
    const probe = (text: string): SourceFile[] => [...files, { path: "routes/probe.ts", text }];

    it("a new callback that writes a Drive credential through a helper", () => {
      const violating = `
export function probeRoutes(app: FastifyInstance) {
  app.get("/drive/callback", async (request, reply) => {
    const payload = verifyToken((request.query as { state: string }).state);
    return reply.redirect(await saveDrive(payload.userId, "code"));
  });
}
async function saveDrive(userId: string, code: string): Promise<string> {
  await prisma.linkedDriveAccount.upsert({ where: { id: userId }, create: {}, update: { code } });
  return "/files";
}
`;
      expect(oauthCallbackViolations(probe(violating))).toEqual([
        "routes/probe.ts GET /drive/callback",
      ]);
    });

    it("a callback that writes a credential inline", () => {
      const violating = `
export function probeRoutes(app: FastifyInstance) {
  app.get("/x/callback", async (request, reply) => {
    const statePayload = verifyToken(state);
    await prisma.userToken.upsert({ where: {}, create: {}, update: {} });
    return reply.redirect("/");
  });
}
`;
      expect(oauthCallbackViolations(probe(violating))).toEqual([
        "routes/probe.ts GET /x/callback",
      ]);
    });

    it("a callback that only parks passes", () => {
      const parking = `
export function probeRoutes(app: FastifyInstance) {
  app.get("/drive/callback", async (request, reply) => {
    const payload = verifyToken((request.query as { state: string }).state);
    return handOffAccountLink(reply, { userId: payload.userId });
  });
}
`;
      expect(oauthCallbackViolations(probe(parking))).toEqual([]);
    });
  });
});
