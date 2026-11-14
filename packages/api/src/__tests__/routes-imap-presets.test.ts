/**
 * The preset connect routes (/api/<preset>-imap/*): dark while IMAP_PRESETS_ENABLED is
 * off (a cloaked 404 even before authentication), open to the rollout cohort only in
 * cohort mode, and pinned to the preset's own host whatever the body says.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  findMany: vi.fn(async () => []),
  findFirst: vi.fn(async () => null),
  findUnique: vi.fn(async () => null),
  count: vi.fn(async () => 0),
  upsert: vi.fn(async () => ({ id: "row-1" })),
  deleteMany: vi.fn(async () => ({ count: 0 })),
}));

vi.mock("../db.js", () => {
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({ id: "user-1", plan: "PRO", role: "USER" })),
      update: vi.fn(async () => ({ id: "user-1" })),
    },
    userToken: { findFirst: vi.fn(async () => ({ id: "google-token" })) },
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
const startFirstImapSync = vi.hoisted(() => vi.fn((..._args: unknown[]) => true));
vi.mock("../mail/imap-first-sync.js", () => ({ startFirstImapSync }));
const verifyImapCredentials = vi.hoisted(() =>
  vi.fn(
    async (..._args: unknown[]): Promise<{ ok: boolean; message?: string; code?: string }> => ({
      ok: true,
    }),
  ),
);
vi.mock("../mail/imap-sync.js", () => ({ verifyImapCredentials }));

const ENV = ["IMAP_PRESETS_ENABLED", "ROLLOUT_COHORT_USER_IDS"] as const;
const ORIGINAL = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));

async function buildApp() {
  vi.resetModules();
  const { signToken } = await import("../auth.js");
  const { registerImapPresetRoutes } = await import("../routes/imap-preset-routes.js");
  const app = Fastify();
  await registerImapPresetRoutes(app);
  await app.ready();
  const token = signToken({ userId: "user-1", email: "test@example.com" });
  return { app, headers: { authorization: `Bearer ${token}` } };
}

const BODY = { email: "someone@example.com", password: "app-password-1" };

beforeEach(() => {
  vi.clearAllMocks();
  db.findMany.mockResolvedValue([]);
  db.findUnique.mockResolvedValue(null);
  db.findFirst.mockResolvedValue(null);
  db.count.mockResolvedValue(0);
  verifyImapCredentials.mockResolvedValue({ ok: true });
});

afterEach(() => {
  for (const name of ENV) {
    const value = ORIGINAL[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.resetModules();
});

const SLUGS = ["daum", "kakao", "yahoo", "aol", "fastmail", "zoho", "zohopro"] as const;

describe("flag off (default): the preset surface does not exist", () => {
  it.each(SLUGS)("every /api/%s-imap route answers 404, authenticated or not", async (slug) => {
    delete process.env.IMAP_PRESETS_ENABLED;
    const { app, headers } = await buildApp();
    for (const [method, path] of [
      ["GET", "status"],
      ["POST", "connect"],
      ["POST", "disconnect"],
    ] as const) {
      const url = `/api/${slug}-imap/${path}`;
      const authed = await app.inject({ method, url, headers, payload: BODY });
      const anonymous = await app.inject({ method, url, payload: BODY });
      expect(authed.statusCode).toBe(404);
      expect(anonymous.statusCode).toBe(404);
    }
    expect(verifyImapCredentials).not.toHaveBeenCalled();
    expect(db.upsert).not.toHaveBeenCalled();
  });
});

describe("cohort mode", () => {
  it("lets a cohort user in", async () => {
    process.env.IMAP_PRESETS_ENABLED = "cohort";
    process.env.ROLLOUT_COHORT_USER_IDS = "user-1";
    const { app, headers } = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/yahoo-imap/status", headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ connected: false, accounts: [] });
  });

  it("answers 404 to anyone outside the cohort, and never connects", async () => {
    process.env.IMAP_PRESETS_ENABLED = "cohort";
    process.env.ROLLOUT_COHORT_USER_IDS = "someone-else";
    const { app, headers } = await buildApp();
    const status = await app.inject({ method: "GET", url: "/api/yahoo-imap/status", headers });
    const connect = await app.inject({
      method: "POST",
      url: "/api/yahoo-imap/connect",
      headers,
      payload: BODY,
    });
    expect(status.statusCode).toBe(404);
    expect(connect.statusCode).toBe(404);
    expect(verifyImapCredentials).not.toHaveBeenCalled();
  });
});

describe("flag on: connect is pinned to the preset's host", () => {
  const CASES = [
    ["daum", "DAUM", "imap.daum.net:993"],
    ["kakao", "KAKAO", "imap.kakao.com:993"],
    ["yahoo", "YAHOO", "imap.mail.yahoo.com:993"],
    ["aol", "AOL", "imap.aol.com:993"],
    ["fastmail", "FASTMAIL", "imap.fastmail.com:993"],
    ["zoho", "ZOHO", "imap.zoho.com:993"],
    ["zohopro", "ZOHOPRO", "imappro.zoho.com:993"],
  ] as const;

  it.each(
    CASES,
  )("%s: no host in the body → verifies and stores %s on its fixed host", async (slug, provider, host) => {
    process.env.IMAP_PRESETS_ENABLED = "true";
    const { app, headers } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/${slug}-imap/connect`,
      headers,
      payload: BODY,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, host });
    expect(verifyImapCredentials).toHaveBeenCalledTimes(1);
    const verifyArgs = verifyImapCredentials.mock.calls[0]?.[0] as {
      host: string;
      provider: { provider: string };
    };
    expect(verifyArgs.host).toBe(host);
    expect(verifyArgs.provider.provider).toBe(provider);
    const upsertArgs = (db.upsert.mock.calls as unknown as Array<[{ create: unknown }]>)[0]?.[0];
    expect(upsertArgs?.create).toMatchObject({
      provider,
      imapHost: host,
      imapPasswordCipher: "cipher",
    });
  });

  it.each([
    "attacker.example.com:993",
    "127.0.0.1:993",
    "169.254.169.254:993",
    "imap.naver.com:993",
    "imap.mail.me.com:993",
    "imap.zoho.com:993", // another preset's host
    "imap.mail.yahoo.com:143",
  ])("refuses a body host of %s before any connection", async (host) => {
    process.env.IMAP_PRESETS_ENABLED = "true";
    const { app, headers } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/yahoo-imap/connect",
      headers,
      payload: { ...BODY, host },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/Unsupported IMAP host/);
    expect(verifyImapCredentials).not.toHaveBeenCalled();
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it("a refused login answers 400 with the localizable code and stores nothing", async () => {
    process.env.IMAP_PRESETS_ENABLED = "true";
    verifyImapCredentials.mockResolvedValueOnce({
      ok: false,
      message: "Fastmail IMAP login failed.",
      code: "IMAP_AUTH_FAILED",
    });
    const { app, headers } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/fastmail-imap/connect",
      headers,
      payload: BODY,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ ok: false, code: "IMAP_AUTH_FAILED" });
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it("a re-verify of a flagged account clears the reconnect state", async () => {
    process.env.IMAP_PRESETS_ENABLED = "true";
    db.findUnique.mockResolvedValueOnce({
      id: "row-1",
      imapHost: "imap.aol.com:993",
      email: BODY.email,
    } as never);
    const { app, headers } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/aol-imap/connect",
      headers,
      payload: BODY,
    });
    expect(res.statusCode).toBe(200);
    const upsertArgs = (db.upsert.mock.calls as unknown as Array<[{ update: unknown }]>)[0]?.[0];
    expect(upsertArgs?.update).toMatchObject({
      needsReconnect: false,
      syncErrorCode: null,
      syncErrorAt: null,
    });
  });
});

describe("abuse limits", () => {
  it("stores the registry host, not the spelling the body sent", async () => {
    process.env.IMAP_PRESETS_ENABLED = "true";
    const { app, headers } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/yahoo-imap/connect",
      headers,
      payload: { ...BODY, host: "IMAP.Mail.Yahoo.com" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ host: "imap.mail.yahoo.com:993" });
    const verifyArgs = verifyImapCredentials.mock.calls[0]?.[0] as { host: string };
    expect(verifyArgs.host).toBe("imap.mail.yahoo.com:993");
    const upsertArgs = (db.upsert.mock.calls as unknown as Array<[{ create: unknown }]>)[0]?.[0];
    expect(upsertArgs?.create).toMatchObject({ imapHost: "imap.mail.yahoo.com:993" });
  });

  it("one per-user budget of connect attempts covers every preset, then 429 without connecting", async () => {
    process.env.IMAP_PRESETS_ENABLED = "true";
    verifyImapCredentials.mockResolvedValue({ ok: false, message: "no", code: "IMAP_AUTH_FAILED" });
    const { app, headers } = await buildApp();
    const slugs = ["daum", "kakao", "yahoo", "aol", "fastmail", "zoho", "zohopro"];
    const codes: number[] = [];
    for (let attempt = 0; attempt < 11; attempt++) {
      const res = await app.inject({
        method: "POST",
        url: `/api/${slugs[attempt % slugs.length]}-imap/connect`,
        headers,
        payload: BODY,
      });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 10)).toEqual(Array(10).fill(400));
    expect(codes[10]).toBe(429);
    expect(verifyImapCredentials).toHaveBeenCalledTimes(10);
  });
});
