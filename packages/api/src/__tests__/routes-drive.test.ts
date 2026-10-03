/**
 * D2: the drive routes. GET /api/drive/files lists or searches the caller's file
 * metadata, GET /api/drive/files/:id reads one. Read-only, session-authenticated,
 * user-scoped, rate limited, and dark (Fastify's default 404, byte-identical to
 * an unregistered route) while DRIVE_ENABLED is off. The reader underneath is the
 * real one, over a fake database that evaluates each `where`.
 */

import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const fake = fakePrismaClient(() => dbHolder.current as FakeDb) as { driveFile: unknown };
  const prisma = {
    get driveFile() {
      return fake.driveFile;
    },
    user: { findUnique: vi.fn(async () => ({ id: "user-1", plan: "PRO", role: "USER" })) },
    device: {
      findUnique: vi.fn(async () => ({ id: "device-1" })),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import type { DriveProviderEnabledMap } from "../drive/drive-scope.js";

const PREFIX = "/api/drive";
const on = () => true;
const GOOGLE_ON: DriveProviderEnabledMap = { GOOGLE: on, KLORN: on };
const T0 = Date.parse("2026-10-01T00:00:00.000Z");

let seq = 0;
function file(over: Row = {}): Row {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    userId: "user-1",
    provider: "GOOGLE",
    sourceKey: "acct-1",
    externalId: `ext-${seq}`,
    name: `file ${seq}.pdf`,
    mimeType: "application/pdf",
    sizeBytes: 2_048n,
    modifiedAt: new Date(T0 + seq * 60_000),
    webUrl: `https://drive.google.com/file/d/ext-${seq}/view`,
    storageKey: null,
    ...over,
  };
}

let db: FakeDb;
function seed(rows: Row[]): void {
  db = createFakeDb({ driveFile: rows });
  dbHolder.current = db;
}

async function buildApp(
  opts: { withRateLimit?: boolean; providerEnabled?: DriveProviderEnabledMap } = {},
) {
  vi.resetModules();
  const { signToken } = await import("../auth.js");
  const { driveRoutes } = await import("../routes/drive.js");
  const { driveEnabled } = await import("../config.js");
  const app = Fastify();
  if (opts.withRateLimit) await app.register(rateLimit, { max: 100_000, timeWindow: "1 minute" });
  await app.register(driveRoutes({ gate: driveEnabled, providerEnabled: opts.providerEnabled }), {
    prefix: PREFIX,
  });
  await app.ready();
  const bearer = (userId: string) => ({
    authorization: `Bearer ${signToken({ userId, email: `${userId}@example.com` })}`,
  });
  return { app, me: bearer("user-1"), other: bearer("user-2") };
}

type App = Awaited<ReturnType<typeof buildApp>>["app"];
const get = (app: App, path: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url: `${PREFIX}${path}`, headers });

