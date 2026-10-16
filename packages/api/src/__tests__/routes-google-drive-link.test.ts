/**
 * D5b: the Google Drive link routes (routes/google-drive-link.ts).
 *
 *   POST   /api/drive/google/link          start the consent (Pro-gated) → { url }
 *   GET    /api/drive/google/accounts      the user's Google Drive accounts, no token
 *   DELETE /api/drive/google/accounts/:id  unlink one: its rows, then the account
 *
 * Dark while DRIVE_ENABLED or GOOGLE_DRIVE_ENABLED is off: Fastify's default 404,
 * byte-identical to a route nobody registered, before authentication. The
 * account module underneath is the real one, over the strict fake database.
 * Unlinking never calls Google's revoke endpoint (plan, D5 "Unlink").
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
const plan = vi.hoisted(() => ({ value: "PRO" }));

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const fake = fakePrismaClient(() => dbHolder.current as FakeDb) as Record<string, unknown>;
  const prisma = new Proxy(fake, {
    get(target, prop) {
      // requireAuth's session checks and requireEntitled's plan read.
      if (prop === "device") {
        return { findUnique: async () => ({ id: "device-1" }), update: async () => ({}) };
      }
      if (prop === "user") {
        return {
          findUnique: async () => ({ id: "user-1", plan: plan.value, role: "USER" }),
        };
      }
      return Reflect.get(target, prop);
    },
  });
  return { prisma, db: prisma, INTERACTIVE_TX_OPTIONS: { maxWait: 10_000, timeout: 15_000 } };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const PREFIX = "/api/drive/google";
const fetchSpy = vi.fn(async () => {
  throw new Error("no network in this test");
});

let db: FakeDb;

function account(over: Row = {}): Row {
  return {
    id: "acct-1",
    userId: "user-1",
    provider: "GOOGLE",
    email: "me@example.com",
    accessToken: "cipher-at-SECRET",
    refreshToken: "cipher-rt-SECRET",
    grantedScopes: "openid https://www.googleapis.com/auth/drive.file",
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    ...over,
  };
}

function file(id: string, over: Row = {}): Row {
  return {
    id,
    userId: "user-1",
    provider: "GOOGLE",
    sourceKey: "acct-1",
    sourceAccountId: "acct-1",
    externalId: `ext-${id}`,
    name: `${id}.pdf`,
    modifiedAt: new Date("2026-10-02T00:00:00.000Z"),
    ...over,
  };
}

function seed(tables: Record<string, Row[]> = {}): void {
  db = createFakeDb({ linkedDriveAccount: [], driveFile: [], ...tables });
  dbHolder.current = db;
}

async function buildApp() {
  vi.resetModules();
  const { signToken, verifyToken } = await import("../auth.js");
  const { googleDriveLinkRoutes, googleDriveRoutesEnabled } = await import(
    "../routes/google-drive-link.js"
  );
  const app = Fastify();
  await app.register(googleDriveLinkRoutes({ gate: googleDriveRoutesEnabled }), { prefix: PREFIX });
  await app.ready();
  const bearer = (userId: string) => ({
    authorization: `Bearer ${signToken({ userId, email: `${userId}@example.com` })}`,
  });
  return { app, verifyToken, me: bearer("user-1"), other: bearer("user-2") };
}

beforeEach(() => {
  plan.value = "PRO";
  seed();
  vi.stubEnv("DRIVE_ENABLED", "true");
  vi.stubEnv("GOOGLE_DRIVE_ENABLED", "true");
  vi.stubEnv("GOOGLE_CLIENT_ID", "client.apps.googleusercontent.com");
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const ROUTES = [
  ["POST", "/link"],
  ["GET", "/accounts"],
  ["DELETE", "/accounts/acct-1"],
] as const;

describe("dark while either flag is off", () => {
  it.each([
    ["DRIVE_ENABLED", "POST", "/link"],
    ["DRIVE_ENABLED", "GET", "/accounts"],
    ["DRIVE_ENABLED", "DELETE", "/accounts/acct-1"],
    ["GOOGLE_DRIVE_ENABLED", "POST", "/link"],
    ["GOOGLE_DRIVE_ENABLED", "GET", "/accounts"],
    ["GOOGLE_DRIVE_ENABLED", "DELETE", "/accounts/acct-1"],
  ] as const)("%s off: %s %s answers exactly like an unregistered route", async (flag, method, path) => {
    vi.stubEnv(flag, "false");
    seed({ linkedDriveAccount: [account()], driveFile: [file("f1")] });
    const { app, me } = await buildApp();
    const unregistered = await app.inject({ method, url: `${PREFIX}/not-a-route` });
    for (const headers of [{}, me]) {
      const res = await app.inject({ method, url: `${PREFIX}${path}`, headers });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        ...unregistered.json(),
        message: `Route ${method}:${PREFIX}${path} not found`,
      });
      expect(Object.keys(res.headers).sort()).toEqual(Object.keys(unregistered.headers).sort());
    }
    // Nothing read, nothing written.
    expect(db.reads).toEqual([]);
    expect(db.writes).toEqual({});
    await app.close();
  });
});

describe("authentication", () => {
  it.each(ROUTES)("%s %s needs a session", async (method, path) => {
    const { app } = await buildApp();
    const res = await app.inject({ method, url: `${PREFIX}${path}` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("POST /link", () => {
  it("answers the consent URL with a state signed for this user", async () => {
    const { app, me, verifyToken } = await buildApp();
    const res = await app.inject({ method: "POST", url: `${PREFIX}/link`, headers: me });
    expect(res.statusCode).toBe(200);
    const { url } = res.json() as { url: string };
    const params = new URL(url).searchParams;
    expect(params.get("scope")).toBe(
      "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file",
    );
    const state = verifyToken(params.get("state") ?? "") as { userId: string; email: string };
    expect(state).toMatchObject({ userId: "user-1", email: "__link_drive__" });
    expect(db.writes).toEqual({});
    await app.close();
  });

  it("refuses a user without the plan while the paywall is on", async () => {
    vi.stubEnv("PAYWALL_ENABLED", "true");
    plan.value = "FREE";
    const { app, me } = await buildApp();
    const res = await app.inject({ method: "POST", url: `${PREFIX}/link`, headers: me });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("ENTITLEMENT_REQUIRED");
    await app.close();
  });

  it("refuses the demo user", async () => {
    const { app } = await buildApp();
    const { signToken } = await import("../auth.js");
    const demo = { authorization: `Bearer ${signToken({ userId: "demo-user", email: "d@x" })}` };
    const res = await app.inject({ method: "POST", url: `${PREFIX}/link`, headers: demo });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("GET /accounts", () => {
  it("lists this user's Google Drive accounts, oldest first, with no token on the wire", async () => {
    seed({
      linkedDriveAccount: [
        account({ id: "acct-2", email: "work@example.com", createdAt: new Date("2026-10-03") }),
        account({ needsReconnect: true }),
        account({ id: "acct-other", userId: "user-2" }),
        account({ id: "acct-od", provider: "ONEDRIVE", email: "me@outlook.com" }),
      ],
    });
    const { app, me } = await buildApp();
    const res = await app.inject({ method: "GET", url: `${PREFIX}/accounts`, headers: me });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      accounts: [
        {
          id: "acct-1",
          email: "me@example.com",
          needsReconnect: true,
          createdAt: "2026-10-01T00:00:00.000Z",
        },
        {
          id: "acct-2",
          email: "work@example.com",
          needsReconnect: false,
          createdAt: "2026-10-03T00:00:00.000Z",
        },
      ],
    });
    expect(res.body).not.toMatch(/SECRET|accessToken|refreshToken|grantedScopes|cipher/);
    await app.close();
  });

  it("is allowed without the plan, so a downgraded user can still see and unlink", async () => {
    vi.stubEnv("PAYWALL_ENABLED", "true");
    plan.value = "FREE";
    seed({ linkedDriveAccount: [account()] });
    const { app, me } = await buildApp();
    const res = await app.inject({ method: "GET", url: `${PREFIX}/accounts`, headers: me });
    expect(res.statusCode).toBe(200);
    expect(res.json().accounts).toHaveLength(1);
    await app.close();
  });
});

describe("DELETE /accounts/:id", () => {
  beforeEach(() => {
    seed({
      linkedDriveAccount: [
        account(),
        account({ id: "acct-2", email: "work@example.com" }),
        account({ id: "acct-other", userId: "user-2" }),
      ],
      driveFile: [
        file("f1"),
        file("f2"),
        file("f3", { sourceKey: "acct-2", sourceAccountId: "acct-2" }),
        file("f4", { userId: "user-2", sourceKey: "acct-other", sourceAccountId: "acct-other" }),
      ],
    });
  });

  it("removes that account and its rows only, without calling Google", async () => {
    const { app, me } = await buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: `${PREFIX}/accounts/acct-1`,
      headers: me,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect(db.tables.linkedDriveAccount?.map((r) => r.id)).toEqual(["acct-2", "acct-other"]);
    expect(db.tables.driveFile?.map((r) => r.id)).toEqual(["f3", "f4"]);
    expect(fetchSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("another user's account id answers 404 and deletes nothing", async () => {
    const { app, me } = await buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: `${PREFIX}/accounts/acct-other`,
      headers: me,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Drive account not found" });
    expect(db.tables.linkedDriveAccount).toHaveLength(3);
    expect(db.tables.driveFile).toHaveLength(4);
    await app.close();
  });

  it("an unknown id answers the same 404", async () => {
    const { app, other } = await buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: `${PREFIX}/accounts/acct-1`,
      headers: other,
    });
    expect(res.statusCode).toBe(404);
    expect(db.tables.linkedDriveAccount).toHaveLength(3);
    await app.close();
  });

  it("is allowed without the plan", async () => {
    vi.stubEnv("PAYWALL_ENABLED", "true");
    plan.value = "FREE";
    const { app, me } = await buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: `${PREFIX}/accounts/acct-1`,
      headers: me,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
