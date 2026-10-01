/**
 * Step B4: the generic IMAP connect surface (/api/generic-imap). Dark until
 * GENERIC_IMAP_ENABLED: while the flag is off every route, authenticated or not,
 * answers exactly like an unregistered one. With it on, the connect route takes a
 * user-supplied host, but only a DNS name on port 993 (validated BEFORE any
 * network work and before an attempt is counted), at most 10 attempts an hour per
 * user, credentials verified through the pinned connection, and one message for
 * every kind of connection failure.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ plan: "PRO", role: "USER" }));

const db = vi.hoisted(() => ({
  findMany: vi.fn(async () => []),
  findUnique: vi.fn(async () => null),
  count: vi.fn(async () => 0),
  upsert: vi.fn(async () => ({ id: "row-1" })),
  deleteMany: vi.fn(async () => ({ count: 0 })),
}));

const imapSync = vi.hoisted(() => ({
  verifyImapCredentials: vi.fn(
    async (): Promise<{ ok: boolean; message?: string }> => ({
      ok: true,
    }),
  ),
}));

vi.mock("../db.js", () => {
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({ id: "user-1", plan: state.plan, role: state.role })),
      update: vi.fn(async () => ({ id: "user-1" })),
    },
    linkedInboxAccount: db,
    device: {
      findUnique: vi.fn(async () => ({ id: "device-1" })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../crypto-tokens.js", () => ({ encryptToken: vi.fn(() => "cipher") }));
vi.mock("../mail/imap-sync.js", () => ({
  verifyImapCredentials: (...args: unknown[]) =>
    (imapSync.verifyImapCredentials as (...a: unknown[]) => unknown)(...args),
}));

const ORIGINAL_FLAG = process.env.GENERIC_IMAP_ENABLED;
const PREFIX = "/api/generic-imap";

async function buildApp() {
  vi.resetModules();
  const { signToken } = await import("../auth.js");
  const { imapConnectRoutes } = await import("../routes/imap-connect.js");
  const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");
  const { genericImapEnabled } = await import("../config.js");
  const app = Fastify();
  await app.register(imapConnectRoutes(IMAP_PROVIDERS.IMAP, { gate: genericImapEnabled }), {
    prefix: PREFIX,
  });
  await app.ready();
  const token = signToken({ userId: "user-1", email: "test@example.com" });
  return { app, headers: { authorization: `Bearer ${token}` } };
}

const connect = (
  app: Awaited<ReturnType<typeof buildApp>>["app"],
  headers: object,
  payload: object,
) => app.inject({ method: "POST", url: `${PREFIX}/connect`, headers, payload });

const GOOD = { email: "me@fastmail.com", password: "app-pw-1234", host: "imap.fastmail.com" };
const GENERIC_FAILURE = "Could not connect securely to that server.";

beforeEach(() => {
  vi.clearAllMocks();
  db.findMany.mockResolvedValue([]);
  db.findUnique.mockResolvedValue(null);
  db.count.mockResolvedValue(0);
  imapSync.verifyImapCredentials.mockResolvedValue({ ok: true });
  state.plan = "PRO";
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.GENERIC_IMAP_ENABLED;
  else process.env.GENERIC_IMAP_ENABLED = ORIGINAL_FLAG;
  vi.resetModules();
});

describe("flag OFF (default): the surface does not exist", () => {
  it.each([
    ["GET", `${PREFIX}/status`],
    ["POST", `${PREFIX}/connect`],
    ["POST", `${PREFIX}/disconnect`],
  ] as const)("%s %s answers 404 even when authenticated, and touches nothing", async (method, url) => {
    delete process.env.GENERIC_IMAP_ENABLED;
    const { app, headers } = await buildApp();
    const res = await app.inject({
      method,
      url,
      headers,
      ...(method === "POST" ? { payload: GOOD } : {}),
    });
    expect(res.statusCode).toBe(404);
    expect(imapSync.verifyImapCredentials).not.toHaveBeenCalled();
    expect(db.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("answers 404 unauthenticated too, byte-identical to Fastify's default 404", async () => {
    delete process.env.GENERIC_IMAP_ENABLED;
    const { app } = await buildApp();
    const gated = await app.inject({ method: "GET", url: `${PREFIX}/status` });
    const unregistered = await app.inject({ method: "GET", url: `${PREFIX}/nope` });
    expect(gated.statusCode).toBe(404);
    expect(gated.json()).toEqual({
      message: `Route GET:${PREFIX}/status not found`,
      error: "Not Found",
      statusCode: 404,
    });
    expect(unregistered.json()).toEqual({
      message: `Route GET:${PREFIX}/nope not found`,
      error: "Not Found",
      statusCode: 404,
    });
    await app.close();
  });
});

describe("flag ON: connect with a user-supplied host", () => {
  beforeEach(() => {
    process.env.GENERIC_IMAP_ENABLED = "true";
  });

  it("verifies through the pinned path, then stores the folded host and an encrypted password", async () => {
    const { app, headers } = await buildApp();
    const res = await connect(app, headers, { ...GOOD, host: "  IMAP.Fastmail.COM:993 " });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      email: "me@fastmail.com",
      host: "imap.fastmail.com:993",
    });
    expect(imapSync.verifyImapCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: expect.objectContaining({ provider: "IMAP" }),
        email: "me@fastmail.com",
        password: "app-pw-1234",
        host: "imap.fastmail.com:993",
      }),
    );
    expect(db.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_provider_email: { userId: "user-1", provider: "IMAP", email: "me@fastmail.com" },
        },
        create: expect.objectContaining({
          userId: "user-1",
          provider: "IMAP",
          email: "me@fastmail.com",
          imapHost: "imap.fastmail.com:993",
          imapPasswordCipher: "cipher",
        }),
        update: expect.objectContaining({
          imapHost: "imap.fastmail.com:993",
          imapPasswordCipher: "cipher",
          needsReconnect: false,
        }),
      }),
    );
    await app.close();
  });

  it("stores an IDN host in punycode", async () => {
    const { app, headers } = await buildApp();
    const res = await connect(app, headers, { ...GOOD, host: "münchen.de" });
    expect(res.json().host).toBe("xn--mnchen-3ya.de:993");
    await app.close();
  });

  it("a host is required (there is no default for a user host)", async () => {
    const { app, headers } = await buildApp();
    const res = await connect(app, headers, { email: GOOD.email, password: GOOD.password });
    expect(res.statusCode).toBe(400);
    expect(res.json().ok).toBe(false);
    expect(imapSync.verifyImapCredentials).not.toHaveBeenCalled();
    expect(db.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    "127.0.0.1",
    "127.0.0.1:993",
    "169.254.169.254",
    "10.0.0.1:993",
    "[::1]:993",
    "2130706433",
    "localhost",
    "printer.local",
    "metadata.google.internal",
    "imap.fastmail.com:143",
    "imap.fastmail.com:587",
    "user@imap.fastmail.com",
    "imap.fastmail.com/path",
    "imap.fastmail.com.",
    "http://imap.fastmail.com",
  ])("refuses %j before any connection, without counting an attempt", async (host) => {
    const { app, headers } = await buildApp();
    const res = await connect(app, headers, { ...GOOD, host });
    expect(res.statusCode).toBe(400);
    expect(res.json().ok).toBe(false);
    expect(typeof res.json().message).toBe("string");
    expect(imapSync.verifyImapCredentials).not.toHaveBeenCalled();
    expect(db.upsert).not.toHaveBeenCalled();
    // Static input errors never reveal network state, and use no attempt: ten of
    // them in a row still leave the full budget for a real connect.
    for (let i = 0; i < 12; i++) await connect(app, headers, { ...GOOD, host });
    const ok = await connect(app, headers, GOOD);
    expect(ok.statusCode).toBe(200);
    await app.close();
  });

  it("every connection failure is the same message, whatever the cause", async () => {
    const { app, headers } = await buildApp();
    const messages = new Set<string>();
    for (const leak of [
      "Could not reach imap.fastmail.com:993: connect ECONNREFUSED 10.0.0.5:993",
      "getaddrinfo ENOTFOUND imap.fastmail.com",
      "Hostname/IP does not match certificate's altnames",
      "Connection timeout",
      "host did not resolve to a public address",
    ]) {
      imapSync.verifyImapCredentials.mockResolvedValueOnce({ ok: false, message: leak });
      const res = await connect(app, headers, GOOD);
      expect(res.statusCode).toBe(400);
      messages.add(res.json().message);
    }
    expect([...messages]).toEqual([GENERIC_FAILURE]);
    expect(db.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("a rejected login keeps the login hint and stores nothing", async () => {
    const { app, headers } = await buildApp();
    const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");
    imapSync.verifyImapCredentials.mockResolvedValueOnce({
      ok: false,
      message: IMAP_PROVIDERS.IMAP.authFailureHint,
    });
    const res = await connect(app, headers, GOOD);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe(IMAP_PROVIDERS.IMAP.authFailureHint);
    expect(db.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("allows 10 connect attempts an hour per user, then answers 429 without connecting", async () => {
    const { app, headers } = await buildApp();
    imapSync.verifyImapCredentials.mockResolvedValue({ ok: false, message: "whatever" });
    for (let i = 0; i < 10; i++) {
      expect((await connect(app, headers, GOOD)).statusCode).toBe(400);
    }
    expect(imapSync.verifyImapCredentials).toHaveBeenCalledTimes(10);

    const limited = await connect(app, headers, GOOD);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ ok: false });
    expect(limited.json().message).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    expect(imapSync.verifyImapCredentials).toHaveBeenCalledTimes(10);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    await app.close();
  });

  it("caps NEW accounts at 3 without connecting; re-verifying an existing one is always allowed", async () => {
    const { app, headers } = await buildApp();
    db.count.mockResolvedValue(3);
    const refused = await connect(app, headers, GOOD);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toBe("At most 3 IMAP accounts.");
    expect(imapSync.verifyImapCredentials).not.toHaveBeenCalled();

    db.findUnique.mockResolvedValue({ id: "row-9", imapHost: "imap.fastmail.com:993" } as never);
    const reverify = await connect(app, headers, GOOD);
    expect(reverify.statusCode).toBe(200);
    await app.close();
  });

  it("REFUSES to re-point an existing account at another host: constant 409, nothing verified or stored", async () => {
    const { app, headers } = await buildApp();
    db.findUnique.mockResolvedValue({
      id: "row-9",
      imapHost: "imap.old-server.example.org:993",
    } as never);

    const res = await connect(app, headers, GOOD);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      ok: false,
      message: "Disconnect this account first; changing the server is not supported yet.",
    });
    expect(imapSync.verifyImapCredentials).not.toHaveBeenCalled();
    expect(db.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("the 409 does not depend on what the new host is, and reveals nothing about either host", async () => {
    const { app, headers } = await buildApp();
    db.findUnique.mockResolvedValue({
      id: "row-9",
      imapHost: "imap.old-server.example.org:993",
    } as never);
    const bodies = new Set<string>();
    for (const host of ["imap.fastmail.com", "mail.other.example.net:993", "imap.daum.net"]) {
      const res = await connect(app, headers, { ...GOOD, host });
      expect(res.statusCode).toBe(409);
      bodies.add(res.body);
    }
    expect(bodies.size).toBe(1);
    expect([...bodies][0]).not.toMatch(/fastmail|old-server|other|daum/);
    await app.close();
  });

  it("refuses without counting an attempt (twelve refusals leave the whole budget for the re-link)", async () => {
    const { app, headers } = await buildApp();
    db.findUnique.mockResolvedValue({
      id: "row-9",
      imapHost: "imap.old-server.example.org:993",
    } as never);
    for (let i = 0; i < 12; i++) expect((await connect(app, headers, GOOD)).statusCode).toBe(409);

    db.findUnique.mockResolvedValue({ id: "row-9", imapHost: "imap.fastmail.com:993" } as never);
    expect((await connect(app, headers, GOOD)).statusCode).toBe(200);
    await app.close();
  });

  it("the SAME host still re-links (password rotation): verified, stored, reconnect flag cleared", async () => {
    const { app, headers } = await buildApp();
    db.findUnique.mockResolvedValue({ id: "row-9", imapHost: "imap.fastmail.com:993" } as never);

    const res = await connect(app, headers, GOOD);

    expect(res.statusCode).toBe(200);
    expect(imapSync.verifyImapCredentials).toHaveBeenCalledTimes(1);
    expect(db.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          imapHost: "imap.fastmail.com:993",
          imapPasswordCipher: "cipher",
          needsReconnect: false,
        }),
      }),
    );
    await app.close();
  });

  it.each([
    "IMAP.Fastmail.COM:993",
    "imap.fastmail.com",
    "  imap.fastmail.com:993 ",
  ])("the same host spelled %j is the same host (compared in folded form)", async (stored) => {
    const { app, headers } = await buildApp();
    db.findUnique.mockResolvedValue({ id: "row-9", imapHost: stored } as never);
    const res = await connect(app, headers, { ...GOOD, host: "imap.fastmail.com:993" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it.each([
    null,
    "",
    "127.0.0.1:993",
    "not a host",
  ])("an existing row whose stored host is unusable (%j) is not silently re-pointed either", async (stored) => {
    const { app, headers } = await buildApp();
    db.findUnique.mockResolvedValue({ id: "row-9", imapHost: stored } as never);
    const res = await connect(app, headers, GOOD);
    expect(res.statusCode).toBe(409);
    expect(db.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("a built-in provider host is refused with a pointer to the built-in connection", async () => {
    const { app, headers } = await buildApp();
    for (const host of [
      "imap.gmail.com",
      "imap.naver.com:993",
      "outlook.office365.com",
      "imap.mail.me.com",
    ]) {
      const res = await connect(app, headers, { ...GOOD, host });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toBe("Use the built-in connection for that provider instead.");
    }
    expect(imapSync.verifyImapCredentials).not.toHaveBeenCalled();
    await app.close();
  });

  it("still enforces the entitlement gate (FREE gets 403)", async () => {
    state.plan = "FREE";
    process.env.PAYWALL_ENABLED = "true";
    try {
      const { app, headers } = await buildApp();
      const res = await connect(app, headers, GOOD);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("ENTITLEMENT_REQUIRED");
      expect(imapSync.verifyImapCredentials).not.toHaveBeenCalled();
      await app.close();
    } finally {
      delete process.env.PAYWALL_ENABLED;
    }
  });

  it("GET /status reads only IMAP rows", async () => {
    const { app, headers } = await buildApp();
    const res = await app.inject({ method: "GET", url: `${PREFIX}/status`, headers });
    expect(res.statusCode).toBe(200);
    expect(db.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1", provider: "IMAP" } }),
    );
    await app.close();
  });

  it("POST /disconnect deletes IMAP rows only", async () => {
    const { app, headers } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `${PREFIX}/disconnect`,
      headers,
      payload: { email: "me@fastmail.com" },
    });
    expect(res.statusCode).toBe(200);
    expect(db.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", provider: "IMAP", email: "me@fastmail.com" },
    });
    await app.close();
  });
});

describe("fixed-host providers keep their own verify and messages", () => {
  it("Naver still answers with the allowlist message for a foreign host", async () => {
    vi.resetModules();
    process.env.GENERIC_IMAP_ENABLED = "true";
    const { signToken } = await import("../auth.js");
    const { imapConnectRoutes } = await import("../routes/imap-connect.js");
    const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");
    const app = Fastify();
    await app.register(imapConnectRoutes(IMAP_PROVIDERS.NAVER), { prefix: "/api/naver-imap" });
    await app.ready();
    const headers = {
      authorization: `Bearer ${signToken({ userId: "user-1", email: "t@example.com" })}`,
    };

    const res = await app.inject({
      method: "POST",
      url: "/api/naver-imap/connect",
      headers,
      payload: { email: "me@naver.com", password: "pw-1234", host: "imap.fastmail.com" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe("Unsupported IMAP host. Only imap.naver.com:993 is allowed.");

    imapSync.verifyImapCredentials.mockResolvedValueOnce({
      ok: false,
      message: "Could not reach imap.naver.com:993: ECONNREFUSED",
    });
    const refused = await app.inject({
      method: "POST",
      url: "/api/naver-imap/connect",
      headers,
      payload: { email: "me@naver.com", password: "pw-1234" },
    });
    // Unchanged for Naver: its verify message is passed through as before.
    expect(refused.json().message).toBe("Could not reach imap.naver.com:993: ECONNREFUSED");
    await app.close();
  });
});
