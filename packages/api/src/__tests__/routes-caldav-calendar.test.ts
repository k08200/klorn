/**
 * C3: linking an iCloud or Naver calendar over CalDAV with an app-specific
 * password. The link verifies the credentials with a PROPFIND (through the same
 * host guard as the sync), stores the password with encryptToken and never returns
 * or logs it. Every failure of the verification answers ONE generic message with no
 * server text, so the route cannot be used as an oracle; attempts are rate limited
 * like the IMAP connect route. The whole surface is dark (Fastify's default 404)
 * unless CALDAV_CALENDAR_ENABLED is on.
 */

import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  calendar: {
    findMany: vi.fn(async () => [] as unknown[]),
    findUnique: vi.fn(async () => null as unknown),
    findFirst: vi.fn(async () => null as unknown),
    count: vi.fn(async () => 0),
    upsert: vi.fn(async () => ({ id: "cal-row-1", provider: "ICLOUD", email: "me@icloud.com" })),
  },
  inbox: { findUnique: vi.fn(async () => null as unknown) },
  unlinkCalendarAccount: vi.fn(async () => true),
  captureError: vi.fn(),
}));

vi.mock("../db.js", () => {
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({ id: "user-1", plan: "PRO", role: "USER" })),
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
  decryptToken: vi.fn((t: string) => {
    if (!t.startsWith("enc:")) throw new Error("bad cipher");
    return t.slice(4);
  }),
}));
vi.mock("../pim/linked-calendar-unlink.js", () => ({
  unlinkCalendarAccount: db.unlinkCalendarAccount,
}));
vi.mock("../sentry.js", () => ({ captureError: db.captureError }));

import {
  type FakeRoutes,
  fakeCaldavServer,
  ICLOUD_HOME_SET_XML,
  ICLOUD_PRINCIPAL_PATH,
  ICLOUD_PRINCIPAL_XML,
  NAVER_HOME_SET_XML,
  NAVER_PRINCIPAL_PATH,
} from "../__fixtures__/caldav/server.js";
import type { CaldavTransport } from "../pim/caldav/caldav-http.js";

const PASSWORD = "abcd-efgh-ijkl-mnop";
const GENERIC = "Could not connect this calendar. Check the address and the app-specific password.";
const ICLOUD_OK: FakeRoutes = {
  "PROPFIND caldav.icloud.com /": { status: 207, body: ICLOUD_PRINCIPAL_XML },
  [`PROPFIND caldav.icloud.com ${ICLOUD_PRINCIPAL_PATH}`]: {
    status: 207,
    body: ICLOUD_HOME_SET_XML,
  },
};
const NAVER_OK: FakeRoutes = {
  "PROPFIND caldav.calendar.naver.com /": { status: 404 },
  [`PROPFIND caldav.calendar.naver.com ${NAVER_PRINCIPAL_PATH}`]: {
    status: 207,
    body: NAVER_HOME_SET_XML,
  },
};

const saved = process.env.CALDAV_CALENDAR_ENABLED;

async function buildApp(transport: CaldavTransport, opts: { withRateLimit?: boolean } = {}) {
  vi.resetModules();
  const { signToken } = await import("../auth.js");
  const { caldavCalendarRoutes } = await import("../routes/caldav-calendar.js");
  const { caldavCalendarEnabled } = await import("../config.js");
  const app = Fastify();
  if (opts.withRateLimit) await app.register(rateLimit, { max: 1000, timeWindow: "1 minute" });
  await app.register(
    caldavCalendarRoutes({
      gate: caldavCalendarEnabled,
      deps: { transport, resolve: async () => ["17.248.1.10"] },
    }),
    { prefix: "/api/caldav-calendar" },
  );
  await app.ready();
  const token = signToken({ userId: "user-1", email: "test@example.com" });
  return { app, headers: { authorization: `Bearer ${token}` } };
}

