/**
 * C4: linking an Outlook (Microsoft Graph) CALENDAR through the existing Outlook
 * OAuth flow. Same app registration, redirect URI and callback as the inbox link;
 * a distinct signed-state marker picks the calendar branch, which writes a
 * LinkedCalendarAccount (never a LinkedInboxAccount) with Calendars.Read only.
 * The whole calendar surface is dark unless OUTLOOK_CALENDAR_ENABLED and
 * OUTLOOK_INBOX_ENABLED are both on, answering Fastify's default 404 like an
 * unregistered route (darkRouteGate).
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ plan: "PRO", role: "USER" }));

const db = vi.hoisted(() => ({
  calendar: {
    findMany: vi.fn(async () => []),
    findUnique: vi.fn(async () => null),
    count: vi.fn(async () => 0),
    upsert: vi.fn(async () => ({ id: "cal-row-1" })),
  },
  inbox: {
    findMany: vi.fn(async () => []),
    findUnique: vi.fn(async () => null),
    count: vi.fn(async () => 0),
    upsert: vi.fn(async () => ({ id: "inbox-row-1" })),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  },
  unlinkCalendarAccount: vi.fn(async () => true),
  captureError: vi.fn(),
}));

const oauth = vi.hoisted(() => ({
  exchangeOutlookCode: vi.fn(async () => ({
    accessToken: "graph-at",
    refreshToken: "graph-rt",
    expiresAt: new Date("2026-08-06T12:00:00Z"),
  })),
  fetchOutlookAccountEmail: vi.fn(async () => "Me@Contoso.com"),
  getOutlookAuthUrl: vi.fn(
    (s: string, set?: string) =>
      `https://login.microsoftonline.com/authorize?state=${s}&set=${set ?? "inbox"}`,
  ),
  outlookConfigured: vi.fn(() => true),
}));

vi.mock("../db.js", () => {
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({ id: "user-1", plan: state.plan, role: state.role })),
      update: vi.fn(async () => ({ id: "user-1" })),
    },
    linkedCalendarAccount: db.calendar,
    linkedInboxAccount: db.inbox,
    device: {
      findUnique: vi.fn(async () => ({ id: "device-1" })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../crypto-tokens.js", () => ({
  encryptToken: vi.fn((t: string) => `enc:${t}`),
  encryptOptional: vi.fn((t: string | null | undefined) => (t ? `enc:${t}` : null)),
}));
vi.mock("../mail/outlook-oauth.js", () => oauth);
vi.mock("../pim/linked-calendar-unlink.js", () => ({
  unlinkCalendarAccount: db.unlinkCalendarAccount,
}));
vi.mock("../sentry.js", () => ({ captureError: db.captureError }));

const FLAG_KEYS = ["OUTLOOK_INBOX_ENABLED", "OUTLOOK_CALENDAR_ENABLED", "WEB_URL"] as const;
const saved: Record<string, string | undefined> = {};
const WEB = "https://app.example.com";

async function buildApp() {
  vi.resetModules();
  process.env.WEB_URL = WEB;
  const { signToken, verifyToken } = await import("../auth.js");
  const { outlookAuthRoutes } = await import("../routes/outlook-auth.js");
  const { outlookInboxEnabled } = await import("../config.js");
  const app = Fastify();
  await app.register(outlookAuthRoutes({ gate: outlookInboxEnabled }), {
    prefix: "/api/auth/outlook",
  });
  await app.ready();
  const token = signToken({ userId: "user-1", email: "test@example.com" });
  return {
    app,
    verifyToken,
    token,
    headers: { authorization: `Bearer ${token}` },
    calendarState: signToken({ userId: "user-1", email: "__link_outlook_calendar__" }, "10m"),
    inboxState: signToken({ userId: "user-1", email: "__link_outlook__" }, "10m"),
  };
}

function setFlags(calendar: string | undefined, inbox: string | undefined) {
  if (calendar === undefined) delete process.env.OUTLOOK_CALENDAR_ENABLED;
  else process.env.OUTLOOK_CALENDAR_ENABLED = calendar;
  if (inbox === undefined) delete process.env.OUTLOOK_INBOX_ENABLED;
  else process.env.OUTLOOK_INBOX_ENABLED = inbox;
}

const callbackUrl = (code: string, st: string) =>
  `/api/auth/outlook/callback?code=${code}&state=${encodeURIComponent(st)}`;

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of FLAG_KEYS) saved[k] = process.env[k];
  setFlags("true", "true");
  db.calendar.findMany.mockResolvedValue([]);
  db.calendar.findUnique.mockResolvedValue(null);
  db.calendar.count.mockResolvedValue(0);
  db.calendar.upsert.mockResolvedValue({ id: "cal-row-1" });
  db.unlinkCalendarAccount.mockResolvedValue(true);
  oauth.outlookConfigured.mockReturnValue(true);
  oauth.fetchOutlookAccountEmail.mockResolvedValue("Me@Contoso.com");
  oauth.exchangeOutlookCode.mockResolvedValue({
    accessToken: "graph-at",
    refreshToken: "graph-rt",
    expiresAt: new Date("2026-08-06T12:00:00Z"),
  });
  state.plan = "PRO";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of FLAG_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.resetModules();
});

describe("flags: the calendar surface is dark unless both are on", () => {
  const ROUTES = [
    ["POST", "/api/auth/outlook/link-calendar"],
    ["GET", "/api/auth/outlook/linked-calendars"],
    ["DELETE", "/api/auth/outlook/linked-calendars/some-id"],
  ] as const;

  it.each(
    ROUTES.flatMap(([method, url]) =>
      (
        [
          ["both off", undefined, undefined],
          ["calendar on, inbox off", "true", undefined],
          ["inbox on, calendar off", undefined, "true"],
        ] as const
      ).map(([label, calendar, inbox]) => [method, url, label, calendar, inbox] as const),
    ),
  )("%s %s answers Fastify's default 404 even when authenticated (%s)", async (method, url, _l, calendar, inbox) => {
    setFlags(calendar, inbox);
    const { app, headers } = await buildApp();

    const res = await app.inject({ method, url, headers });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      message: `Route ${method}:${url} not found`,
      error: "Not Found",
      statusCode: 404,
    });
    expect(oauth.getOutlookAuthUrl).not.toHaveBeenCalled();
    expect(db.calendar.findMany).not.toHaveBeenCalled();
    expect(db.unlinkCalendarAccount).not.toHaveBeenCalled();
    await app.close();
  });

  it("the calendar flag does not change the inbox surface: with it off, the inbox link still works", async () => {
    setFlags(undefined, "true");
    const { app, headers } = await buildApp();

    const res = await app.inject({ method: "POST", url: "/api/auth/outlook/link-inbox", headers });

    expect(res.statusCode).toBe(200);
    expect(oauth.getOutlookAuthUrl).toHaveBeenCalledWith(expect.any(String));
    await app.close();
  });

  it("a calendar callback that arrives after the flag was turned off writes nothing and exchanges no code", async () => {
    const { app, calendarState } = await buildApp();
    setFlags(undefined, "true");

    const res = await app.inject({ method: "GET", url: callbackUrl("c", calendarState) });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${WEB}/calendar?linked=failed`);
    expect(oauth.exchangeOutlookCode).not.toHaveBeenCalled();
    expect(db.calendar.upsert).not.toHaveBeenCalled();
    expect(db.inbox.upsert).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("POST /link-calendar", () => {
  it("rejects an unauthenticated start", async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/auth/outlook/link-calendar" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns the authorize URL built for the CALENDAR scope set, with a short-lived signed calendar state", async () => {
    const { app, headers, verifyToken } = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/outlook/link-calendar",
      headers,
    });

    expect(res.statusCode).toBe(200);
    expect(oauth.getOutlookAuthUrl).toHaveBeenCalledTimes(1);
    const [signed, scopeSet] = oauth.getOutlookAuthUrl.mock.calls[0] as unknown as [string, string];
    expect(scopeSet).toBe("calendar");
    expect(res.json().url).toContain("login.microsoftonline.com");
    const payload = verifyToken(signed) as {
      userId: string;
      email: string;
      exp: number;
      iat: number;
    };
    expect(payload).toMatchObject({ userId: "user-1", email: "__link_outlook_calendar__" });
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(10 * 60);
    await app.close();
  });

  it("the inbox link still asks for the inbox scope set (its call is unchanged)", async () => {
    const { app, headers } = await buildApp();

    await app.inject({ method: "POST", url: "/api/auth/outlook/link-inbox", headers });

    expect(oauth.getOutlookAuthUrl).toHaveBeenCalledTimes(1);
    expect(oauth.getOutlookAuthUrl.mock.calls[0]).toHaveLength(1);
    await app.close();
  });

  it("503s when the Azure registration is not configured", async () => {
    oauth.outlookConfigured.mockReturnValue(false);
    const { app, headers } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/outlook/link-calendar",
      headers,
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("refuses the demo user", async () => {
    const { app } = await buildApp();
    const { signToken } = await import("../auth.js");
    const demo = signToken({ userId: "demo-user", email: "demo@example.com" });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/outlook/link-calendar",
      headers: { authorization: `Bearer ${demo}` },
    });
    expect(res.statusCode).toBe(403);
    expect(oauth.getOutlookAuthUrl).not.toHaveBeenCalled();
    await app.close();
  });

  it("enforces the entitlement gate (FREE is refused once the paywall is on)", async () => {
    state.plan = "FREE";
    process.env.PAYWALL_ENABLED = "true";
    try {
      const { app, headers } = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/outlook/link-calendar",
        headers,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("ENTITLEMENT_REQUIRED");
      await app.close();
    } finally {
      delete process.env.PAYWALL_ENABLED;
    }
  });
});

describe("GET /callback with a calendar state", () => {
  it("exchanges the code for the calendar scope set and upserts an OUTLOOK LinkedCalendarAccount with encrypted tokens", async () => {
    const { app, calendarState } = await buildApp();

    const res = await app.inject({ method: "GET", url: callbackUrl("auth-code", calendarState) });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${WEB}/calendar?linked=success`);
    expect(oauth.exchangeOutlookCode).toHaveBeenCalledWith("auth-code", "calendar");
    expect(db.calendar.upsert).toHaveBeenCalledTimes(1);
    expect(db.calendar.upsert).toHaveBeenCalledWith({
      where: {
        userId_provider_email: { userId: "user-1", provider: "OUTLOOK", email: "me@contoso.com" },
      },
      update: {
        accessToken: "enc:graph-at",
        refreshToken: "enc:graph-rt",
        expiresAt: new Date("2026-08-06T12:00:00Z"),
        needsReconnect: false,
      },
      create: {
        userId: "user-1",
        provider: "OUTLOOK",
        email: "me@contoso.com",
        accessToken: "enc:graph-at",
        refreshToken: "enc:graph-rt",
        expiresAt: new Date("2026-08-06T12:00:00Z"),
      },
    });
    expect(db.inbox.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("an INBOX state still writes only an inbox row, with the inbox scope set: a calendar link cannot be started from it", async () => {
    const { app, inboxState } = await buildApp();

    const res = await app.inject({ method: "GET", url: callbackUrl("auth-code", inboxState) });

    expect(res.headers.location).toBe(`${WEB}/settings?inbox=success`);
    expect(oauth.exchangeOutlookCode).toHaveBeenCalledWith("auth-code");
    expect(db.inbox.upsert).toHaveBeenCalledTimes(1);
    expect(db.calendar.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects an ordinary session JWT replayed as state", async () => {
    const { app, token } = await buildApp();
    const res = await app.inject({ method: "GET", url: callbackUrl("auth-code", token) });
    expect(res.statusCode).toBe(400);
    expect(db.calendar.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("redirects ?linked=failed when the code exchange fails, without writing", async () => {
    oauth.exchangeOutlookCode.mockResolvedValueOnce({ error: "invalid_grant" } as never);
    const { app, calendarState } = await buildApp();

    const res = await app.inject({ method: "GET", url: callbackUrl("bad", calendarState) });

    expect(res.headers.location).toBe(`${WEB}/calendar?linked=failed`);
    expect(db.calendar.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("redirects ?linked=failed when Graph /me yields no address, without writing", async () => {
    oauth.fetchOutlookAccountEmail.mockResolvedValueOnce(null);
    const { app, calendarState } = await buildApp();

    const res = await app.inject({ method: "GET", url: callbackUrl("c", calendarState) });

    expect(res.headers.location).toBe(`${WEB}/calendar?linked=failed`);
    expect(db.calendar.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("re-checks entitlement at callback time (TOCTOU): a lapsed user cannot finish", async () => {
    state.plan = "FREE";
    process.env.PAYWALL_ENABLED = "true";
    try {
      const { app, calendarState } = await buildApp();
      const res = await app.inject({ method: "GET", url: callbackUrl("c", calendarState) });
      expect(res.headers.location).toBe(`${WEB}/calendar?linked=failed`);
      expect(db.calendar.upsert).not.toHaveBeenCalled();
      await app.close();
    } finally {
      delete process.env.PAYWALL_ENABLED;
    }
  });

  it("caps NEW Outlook calendars at 10 but always allows a re-link", async () => {
    db.calendar.count.mockResolvedValue(10);
    const { app, calendarState } = await buildApp();

    const blocked = await app.inject({ method: "GET", url: callbackUrl("c", calendarState) });
    expect(blocked.headers.location).toBe(`${WEB}/calendar?linked=limit`);
    expect(db.calendar.upsert).not.toHaveBeenCalled();
    expect(db.calendar.count).toHaveBeenCalledWith({
      where: { userId: "user-1", provider: "OUTLOOK" },
    });

    db.calendar.findUnique.mockResolvedValue({ id: "existing" } as never);
    const relink = await app.inject({ method: "GET", url: callbackUrl("c", calendarState) });
    expect(relink.headers.location).toBe(`${WEB}/calendar?linked=success`);
    expect(db.calendar.upsert).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("an address already linked as another provider's calendar (the legacy unique) fails quietly, without Sentry", async () => {
    db.calendar.upsert.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    const { app, calendarState } = await buildApp();

    const res = await app.inject({ method: "GET", url: callbackUrl("c", calendarState) });

    expect(res.headers.location).toBe(`${WEB}/calendar?linked=failed`);
    expect(db.captureError).not.toHaveBeenCalled();
    await app.close();
  });

  it("any other write failure redirects ?linked=failed and is reported", async () => {
    db.calendar.upsert.mockRejectedValueOnce(new Error("db down"));
    const { app, calendarState } = await buildApp();

    const res = await app.inject({ method: "GET", url: callbackUrl("c", calendarState) });

    expect(res.headers.location).toBe(`${WEB}/calendar?linked=failed`);
    expect(db.captureError).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("a provider error (consent denied, or an org that blocks user consent) lands back on the calendar, never reflected", async () => {
    const { app, calendarState } = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: `/api/auth/outlook/callback?error=access_denied%3Cscript%3E&state=${encodeURIComponent(calendarState)}`,
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${WEB}/calendar?linked=failed`);
    expect(oauth.exchangeOutlookCode).not.toHaveBeenCalled();
    await app.close();
  });

  it("a provider error with no state, or a forged one, keeps the existing inbox marker", async () => {
    const { app } = await buildApp();

    const none = await app.inject({
      method: "GET",
      url: "/api/auth/outlook/callback?error=access_denied",
    });
    const forged = await app.inject({
      method: "GET",
      url: "/api/auth/outlook/callback?error=access_denied&state=garbage",
    });

    expect(none.headers.location).toBe(`${WEB}/settings?inbox=outlook_denied`);
    expect(forged.headers.location).toBe(`${WEB}/settings?inbox=outlook_denied`);
    await app.close();
  });
});

describe("GET /linked-calendars and DELETE /linked-calendars/:id", () => {
  it("lists only OUTLOOK calendar accounts, and never their tokens", async () => {
    const { app, headers } = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/auth/outlook/linked-calendars",
      headers,
    });

    expect(res.statusCode).toBe(200);
    expect(db.calendar.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1", provider: "OUTLOOK" },
      select: { id: true, email: true, createdAt: true, needsReconnect: true },
      orderBy: { createdAt: "asc" },
    });
    await app.close();
  });

  it("unlinks through the shared transaction, scoped to OUTLOOK and to the caller", async () => {
    const { app, headers } = await buildApp();

    const res = await app.inject({
      method: "DELETE",
      url: "/api/auth/outlook/linked-calendars/row-9",
      headers,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect(db.unlinkCalendarAccount).toHaveBeenCalledWith("user-1", "row-9", "OUTLOOK");
    await app.close();
  });

  it("404s when nothing matched", async () => {
    db.unlinkCalendarAccount.mockResolvedValueOnce(false);
    const { app, headers } = await buildApp();

    const res = await app.inject({
      method: "DELETE",
      url: "/api/auth/outlook/linked-calendars/row-9",
      headers,
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("unlinking needs a login but not an entitlement: a downgraded user can always disconnect", async () => {
    state.plan = "FREE";
    process.env.PAYWALL_ENABLED = "true";
    try {
      const { app, headers } = await buildApp();
      const res = await app.inject({
        method: "DELETE",
        url: "/api/auth/outlook/linked-calendars/row-9",
        headers,
      });
      expect(res.statusCode).toBe(200);
      const list = await app.inject({
        method: "GET",
        url: "/api/auth/outlook/linked-calendars",
        headers,
      });
      expect(list.statusCode).toBe(403);
      await app.close();
    } finally {
      delete process.env.PAYWALL_ENABLED;
    }
  });
});
