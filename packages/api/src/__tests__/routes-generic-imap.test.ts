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
  create: vi.fn(async (_args?: unknown) => ({ id: "row-1" })),
  updateMany: vi.fn(async (_args?: unknown) => ({ count: 1 })),
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

/** A generic connect stores through a conditional create or update, never an upsert. */
function expectNothingStored() {
  expect(db.create).not.toHaveBeenCalled();
  expect(db.updateMany).not.toHaveBeenCalled();
  expect(db.upsert).not.toHaveBeenCalled();
}

const GOOD = { email: "me@fastmail.com", password: "app-pw-1234", host: "imap.fastmail.com" };
const GENERIC_FAILURE = "Could not connect securely to that server.";

beforeEach(() => {
  vi.clearAllMocks();
  db.findMany.mockResolvedValue([]);
  db.findUnique.mockResolvedValue(null);
  db.count.mockResolvedValue(0);
  // Fresh defaults: a test's stateful store must not leak into the next one.
  db.create.mockImplementation(async () => ({ id: "row-1" }));
  db.updateMany.mockImplementation(async () => ({ count: 1 }));
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
    expectNothingStored();
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
    expect(db.create).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        provider: "IMAP",
        email: "me@fastmail.com",
        imapHost: "imap.fastmail.com:993",
        imapPasswordCipher: "cipher",
      },
    });
    expect(db.upsert).not.toHaveBeenCalled(); // an upsert could re-point a row another request just made
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
    expectNothingStored();
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
    expectNothingStored();
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
    expectNothingStored();
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
    expectNothingStored();
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
    expectNothingStored();
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
    // Conditional on the host the account had when it was checked, and only that row.
    expect(db.updateMany).toHaveBeenCalledWith({
      where: { id: "row-9", userId: "user-1", provider: "IMAP", imapHost: "imap.fastmail.com:993" },
      data: {
        imapHost: "imap.fastmail.com:993",
        imapPasswordCipher: "cipher",
        needsReconnect: false,
      },
    });
    expect(db.create).not.toHaveBeenCalled();
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
    expectNothingStored();
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

  describe("the re-point refusal is atomic (a check-then-write race cannot defeat it)", () => {
    interface StoredRow {
      id: string;
      userId: string;
      provider: string;
      email: string;
      imapHost: string;
      imapPasswordCipher: string;
      needsReconnect?: boolean;
    }

    /** An in-memory LinkedInboxAccount with the unique (user, provider, email) key. */
    function useStatefulStore() {
      const rows = new Map<string, StoredRow>();
      const keyOf = (r: { userId: string; provider: string; email: string }) =>
        `${r.userId}|${r.provider}|${r.email}`;
      db.findUnique.mockImplementation((async (args: {
        where: { userId_provider_email: { userId: string; provider: string; email: string } };
      }) => {
        // A copy, like Prisma returns: the caller's snapshot must not follow later writes.
        const row = rows.get(keyOf(args.where.userId_provider_email));
        return row ? { ...row } : null;
      }) as never);
      db.count.mockImplementation((async () => rows.size) as never);
      db.create.mockImplementation((async (args: { data: Omit<StoredRow, "id"> }) => {
        const key = keyOf(args.data);
        if (rows.has(key))
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        const row = { id: `row-${rows.size + 1}`, ...args.data };
        rows.set(key, row);
        return row;
      }) as never);
      db.updateMany.mockImplementation((async (args: {
        where: { id: string; userId: string; provider: string; imapHost?: string };
        data: Partial<StoredRow>;
      }) => {
        const row = [...rows.values()].find(
          (r) =>
            r.id === args.where.id &&
            r.userId === args.where.userId &&
            r.provider === args.where.provider &&
            (args.where.imapHost === undefined || r.imapHost === args.where.imapHost),
        );
        if (!row) return { count: 0 };
        Object.assign(row, args.data);
        return { count: 1 };
      }) as never);
      return rows;
    }

    /** Both verifies are in flight before either request writes: the worst interleaving. */
    function interleaveVerifies(requests: number) {
      let arrived = 0;
      let release: () => void = () => {};
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      imapSync.verifyImapCredentials.mockImplementation(async () => {
        arrived += 1;
        if (arrived >= requests) release();
        await barrier;
        return { ok: true };
      });
    }

    it("two concurrent FIRST connects to different hosts: exactly one wins, the other is refused", async () => {
      const rows = useStatefulStore();
      interleaveVerifies(2);
      const { app, headers } = await buildApp();

      const [a, b] = await Promise.all([
        connect(app, headers, { ...GOOD, host: "imap.fastmail.com" }),
        connect(app, headers, { ...GOOD, host: "imap.other-server.example.net" }),
      ]);

      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
      const winner = a.statusCode === 200 ? a : b;
      expect(rows.size).toBe(1);
      expect([...rows.values()][0].imapHost).toBe(winner.json().host);
      const loser = a.statusCode === 409 ? a : b;
      expect(loser.json().message).toBe(
        "Disconnect this account first; changing the server is not supported yet.",
      );
      await app.close();
    });

    it("two concurrent first connects to the SAME host both succeed (a double click is not a re-point)", async () => {
      const rows = useStatefulStore();
      interleaveVerifies(2);
      const { app, headers } = await buildApp();

      const [a, b] = await Promise.all([connect(app, headers, GOOD), connect(app, headers, GOOD)]);

      expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
      expect(rows.size).toBe(1);
      expect([...rows.values()][0].imapHost).toBe("imap.fastmail.com:993");
      await app.close();
    });

    it("an existing account whose host changed between the check and the write is refused, not overwritten", async () => {
      const rows = useStatefulStore();
      rows.set("user-1|IMAP|me@fastmail.com", {
        id: "row-9",
        userId: "user-1",
        provider: "IMAP",
        email: "me@fastmail.com",
        imapHost: "imap.fastmail.com:993",
        imapPasswordCipher: "old",
      });
      // While the verify runs, another request re-points the row.
      imapSync.verifyImapCredentials.mockImplementation(async () => {
        const row = rows.get("user-1|IMAP|me@fastmail.com") as StoredRow;
        row.imapHost = "imap.sneaky.example.net:993";
        return { ok: true };
      });
      const { app, headers } = await buildApp();

      const res = await connect(app, headers, GOOD);

      expect(res.statusCode).toBe(409);
      expect(rows.get("user-1|IMAP|me@fastmail.com")).toMatchObject({
        imapHost: "imap.sneaky.example.net:993",
        imapPasswordCipher: "old", // the new password was NOT stored against the other host
      });
      await app.close();
    });

    it("a unique-key collision whose winner has a different host is the same constant refusal", async () => {
      db.findUnique
        .mockResolvedValueOnce(null as never) // the first look: nothing yet
        .mockResolvedValueOnce({ id: "row-2", imapHost: "imap.other.example.net:993" } as never);
      db.create.mockRejectedValueOnce(
        Object.assign(new Error("Unique constraint"), { code: "P2002" }),
      );
      const { app, headers } = await buildApp();
      const res = await connect(app, headers, GOOD);
      expect(res.statusCode).toBe(409);
      expect(db.updateMany).not.toHaveBeenCalled();
      await app.close();
    });

    it("any other database error is not mistaken for a collision", async () => {
      db.create.mockRejectedValueOnce(
        Object.assign(new Error("connection lost"), { code: "P1001" }),
      );
      const { app, headers } = await buildApp();
      const res = await connect(app, headers, GOOD);
      expect(res.statusCode).toBe(500);
      await app.close();
    });
  });

  describe("a relink starts the poll over", () => {
    it("clears the account's poll backoff (a new account too)", async () => {
      const { app, headers } = await buildApp();
      // buildApp reset the module registry, so this is the instance the route uses.
      const backoff = await import("../mail/imap-poll-backoff.js");
      backoff.notePollBackoff("row-9");
      db.findUnique.mockResolvedValue({ id: "row-9", imapHost: "imap.fastmail.com:993" } as never);

      expect((await connect(app, headers, GOOD)).statusCode).toBe(200);

      expect(backoff.isPollBackedOff("row-9")).toBe(false);
      await app.close();
    });

    it("clears the backoff of a newly created account (a recycled id is never left backed off)", async () => {
      const { app, headers } = await buildApp();
      const backoff = await import("../mail/imap-poll-backoff.js");
      backoff.notePollBackoff("row-1");
      expect((await connect(app, headers, GOOD)).statusCode).toBe(200);
      expect(backoff.isPollBackedOff("row-1")).toBe(false);
      await app.close();
    });

    it("a refused connect leaves the backoff alone", async () => {
      const { app, headers } = await buildApp();
      const backoff = await import("../mail/imap-poll-backoff.js");
      backoff.notePollBackoff("row-9");
      db.findUnique.mockResolvedValue({
        id: "row-9",
        imapHost: "imap.old-server.example.org:993",
      } as never);
      expect((await connect(app, headers, GOOD)).statusCode).toBe(409);
      expect(backoff.isPollBackedOff("row-9")).toBe(true);
      await app.close();
    });
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
