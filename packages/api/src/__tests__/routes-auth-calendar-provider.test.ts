/**
 * C1 on routes/auth.ts: the link-calendar OAuth callback creates a GOOGLE
 * LinkedCalendarAccount keyed by (userId, provider, email), and the login
 * init-sync upserts primary-calendar events with provider/externalId next to
 * googleId.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

const eventsList = vi.hoisted(() => vi.fn());

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
    calendar: () => ({ events: { list: eventsList } }),
    gmail: () => ({ users: { messages: { list: vi.fn(async () => ({ data: {} })) } } }),
  },
}));

const linkedUpsert = vi.hoisted(() => vi.fn(async () => ({})));
const eventUpsert = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("../db.js", () => {
  const prisma = {
    linkedCalendarAccount: { upsert: linkedUpsert },
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
