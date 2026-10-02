/**
 * C1 on routes/auth.ts: the link-calendar OAuth callback creates a GOOGLE
 * LinkedCalendarAccount keyed by (userId, provider, email), and the login
 * init-sync upserts primary-calendar events with provider/externalId next to
 * googleId.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";
import { isGoogleAuthError, markGoogleTokenForReconnect } from "../mail/gmail.js";
import { _resetCancelledScanStateForTests } from "../pim/calendar-cancellation.js";
import { CANCELLED_SCAN_OPTIONS, cancelledScanRequest } from "./helpers/google-cancelled-scan.js";

const eventsList = vi.hoisted(() => vi.fn());
const cancelledList = vi.hoisted(() => vi.fn());

vi.mock("../mail/gmail.js", () => ({
  getAuthUrl: vi.fn(() => "https://example.com/oauth"),
  getLoginAuthUrl: vi.fn(() => "https://example.com/oauth-login"),
  getLinkInboxAuthUrl: vi.fn(() => "https://example.com/oauth-link-inbox"),
  getLinkCalendarAuthUrl: vi.fn(() => "https://example.com/oauth-link-calendar"),
  getAuthedClient: vi.fn(async () => ({})),
  getGoogleConnectionStatus: vi.fn(async () => ({ connected: true })),
  isGoogleAuthError: vi.fn(() => false),
  markGoogleTokenForReconnect: vi.fn(async () => {}),
  getGoogleUserInfo: vi.fn(async () => ({ email: "work@example.com", verified_email: true })),
  getOAuth2Client: vi.fn(() => ({
    getToken: vi.fn(async () => ({
      tokens: { access_token: "at", refresh_token: "rt", expiry_date: Date.now() + 3600_000 },
    })),
  })),
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
vi.mock("googleapis", () => ({
  google: {
    calendar: () => ({
      events: {
        // The cancellation scan (C2b) is a second events.list; it gets its own mock so
        // every assertion on `eventsList` stays about the sync's own listing.
        list: (args: { showDeleted?: boolean }, options?: unknown) =>
          args.showDeleted
            ? (cancelledList(args, options) ?? { data: { items: [] } })
            : eventsList(args),
      },
    }),
    gmail: () => ({ users: { messages: { list: vi.fn(async () => ({ data: {} })) } } }),
  },
}));

const linkedUpsert = vi.hoisted(() => vi.fn(async () => ({})));
const linkedFindMany = vi.hoisted(() => vi.fn(async () => []));
const eventUpsert = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("../db.js", () => {
  const prisma = {
    linkedCalendarAccount: { upsert: linkedUpsert, findMany: linkedFindMany },
    calendarEvent: { upsert: eventUpsert },
    automationConfig: { upsert: vi.fn(async () => ({})) },
    user: {
      findUnique: vi.fn(async () => ({
        id: "u1",
        plan: "PRO",
        role: "USER",
        email: "owner@example.com",
        timezone: "Asia/Seoul",
      })),
    },
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/auth/google/callback — __link_calendar__", () => {
  it("upserts a GOOGLE LinkedCalendarAccount keyed by (userId, provider, email)", async () => {
    const state = signToken({ userId: "u1", email: "__link_calendar__" });
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("linked=success");

    const arg = linkedUpsert.mock.calls[0]?.[0] as {
      where: unknown;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(arg.where).toEqual({
      userId_provider_email: { userId: "u1", provider: "GOOGLE", email: "work@example.com" },
    });
    expect(arg.create).toMatchObject({
      userId: "u1",
      provider: "GOOGLE",
      email: "work@example.com",
      accessToken: "enc:at",
      refreshToken: "enc:rt",
    });
    // A non-OAuth credential is never written for a Google link.
    expect(arg.create).not.toHaveProperty("caldavUrl");
    expect(arg.create).not.toHaveProperty("caldavPasswordCipher");
    expect(arg.update).toMatchObject({ accessToken: "enc:at", needsReconnect: false });
    await app.close();
  });
});

describe("POST /api/auth/init-sync — primary calendar upsert", () => {
  it("upserts by (userId, googleId) and dual-writes provider/externalId", async () => {
    eventsList.mockResolvedValue({
      data: {
        items: [
          {
            id: "g-login-1",
            summary: "Kickoff",
            start: { dateTime: "2026-10-03T09:00:00+09:00" },
            end: { dateTime: "2026-10-03T10:00:00+09:00" },
          },
        ],
      },
    });
    const token = signToken({ userId: "u1", email: "owner@example.com" });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/init-sync",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ synced: true, calendar: 1 });

    const arg = eventUpsert.mock.calls[0]?.[0] as {
      where: unknown;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(arg.where).toEqual({ userId_googleId: { userId: "u1", googleId: "g-login-1" } });
    expect(arg.create).toMatchObject({
      userId: "u1",
      googleId: "g-login-1",
      provider: "GOOGLE",
      externalId: "g-login-1",
      sourceAccountId: null,
      title: "Kickoff",
    });
    expect(arg.update).toMatchObject({ provider: "GOOGLE", externalId: "g-login-1" });
    await app.close();
  });
});

describe("POST /api/auth/init-sync — Google request (characterisation, C2)", () => {
  const INIT_NOW = new Date("2026-09-30T05:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(INIT_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function initSync() {
    const token = signToken({ userId: "u1", email: "owner@example.com" });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/init-sync",
      headers: { authorization: `Bearer ${token}` },
    });
    await app.close();
    return res;
  }

  it("asks Google for the next 30 days of the primary calendar, capped at 100, in the user's zone", async () => {
    eventsList.mockResolvedValue({ data: { items: [] } });
    await initSync();
    expect(eventsList).toHaveBeenCalledTimes(1);
    expect(eventsList).toHaveBeenCalledWith({
      calendarId: "primary",
      timeMin: "2026-09-30T05:00:00.000Z",
      timeMax: "2026-10-30T05:00:00.000Z",
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 100,
      timeZone: "Asia/Seoul",
    });
  });

  it("makes no second Google call while the cancellation flag is off (the default)", async () => {
    eventsList.mockResolvedValue({ data: { items: [] } });
    await initSync();
    expect(eventsList).toHaveBeenCalledTimes(1);
    expect(cancelledList).not.toHaveBeenCalled();
  });

  describe("with CALENDAR_CANCELLATION_SYNC_ENABLED on (C2b)", () => {
    beforeEach(() => {
      process.env.CALENDAR_CANCELLATION_SYNC_ENABLED = "true";
      _resetCancelledScanStateForTests();
    });
    afterEach(() => {
      delete process.env.CALENDAR_CANCELLATION_SYNC_ENABLED;
    });

    it("also asks Google, in a second call, what was cancelled in the last 7 days", async () => {
      eventsList.mockResolvedValue({ data: { items: [] } });
      await initSync();
      expect(cancelledList).toHaveBeenCalledTimes(1);
      expect(cancelledList).toHaveBeenCalledWith(
        cancelledScanRequest("2026-09-23T05:00:00.000Z"),
        CANCELLED_SCAN_OPTIONS,
      );
    });
  });

  it("a failing calendar list flags an auth failure for reconnect and still answers 200", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(isGoogleAuthError).mockReturnValueOnce(true);
    eventsList.mockRejectedValue({ response: { status: 401 } });
    const res = await initSync();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ synced: true, calendar: 0 });
    expect(markGoogleTokenForReconnect).toHaveBeenCalledWith("u1");
    warn.mockRestore();
  });

  it("maps a timed event with a meeting link the same way the scheduler does", async () => {
    eventsList.mockResolvedValue({
      data: {
        items: [
          {
            id: "g-x",
            summary: "Timed",
            location: "L",
            start: { dateTime: "2026-10-02T09:00:00" },
            end: { dateTime: "2026-10-02T10:00:00" },
            hangoutLink: "https://hangouts/z",
          },
        ],
      },
    });
    await initSync();
    const create = (eventUpsert.mock.calls[0]?.[0] as { create: Record<string, unknown> }).create;
    expect(create).toMatchObject({
      googleId: "g-x",
      title: "Timed",
      description: null,
      location: "L",
      meetingLink: "https://hangouts/z",
      allDay: false,
      startTime: new Date("2026-10-02T00:00:00.000Z"),
      endTime: new Date("2026-10-02T01:00:00.000Z"),
    });
  });
});

describe("GET /api/auth/google/linked-calendars", () => {
  it("lists only GOOGLE accounts — this is the Google linked-calendars surface", async () => {
    const token = signToken({ userId: "u1", email: "owner@example.com" });
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/google/linked-calendars",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const arg = linkedFindMany.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(arg.where).toEqual({ userId: "u1", provider: "GOOGLE" });
    await app.close();
  });
});