beforeEach(() => {
  seq = 0;
  seed([]);
  vi.stubEnv("DRIVE_ENABLED", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("while DRIVE_ENABLED is off", () => {
  it.each([
    "/files",
    "/files?q=report",
    "/files/00000000-0000-4000-8000-000000000001",
  ])("GET %s answers exactly like an unregistered route, signed in or not", async (path) => {
    vi.stubEnv("DRIVE_ENABLED", "false");
    seed([file()]);
    const { app, me } = await buildApp({ withRateLimit: true, providerEnabled: GOOGLE_ON });
    // Two routes nobody registered: one under the drive prefix, one outside it.
    const missing = await app.inject({ method: "GET", url: `${PREFIX}/not-a-route` });
    const elsewhere = await app.inject({ method: "GET", url: "/nowhere" });
    expect(missing.statusCode).toBe(404);
    expect(Object.keys(elsewhere.headers).sort()).toEqual(Object.keys(missing.headers).sort());

    for (const headers of [{}, me]) {
      const res = await get(app, path, headers);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        message: `Route GET:${PREFIX}${path} not found`,
        error: "Not Found",
        statusCode: 404,
      });
      expect(Object.keys(res.headers).sort()).toEqual(Object.keys(missing.headers).sort());
      expect(res.headers["content-type"]).toBe(missing.headers["content-type"]);
    }
    expect(db.reads).toEqual([]);
    await app.close();
  });

  it("the flag is read per request: a flip needs no restart", async () => {
    vi.stubEnv("DRIVE_ENABLED", "false");
    const { app, me } = await buildApp();
    expect((await get(app, "/files", me)).statusCode).toBe(404);
    vi.stubEnv("DRIVE_ENABLED", "true");
    expect((await get(app, "/files", me)).statusCode).toBe(200);
    vi.stubEnv("DRIVE_ENABLED", "false");
    expect((await get(app, "/files", me)).statusCode).toBe(404);
    await app.close();
  });
});

describe("authentication", () => {
  it.each([
    "/files",
    "/files/00000000-0000-4000-8000-000000000001",
  ])("GET %s needs a session", async (path) => {
    seed([file()]);
    const { app } = await buildApp({ providerEnabled: GOOGLE_ON });
    expect((await get(app, path)).statusCode).toBe(401);
    expect((await get(app, path, { authorization: "Bearer nonsense" })).statusCode).toBe(401);
    expect(db.reads).toEqual([]);
    await app.close();
  });
});

describe("GET /files", () => {
  it("is an empty list while no provider is implemented, whatever rows exist", async () => {
    seed([file(), file({ provider: "KLORN", sourceKey: "klorn", webUrl: null })]);
    const { app, me } = await buildApp();
    const res = await get(app, "/files", me);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ files: [], nextCursor: null });
    await app.close();
  });

  it("lists the caller's own files, newest first, as metadata only", async () => {
    seed([file(), file({ userId: "user-2", name: "theirs.pdf" }), file({ storageKey: null })]);
    const { app, me, other } = await buildApp({ providerEnabled: GOOGLE_ON });
    const mine = (await get(app, "/files", me)).json();
    expect(mine.files.map((f: { name: string }) => f.name)).toEqual(["file 3.pdf", "file 1.pdf"]);
    expect(mine.nextCursor).toBeNull();
    expect(mine.files[0]).toEqual({
      id: "00000000-0000-4000-8000-000000000003",
      provider: "GOOGLE",
      sourceKey: "acct-1",
      externalId: "ext-3",
      name: "file 3.pdf",
      mimeType: "application/pdf",
      isFolder: false,
      sizeBytes: 2_048,
      parentExternalId: null,
      modifiedAt: "2026-10-01T00:03:00.000Z",
      webUrl: "https://drive.google.com/file/d/ext-3/view",
      readOnly: true,
    });
    const theirs = (await get(app, "/files", other)).json();
    expect(theirs.files.map((f: { name: string }) => f.name)).toEqual(["theirs.pdf"]);
    await app.close();
  });

  it("never puts a storage key on the wire", async () => {
    seed([
      file({
        provider: "KLORN",
        sourceKey: "klorn",
        webUrl: null,
        storageKey: "u/user-1/drive/secret",
      }),
    ]);
    const { app, me } = await buildApp({ providerEnabled: GOOGLE_ON });
    const list = await get(app, "/files", me);
    expect(list.json().files).toHaveLength(1);
    expect(list.body).not.toMatch(/storageKey|secret/);
    const one = await get(app, "/files/00000000-0000-4000-8000-000000000001", me);
    expect(one.statusCode).toBe(200);
    expect(one.body).not.toMatch(/storageKey|secret/);
    await app.close();
  });

  it("searches names with q, and lists when q is blank", async () => {
    seed([
      file({ name: "Q3 report.pdf" }),
      file({ name: "notes.txt" }),
      file({ name: "100% done.txt" }),
    ]);
    const { app, me } = await buildApp({ providerEnabled: GOOGLE_ON });
    const names = async (path: string) =>
      (await get(app, path, me)).json().files.map((f: { name: string }) => f.name);
    expect(await names("/files?q=REPORT")).toEqual(["Q3 report.pdf"]);
    expect(await names(`/files?q=${encodeURIComponent("%")}`)).toEqual(["100% done.txt"]);
    expect(await names("/files?q=")).toHaveLength(3);
    expect(await names(`/files?q=${encodeURIComponent("   ")}`)).toHaveLength(3);
    await app.close();
  });

  it("pages with limit and cursor, and never serves more than 100", async () => {
    seed(Array.from({ length: 130 }, () => file()));
    const { app, me } = await buildApp({ providerEnabled: GOOGLE_ON });
    expect((await get(app, "/files", me)).json().files).toHaveLength(50);
    const big = (await get(app, "/files?limit=100000", me)).json();
    expect(big.files).toHaveLength(100);
    expect(typeof big.nextCursor).toBe("string");
    const rest = (await get(app, `/files?limit=100000&cursor=${big.nextCursor}`, me)).json();
    expect(rest.files).toHaveLength(30);
    expect(rest.nextCursor).toBeNull();
    const ids = new Set([...big.files, ...rest.files].map((f: { id: string }) => f.id));
    expect(ids.size).toBe(130);
    await app.close();
  });

  it("narrows to a provider and a source", async () => {
    seed([
      file(),
      file({ provider: "KLORN", sourceKey: "klorn", webUrl: null }),
      file({ sourceKey: "acct-2" }),
    ]);
    const { app, me } = await buildApp({ providerEnabled: GOOGLE_ON });
    expect((await get(app, "/files?provider=KLORN", me)).json().files).toHaveLength(1);
    expect(
      (await get(app, "/files?provider=GOOGLE&sourceKey=acct-2", me)).json().files,
    ).toHaveLength(1);
    await app.close();
  });

  it.each([
    ["a cursor this server did not make", "/files?cursor=not-a-cursor"],
    ["a limit that is not a number", "/files?limit=abc"],
    ["a limit below one", "/files?limit=0"],
    ["a provider that is not one", "/files?provider=DROPBOX"],
    ["an oversized query", `/files?q=${"a".repeat(501)}`],
    ["an oversized source key", `/files?sourceKey=${"a".repeat(513)}`],
  ])("refuses %s with a 400 and reads nothing", async (_label, path) => {
    seed([file()]);
    const { app, me } = await buildApp({ providerEnabled: GOOGLE_ON });
    const res = await get(app, path, me);
    expect(res.statusCode).toBe(400);
    expect(db.reads).toEqual([]);
    await app.close();
  });

  it("the invalid-cursor answer names the problem and nothing else", async () => {
    const { app, me } = await buildApp({ providerEnabled: GOOGLE_ON });
    expect((await get(app, "/files?cursor=not-a-cursor", me)).json()).toEqual({
      error: "Invalid cursor",
    });
    await app.close();
  });
});