function link(body: Record<string, unknown>) {
  return { method: "POST" as const, url: "/api/caldav-calendar/link", payload: body };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CALDAV_CALENDAR_ENABLED = "true";
  db.calendar.findUnique.mockResolvedValue(null);
  db.calendar.findFirst.mockResolvedValue(null);
  db.calendar.findMany.mockResolvedValue([]);
  db.calendar.count.mockResolvedValue(0);
  db.calendar.upsert.mockResolvedValue({
    id: "cal-row-1",
    provider: "ICLOUD",
    email: "me@icloud.com",
  });
  db.inbox.findUnique.mockResolvedValue(null);
  db.unlinkCalendarAccount.mockResolvedValue(true);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  if (saved === undefined) delete process.env.CALDAV_CALENDAR_ENABLED;
  else process.env.CALDAV_CALENDAR_ENABLED = saved;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("CALDAV_CALENDAR_ENABLED off: the surface is dark", () => {
  it.each([
    ["POST", "/api/caldav-calendar/link"],
    ["GET", "/api/caldav-calendar/linked-calendars"],
    ["DELETE", "/api/caldav-calendar/linked-calendars/some-id"],
  ] as const)("%s %s answers Fastify's default 404, authenticated or not", async (method, url) => {
    process.env.CALDAV_CALENDAR_ENABLED = "false";
    const server = fakeCaldavServer(ICLOUD_OK);
    const { app, headers } = await buildApp(server);
    for (const h of [headers, {}]) {
      const res = await app.inject({ method, url, headers: h });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        message: `Route ${method}:${url} not found`,
        error: "Not Found",
        statusCode: 404,
      });
    }
    expect(server.calls).toEqual([]);
    expect(db.calendar.findMany).not.toHaveBeenCalled();
    expect(db.calendar.upsert).not.toHaveBeenCalled();
    expect(db.unlinkCalendarAccount).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("POST /link", () => {
  it("rejects an unauthenticated attempt", async () => {
    const { app } = await buildApp(fakeCaldavServer(ICLOUD_OK));
    const res = await app.inject(
      link({ provider: "ICLOUD", username: "me@icloud.com", password: PASSWORD }),
    );
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("iCloud: verifies with a PROPFIND, stores the password encrypted, never returns it", async () => {
    const server = fakeCaldavServer(ICLOUD_OK);
    const { app, headers } = await buildApp(server);
    const res = await app.inject({
      ...link({ provider: "ICLOUD", username: " Me@iCloud.com ", password: PASSWORD }),
      headers,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      account: { id: "cal-row-1", provider: "ICLOUD", email: "me@icloud.com" },
    });
    expect(res.body).not.toContain(PASSWORD);
    expect(server.calls).toEqual([
      "PROPFIND caldav.icloud.com /",
      `PROPFIND caldav.icloud.com ${ICLOUD_PRINCIPAL_PATH}`,
    ]);
    expect(db.calendar.upsert).toHaveBeenCalledWith({
      where: {
        userId_provider_email: { userId: "user-1", provider: "ICLOUD", email: "me@icloud.com" },
      },
      create: {
        userId: "user-1",
        provider: "ICLOUD",
        email: "me@icloud.com",
        caldavPasswordCipher: `enc:${PASSWORD}`,
      },
      update: { caldavPasswordCipher: `enc:${PASSWORD}`, needsReconnect: false },
      select: { id: true, provider: true, email: true },
    });
    await app.close();
  });

  it("a re-link starts the account's failure backoff over", async () => {
    const { app, headers } = await buildApp(fakeCaldavServer(ICLOUD_OK));
    const backoff = await import("../pim/caldav/caldav-backoff.js");
    backoff.noteCaldavFailure("cal-row-1");
    expect(backoff.isCaldavBackedOff("cal-row-1")).toBe(true);
    const res = await app.inject({
      ...link({ provider: "ICLOUD", username: "me@icloud.com", password: PASSWORD }),
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(backoff.isCaldavBackedOff("cal-row-1")).toBe(false);
    await app.close();
  });

  it("Naver: logs in with the Naver ID and lists the account as id@naver.com", async () => {
    let auth = "";
    const routes = fakeCaldavServer(NAVER_OK);
    const transport: CaldavTransport = async (req) => {
      auth = Buffer.from((req.headers.Authorization ?? "").slice(6), "base64").toString();
      return routes(req);
    };
    db.calendar.upsert.mockResolvedValue({
      id: "n1",
      provider: "NAVER",
      email: "kim_01@naver.com",
    });
    const { app, headers } = await buildApp(transport);
    const res = await app.inject({
      ...link({ provider: "NAVER", username: "Kim_01@naver.com", password: PASSWORD }),
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(auth).toBe(`kim_01:${PASSWORD}`);
    expect(db.calendar.upsert.mock.calls[0]?.[0]).toMatchObject({
      where: { userId_provider_email: { provider: "NAVER", email: "kim_01@naver.com" } },
    });
    await app.close();
  });

  it.each([
    [
      "a wrong password (401)",
      { "PROPFIND caldav.icloud.com /": { status: 401, body: "bad pw for me@icloud.com" } },
    ],
    [
      "a server error with text",
      { "PROPFIND caldav.icloud.com /": { status: 500, body: "db-7.apple.internal down" } },
    ],
    [
      "a redirect off the allowlist",
      { "PROPFIND caldav.icloud.com /": { status: 302, location: "https://evil.example/" } },
    ],
    [
      "an unreadable answer",
      { "PROPFIND caldav.icloud.com /": { status: 207, body: "<html>not dav</html>" } },
    ],
    [
      "no principal",
      { "PROPFIND caldav.icloud.com /": { status: 207, body: '<multistatus xmlns="DAV:"/>' } },
    ],
  ] as const)("%s: the one generic answer, nothing stored", async (_label, routes) => {
    const { app, headers } = await buildApp(fakeCaldavServer(routes as FakeRoutes));
    const res = await app.inject({
      ...link({ provider: "ICLOUD", username: "me@icloud.com", password: PASSWORD }),
      headers,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ ok: false, message: GENERIC });
    expect(db.calendar.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("an address the resolver says is private: the same generic answer", async () => {
    vi.resetModules();
    const { signToken } = await import("../auth.js");
    const { caldavCalendarRoutes } = await import("../routes/caldav-calendar.js");
    const app = Fastify();
    const server = fakeCaldavServer(ICLOUD_OK);
    await app.register(
      caldavCalendarRoutes({
        gate: () => true,
        deps: { transport: server, resolve: async () => ["10.0.0.7"] },
      }),
      { prefix: "/api/caldav-calendar" },
    );
    const headers = {
      authorization: `Bearer ${signToken({ userId: "user-1", email: "t@example.com" })}`,
    };
    const res = await app.inject({
      ...link({ provider: "ICLOUD", username: "me@icloud.com", password: PASSWORD }),
      headers,
    });
    expect(res.json()).toEqual({ ok: false, message: GENERIC });
    expect(server.calls).toEqual([]);
    await app.close();
  });

  it("never writes the password to a log line, whatever fails", async () => {
    const { app, headers } = await buildApp(
      fakeCaldavServer({ "PROPFIND caldav.icloud.com /": { status: 401 } }),
    );
    await app.inject({
      ...link({ provider: "ICLOUD", username: "me@icloud.com", password: PASSWORD }),
      headers,
    });
    const logged = [console.warn, console.error, console.log]
      .flatMap((fn) => vi.mocked(fn).mock.calls)
      .map((args) => JSON.stringify(args.map(String)));
    expect(logged.join("\n")).not.toContain(PASSWORD);
    expect(logged.join("\n")).not.toContain(
      Buffer.from(`me@icloud.com:${PASSWORD}`).toString("base64"),
    );
    await app.close();
  });

  it.each([
    [
      "an iCloud name that is not an address",
      { provider: "ICLOUD", username: "me", password: PASSWORD },
    ],
    ["a Naver ID with a path in it", { provider: "NAVER", username: "../x", password: PASSWORD }],
  ])("refuses %s before any request", async (_label, body) => {
    const server = fakeCaldavServer(ICLOUD_OK);
    const { app, headers } = await buildApp(server);
    const res = await app.inject({ ...link(body), headers });
    expect(res.statusCode).toBe(400);
    expect(server.calls).toEqual([]);
    await app.close();
  });

  it.each([
    [
      "a provider outside the registry",
      { provider: "GOOGLE", username: "me@icloud.com", password: PASSWORD },
    ],
    ["neither a password nor reuse", { provider: "ICLOUD", username: "me@icloud.com" }],
    [
      "both a password and reuse",
      {
        provider: "ICLOUD",
        username: "me@icloud.com",
        password: PASSWORD,
        reuseInboxPassword: true,
      },
    ],
  ])("400 for %s, before any request", async (_label, body) => {
    const server = fakeCaldavServer(ICLOUD_OK);
    const { app, headers } = await buildApp(server);
    const res = await app.inject({ ...link(body), headers });
    expect(res.statusCode).toBe(400);
    expect(server.calls).toEqual([]);
    expect(db.calendar.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("a caller-supplied URL is dropped by the schema: requests go to the registry's host only", async () => {
    const server = fakeCaldavServer(ICLOUD_OK);
    const { app, headers } = await buildApp(server);
    const res = await app.inject({
      ...link({
        provider: "ICLOUD",
        username: "me@icloud.com",
        password: PASSWORD,
        url: "https://10.0.0.1/",
        caldavUrl: "https://169.254.169.254/",
      }),
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(server.calls.every((call) => call.includes(" caldav.icloud.com "))).toBe(true);
    expect(JSON.stringify(db.calendar.upsert.mock.calls)).not.toContain("10.0.0.1");
    expect(JSON.stringify(db.calendar.upsert.mock.calls)).not.toContain("169.254");
    await app.close();
  });

  it("caps NEW links per provider, before any request, and always allows a re-link", async () => {
    db.calendar.count.mockResolvedValue(10);
    const server = fakeCaldavServer(ICLOUD_OK);
    const { app, headers } = await buildApp(server);
    const body = { provider: "ICLOUD", username: "me@icloud.com", password: PASSWORD };
    const refused = await app.inject({ ...link(body), headers });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({ ok: false, message: "At most 10 iCloud calendars." });
    expect(server.calls).toEqual([]);
    expect(db.calendar.count).toHaveBeenCalledWith({
      where: { userId: "user-1", provider: "ICLOUD" },
    });

    db.calendar.findUnique.mockResolvedValue({ id: "existing" });
    const relink = await app.inject({ ...link(body), headers });
    expect(relink.statusCode).toBe(200);
    await app.close();
  });

  it("the legacy (userId, email) unique: the generic answer, not a 500", async () => {
    db.calendar.upsert.mockRejectedValue(Object.assign(new Error("Unique"), { code: "P2002" }));
    const { app, headers } = await buildApp(fakeCaldavServer(ICLOUD_OK));
    const res = await app.inject({
      ...link({ provider: "ICLOUD", username: "me@icloud.com", password: PASSWORD }),
      headers,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ ok: false, message: GENERIC });
    await app.close();
  });

  it("rate limits link attempts like the IMAP connect route: the 6th in 15 minutes is a 429", async () => {
    const server = fakeCaldavServer({ "PROPFIND caldav.icloud.com /": { status: 401 } });
    const { app, headers } = await buildApp(server, { withRateLimit: true });
    const statuses: number[] = [];
    for (let n = 0; n < 6; n += 1) {
      const res = await app.inject({
        ...link({ provider: "ICLOUD", username: "me@icloud.com", password: PASSWORD }),
        headers,
      });
      statuses.push(res.statusCode);
    }
    expect(statuses).toEqual([400, 400, 400, 400, 400, 429]);
    await app.close();
  });
});

describe("POST /link: per-account limit (review fix 2026-10-02)", () => {
  async function attempts(bodies: Array<{ username: string; ip: string }>) {
    const server = fakeCaldavServer({ "PROPFIND caldav.icloud.com /": { status: 401 } });
    const { app, headers } = await buildApp(server, { withRateLimit: true });
    const statuses: number[] = [];
    for (const { username, ip } of bodies) {
      const res = await app.inject({
        ...link({ provider: "ICLOUD", username, password: PASSWORD }),
        headers,
        remoteAddress: ip,
      });
      statuses.push(res.statusCode);
    }
    await app.close();
    return { statuses, server };
  }

  it("one Apple ID from six IPs: the 6th attempt is refused before Apple is asked", async () => {
    const spellings = [
      "me@icloud.com",
      " Me@iCloud.com ",
      "ME@ICLOUD.COM",
      "me@icloud.com",
      "me@icloud.com",
      "me@icloud.com",
    ];
    const { statuses, server } = await attempts(
      spellings.map((username, n) => ({ username, ip: `10.0.0.${n + 1}` })),
    );
    expect(statuses).toEqual([400, 400, 400, 400, 400, 429]);
    expect(server.calls).toHaveLength(5);
  });

  it("six Apple IDs from one IP: the IP limit still refuses the 6th", async () => {
    const { statuses } = await attempts(
      Array.from({ length: 6 }, (_, n) => ({ username: `u${n}@icloud.com`, ip: "10.0.0.9" })),
    );
    expect(statuses).toEqual([400, 400, 400, 400, 400, 429]);
  });

  it("different Apple IDs from different IPs are not limited by each other", async () => {
    const { statuses } = await attempts(
      Array.from({ length: 6 }, (_, n) => ({ username: `u${n}@icloud.com`, ip: `10.0.1.${n}` })),
    );
    expect(statuses).toEqual([400, 400, 400, 400, 400, 400]);
  });
});

describe("POST /link reusing the linked inbox's app password", () => {
  it("reads the user's own inbox row of the same provider and address, verifies, stores a copy", async () => {
    db.inbox.findUnique.mockResolvedValue({ imapPasswordCipher: `enc:${PASSWORD}` });
    const server = fakeCaldavServer(ICLOUD_OK);
    const { app, headers } = await buildApp(server);
    const res = await app.inject({
      ...link({ provider: "ICLOUD", username: "me@icloud.com", reuseInboxPassword: true }),
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(db.inbox.findUnique).toHaveBeenCalledWith({
      where: {
        userId_provider_email: { userId: "user-1", provider: "ICLOUD", email: "me@icloud.com" },
      },
      select: { imapPasswordCipher: true },
    });
    expect(db.calendar.upsert.mock.calls[0]?.[0]).toMatchObject({
      create: { caldavPasswordCipher: `enc:${PASSWORD}` },
    });
    expect(res.body).not.toContain(PASSWORD);
    await app.close();
  });

  it.each([
    ["no such inbox", null],
    ["an inbox with no password", { imapPasswordCipher: null }],
    ["an undecryptable password", { imapPasswordCipher: "rotten" }],
  ])("%s: the generic answer, no request", async (_label, inbox) => {
    db.inbox.findUnique.mockResolvedValue(inbox);
    const server = fakeCaldavServer(ICLOUD_OK);
    const { app, headers } = await buildApp(server);
    const res = await app.inject({
      ...link({ provider: "ICLOUD", username: "me@icloud.com", reuseInboxPassword: true }),
      headers,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ ok: false, message: GENERIC });
    expect(server.calls).toEqual([]);
    await app.close();
  });
});

describe("GET /linked-calendars and DELETE /linked-calendars/:id", () => {
  it("lists the user's iCloud and Naver calendar accounts, never a password", async () => {
    db.calendar.findMany.mockResolvedValue([
      {
        id: "a",
        provider: "ICLOUD",
        email: "me@icloud.com",
        createdAt: new Date(0),
        needsReconnect: false,
      },
    ]);
    const { app, headers } = await buildApp(fakeCaldavServer({}));
    const res = await app.inject({
      method: "GET",
      url: "/api/caldav-calendar/linked-calendars",
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(db.calendar.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1", provider: { in: ["ICLOUD", "NAVER"] } },
      select: { id: true, provider: true, email: true, createdAt: true, needsReconnect: true },
      orderBy: { createdAt: "asc" },
    });
    expect(res.body).not.toContain("caldavPasswordCipher");
    await app.close();
  });

  it("unlinks one of the user's CalDAV accounts with its provider, so no other surface's account can go", async () => {
    db.calendar.findFirst.mockResolvedValue({ provider: "NAVER" });
    const { app, headers } = await buildApp(fakeCaldavServer({}));
    const res = await app.inject({
      method: "DELETE",
      url: "/api/caldav-calendar/linked-calendars/row-9",
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(db.calendar.findFirst).toHaveBeenCalledWith({
      where: { id: "row-9", userId: "user-1", provider: { in: ["ICLOUD", "NAVER"] } },
      select: { provider: true },
    });
    expect(db.unlinkCalendarAccount).toHaveBeenCalledWith("user-1", "row-9", "NAVER");
    await app.close();
  });

  it("404 for an id that is not one of the user's CalDAV accounts", async () => {
    db.calendar.findFirst.mockResolvedValue(null);
    const { app, headers } = await buildApp(fakeCaldavServer({}));
    const res = await app.inject({
      method: "DELETE",
      url: "/api/caldav-calendar/linked-calendars/google-row",
      headers,
    });
    expect(res.statusCode).toBe(404);
    expect(db.unlinkCalendarAccount).not.toHaveBeenCalled();
    await app.close();
  });
});