describe("GET /files/:id", () => {
  const ID = "00000000-0000-4000-8000-000000000001";

  it("returns the caller's own file", async () => {
    seed([file()]);
    const { app, me } = await buildApp({ providerEnabled: GOOGLE_ON });
    const res = await get(app, `/files/${ID}`, me);
    expect(res.statusCode).toBe(200);
    expect(res.json().file).toMatchObject({ id: ID, name: "file 1.pdf", sizeBytes: 2_048 });
    await app.close();
  });

  it("answers one 404 for another user's file, an unknown id, a malformed id, a trashed file and a disabled provider", async () => {
    seed([file(), file({ trashed: true }), file({ provider: "ONEDRIVE", sourceKey: "acct-9" })]);
    const { app, me, other } = await buildApp({ providerEnabled: GOOGLE_ON });
    const answers = [
      await get(app, `/files/${ID}`, other),
      await get(app, "/files/00000000-0000-4000-8000-999999999999", me),
      await get(app, `/files/${encodeURIComponent("a b")}`, me),
      await get(app, `/files/${"x".repeat(65)}`, me),
      await get(app, "/files/00000000-0000-4000-8000-000000000002", me),
      await get(app, "/files/00000000-0000-4000-8000-000000000003", me),
    ];
    for (const res of answers) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "File not found" });
    }
    await app.close();
  });

  it("is a 404 for every id while no provider is implemented", async () => {
    seed([file()]);
    const { app, me } = await buildApp();
    expect((await get(app, `/files/${ID}`, me)).statusCode).toBe(404);
    await app.close();
  });
});

describe("rate limits", () => {
  it("the list and search share 30 requests a minute", async () => {
    const { app, me } = await buildApp({ withRateLimit: true, providerEnabled: GOOGLE_ON });
    for (let i = 0; i < 30; i += 1) {
      expect((await get(app, i % 2 === 0 ? "/files" : "/files?q=a", me)).statusCode).toBe(200);
    }
    expect((await get(app, "/files", me)).statusCode).toBe(429);
    await app.close();
  });

  it("the by-id read allows 60 a minute, counted apart from the list", async () => {
    const { app, me } = await buildApp({ withRateLimit: true, providerEnabled: GOOGLE_ON });
    for (let i = 0; i < 60; i += 1) {
      expect((await get(app, "/files/00000000-0000-4000-8000-000000000001", me)).statusCode).toBe(
        404,
      );
    }
    expect((await get(app, "/files/00000000-0000-4000-8000-000000000001", me)).statusCode).toBe(
      429,
    );
    expect((await get(app, "/files", me)).statusCode).toBe(200);
    await app.close();
  });
});

describe("read-only: D2 has no upload, download or delete", () => {
  it.each([
    ["POST", "/files"],
    ["PUT", "/files/00000000-0000-4000-8000-000000000001"],
    ["PATCH", "/files/00000000-0000-4000-8000-000000000001"],
    ["DELETE", "/files/00000000-0000-4000-8000-000000000001"],
    ["GET", "/files/00000000-0000-4000-8000-000000000001/content"],
    ["GET", "/files/00000000-0000-4000-8000-000000000001/download"],
  ] as const)("%s %s is not a route", async (method, path) => {
    seed([file()]);
    const { app, me } = await buildApp({ providerEnabled: GOOGLE_ON });
    const res = await app.inject({ method, url: `${PREFIX}${path}`, headers: me });
    expect(res.statusCode).toBe(404);
    expect(db.tables.driveFile).toHaveLength(1);
    await app.close();
  });
});
