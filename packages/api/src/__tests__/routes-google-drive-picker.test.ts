/**
 * D5c: the Google Picker and the index of picked files
 * (routes/google-drive-link.ts, drive/google-drive-picker.ts).
 *
 *   POST /api/drive/google/accounts/:id/picker-session
 *        → { accessToken, developerKey, appId }, no-store. The ONE response that
 *          carries a token, by design: the browser's Picker needs it.
 *   POST /api/drive/google/accounts/:id/picked   { ids }
 *        → { added, refused: [{ id, code }] }. Only ids cross the wire; every
 *          field of a row is what Google's files.get answered.
 *
 * Dark while DRIVE_ENABLED or GOOGLE_DRIVE_ENABLED is off. The account module,
 * the writer and the reads are the real ones over the strict fake database; the
 * OAuth client and googleapis are mocked, so no Google call is real.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
const plan = vi.hoisted(() => ({ value: "PRO" }));

type TokensListener = (tokens: Record<string, unknown>) => Promise<void> | void;

const google = vi.hoisted(() => ({
  clients: [] as Array<{ credentials: Record<string, unknown> | null }>,
  getAccessToken: vi.fn(),
  filesGet: vi.fn(),
  filesList: vi.fn(),
}));

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const fake = fakePrismaClient(() => dbHolder.current as FakeDb) as Record<string, unknown>;
  const prisma = new Proxy(fake, {
    get(target, prop) {
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
vi.mock("../mail/gmail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mail/gmail.js")>();
  return {
    ...actual,
    getOAuth2Client: () => {
      const client = {
        credentials: null as Record<string, unknown> | null,
        listeners: [] as TokensListener[],
        getAccessToken: google.getAccessToken,
        setCredentials(credentials: Record<string, unknown>) {
          client.credentials = credentials;
        },
        on(event: string, listener: TokensListener) {
          if (event === "tokens") client.listeners.push(listener);
        },
      };
      google.clients.push(client);
      return client;
    },
  };
});
vi.mock("googleapis", () => ({
  google: { drive: () => ({ files: { get: google.filesGet, list: google.filesList } }) },
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const PREFIX = "/api/drive/google";
const STORED_ACCESS = "ya29.stored-SECRET";
const STORED_REFRESH = "1//refresh-SECRET";
const FRESH_ACCESS = "ya29.fresh-SECRET";
const ID_A = "1AaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA";
const ID_B = "1BbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbB";
const ID_C = "1CccccccccccccccccccccccccccccccC";

let db: FakeDb;
let logged: string[];

function resource(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: `Google name ${id.slice(0, 2)}.pdf`,
    mimeType: "application/pdf",
    size: "2048",
    md5Checksum: `md5-${id.slice(0, 2)}`,
    version: "3",
    modifiedTime: "2026-10-14T09:30:00.000Z",
    webViewLink: `https://drive.google.com/file/d/${id}/view`,
    parents: ["0ParentFolderId0000000000"],
    trashed: false,
    ...over,
  };
}

/** Google's files.get over a fixture of what each id is; an id not in it is a 404. */
function googleHas(files: Record<string, Record<string, unknown>>): void {
  google.filesGet.mockImplementation((params: { fileId: string }) => {
    const data = files[params.fileId];
    if (!data) {
      return Promise.reject(
        Object.assign(new Error(`File not found: ${params.fileId}.`), { status: 404 }),
      );
    }
    return Promise.resolve({ data });
  });
}

function driveRow(i: number, over: Row = {}): Row {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    userId: "user-1",
    provider: "GOOGLE",
    sourceKey: "acct-1",
    sourceAccountId: "acct-1",
    externalId: `1Existing${String(i).padStart(24, "0")}`,
    name: `existing ${i}.pdf`,
    modifiedAt: new Date("2026-10-01T00:00:00.000Z"),
    ...over,
  };
}

async function build(tables: Record<string, Row[]> = {}, accountOver: Row = {}) {
  vi.resetModules();
  const crypto = await import("../crypto-tokens.js");
  db = createFakeDb({
    linkedDriveAccount: [
      {
        id: "acct-1",
        userId: "user-1",
        provider: "GOOGLE",
        email: "me@example.com",
        accessToken: crypto.encryptToken(STORED_ACCESS),
        refreshToken: crypto.encryptToken(STORED_REFRESH),
        expiresAt: new Date("2026-10-15T12:00:00.000Z"),
        grantedScopes: "openid https://www.googleapis.com/auth/drive.file",
        ...accountOver,
      },
      {
        id: "acct-other",
        userId: "user-2",
        provider: "GOOGLE",
        email: "them@example.com",
        accessToken: crypto.encryptToken("ya29.other-SECRET"),
        refreshToken: crypto.encryptToken("1//other-SECRET"),
        grantedScopes: "openid https://www.googleapis.com/auth/drive.file",
      },
    ],
    driveFile: [],
    driveFileSummary: [],
    ...tables,
  });
  dbHolder.current = db;
  const { signToken } = await import("../auth.js");
  const { googleDriveLinkRoutes, googleDriveRoutesEnabled } = await import(
    "../routes/google-drive-link.js"
  );
  const app = Fastify();
  await app.register(googleDriveLinkRoutes({ gate: googleDriveRoutesEnabled }), { prefix: PREFIX });
  await app.ready();
  const bearer = (userId: string) => ({
    authorization: `Bearer ${signToken({ userId, email: `${userId}@example.com` })}`,
  });
  return { app, me: bearer("user-1"), other: bearer("user-2") };
}

const session = (id = "acct-1") => ({
  method: "POST" as const,
  url: `${PREFIX}/accounts/${id}/picker-session`,
});
const picked = (payload: unknown, id = "acct-1") => ({
  method: "POST" as const,
  url: `${PREFIX}/accounts/${id}/picked`,
  payload: payload as Record<string, unknown>,
});

beforeEach(() => {
  plan.value = "PRO";
  google.clients.length = 0;
  google.getAccessToken.mockReset();
  google.getAccessToken.mockResolvedValue({ token: FRESH_ACCESS });
  google.filesGet.mockReset();
  google.filesList.mockReset();
  googleHas({});
  vi.stubEnv("DRIVE_ENABLED", "true");
  vi.stubEnv("GOOGLE_DRIVE_ENABLED", "true");
  vi.stubEnv("GOOGLE_PICKER_API_KEY", "AIzaPickerKeyPublic");
  vi.stubEnv("GOOGLE_CLOUD_PROJECT_NUMBER", "123456789012");
  logged = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(
        args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(" "),
      );
      try {
        logged.push(JSON.stringify(args));
      } catch {
        // A value JSON cannot hold was already logged as text above.
      }
    });
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

/** Every token value this file seeds or mints; none may reach a log or a non-Picker answer. */
const SECRETS = /ya29\.(stored|fresh|other)-SECRET|1\/\/(refresh|other)-SECRET/;

describe("dark while either flag is off", () => {
  it.each([
    ["DRIVE_ENABLED", "picker-session"],
    ["DRIVE_ENABLED", "picked"],
    ["GOOGLE_DRIVE_ENABLED", "picker-session"],
    ["GOOGLE_DRIVE_ENABLED", "picked"],
  ] as const)("%s off: POST /accounts/:id/%s answers exactly like an unregistered route", async (flag, route) => {
    vi.stubEnv(flag, "false");
    const { app, me } = await build({ driveFile: [driveRow(1)] });
    const unregistered = await app.inject({ method: "POST", url: `${PREFIX}/not-a-route` });
    const url = `${PREFIX}/accounts/acct-1/${route}`;
    for (const headers of [{}, me]) {
      const res = await app.inject({ method: "POST", url, headers, payload: { ids: [ID_A] } });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        ...unregistered.json(),
        message: `Route POST:${url} not found`,
      });
      expect(Object.keys(res.headers).sort()).toEqual(Object.keys(unregistered.headers).sort());
    }
    expect(db.reads).toEqual([]);
    expect(db.writes).toEqual({});
    expect(google.getAccessToken).not.toHaveBeenCalled();
    expect(google.filesGet).not.toHaveBeenCalled();
    await app.close();
  });

  it.each(["picker-session", "picked"])("POST /accounts/:id/%s needs a session", async (route) => {
    const { app } = await build();
    const res = await app.inject({
      method: "POST",
      url: `${PREFIX}/accounts/acct-1/${route}`,
      payload: { ids: [ID_A] },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("POST /accounts/:id/picker-session", () => {
  it("answers a fresh token, the developer key and the app id, never cached", async () => {
    const { app, me } = await build();
    const res = await app.inject({ ...session(), headers: me });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      accessToken: FRESH_ACCESS,
      developerKey: "AIzaPickerKeyPublic",
      appId: "123456789012",
    });
    expect(res.headers["cache-control"]).toBe("no-store");
    // Minted through the account's own client, from its stored grant.
    expect(google.getAccessToken).toHaveBeenCalledTimes(1);
    expect(google.clients[0]?.credentials).toMatchObject({
      access_token: STORED_ACCESS,
      refresh_token: STORED_REFRESH,
    });
    // A token closer than 15 minutes to its expiry is refreshed before it goes out.
    expect(google.clients[0]).toMatchObject({ eagerRefreshThresholdMillis: 15 * 60 * 1000 });
    // The record of the issue names the account, never the token.
    expect(logged.join("\n")).toContain("picker token issued for drive account acct-1");
    expect(google.filesGet).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ["GOOGLE_PICKER_API_KEY"],
    ["GOOGLE_CLOUD_PROJECT_NUMBER"],
  ])("503 picker-not-configured while %s is unset, before any token is minted", async (name) => {
    vi.stubEnv(name, "");
    const { app, me } = await build();
    const res = await app.inject({ ...session(), headers: me });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "picker-not-configured" });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(google.clients).toHaveLength(0);
    expect(google.getAccessToken).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ["another user's account", "acct-other"],
    ["an unknown account", "acct-nope"],
  ])("%s answers 404 and mints nothing", async (_label, id) => {
    const { app, me } = await build();
    const res = await app.inject({ ...session(id), headers: me });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toMatch(SECRETS);
    expect(google.clients).toHaveLength(0);
    await app.close();
  });

  it("another provider's account of the same user answers 404", async () => {
    const { app, me } = await build({}, { provider: "ONEDRIVE" });
    const res = await app.inject({ ...session(), headers: me });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("an account flagged for reconnect answers 409 without decrypting its grant", async () => {
    const { app, me } = await build({}, { needsReconnect: true });
    const res = await app.inject({ ...session(), headers: me });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "needs-reconnect" });
    expect(google.clients).toHaveLength(0);
    await app.close();
  });

  it("a revoked grant at refresh answers 409 and flags the account; the token is never logged", async () => {
    google.getAccessToken.mockRejectedValue(
      Object.assign(new Error("invalid_grant"), {
        response: { status: 400, data: { error: "invalid_grant" } },
        config: { headers: { Authorization: `Bearer ${STORED_ACCESS}` } },
      }),
    );
    const { app, me } = await build();
    const res = await app.inject({ ...session(), headers: me });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "needs-reconnect" });
    expect(db.tables.linkedDriveAccount?.[0]?.needsReconnect).toBe(true);
    expect(res.body).not.toMatch(SECRETS);
    expect(logged.join("\n")).not.toMatch(SECRETS);
    await app.close();
  });

  it("Google unreachable answers 502 with nothing secret in the body or the logs", async () => {
    google.getAccessToken.mockRejectedValue(
      Object.assign(new Error("socket hang up"), {
        code: "ECONNRESET",
        config: { headers: { Authorization: `Bearer ${STORED_ACCESS}` } },
      }),
    );
    const { app, me } = await build();
    const res = await app.inject({ ...session(), headers: me });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: "drive-unavailable" });
    expect(res.body).not.toMatch(SECRETS);
    expect(logged.join("\n")).not.toMatch(SECRETS);
    expect(db.tables.linkedDriveAccount?.[0]?.needsReconnect).toBeFalsy();
    await app.close();
  });

  it.each([
    [
      "a Gmail scope",
      "openid https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/gmail.readonly",
    ],
    [
      "a Calendar scope",
      "openid https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/calendar",
    ],
    ["no drive.file", "openid https://www.googleapis.com/auth/userinfo.email"],
  ])("a grant with %s answers 409 and mints nothing: only a drive.file-only token goes to a browser", async (_label, grantedScopes) => {
    const { app, me } = await build({}, { grantedScopes });
    const res = await app.inject({ ...session(), headers: me });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "grant-too-broad" });
    expect(res.body).not.toMatch(SECRETS);
    expect(google.getAccessToken).not.toHaveBeenCalled();
    await app.close();
  });

  it("the identity scopes alongside drive.file are fine", async () => {
    const { app, me } = await build(
      {},
      {
        grantedScopes:
          "openid email https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file",
      },
    );
    const res = await app.inject({ ...session(), headers: me });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("needs the plan while the paywall is on, like the link", async () => {
    vi.stubEnv("PAYWALL_ENABLED", "true");
    plan.value = "FREE";
    const { app, me } = await build();
    const res = await app.inject({ ...session(), headers: me });
    expect(res.statusCode).toBe(403);
    expect(google.getAccessToken).not.toHaveBeenCalled();
    await app.close();
  });

  it("logs no token on success either", async () => {
    const { app, me } = await build();
    await app.inject({ ...session(), headers: me });
    expect(logged.join("\n")).not.toMatch(SECRETS);
    await app.close();
  });
});

describe("POST /accounts/:id/picked", () => {
  it("indexes each picked file from Google's own metadata, as a GOOGLE row of that account", async () => {
    googleHas({ [ID_A]: resource(ID_A), [ID_B]: resource(ID_B, { md5Checksum: undefined }) });
    const { app, me } = await build();
    const res = await app.inject({ ...picked({ ids: [ID_A, ID_B] }), headers: me });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ added: 2, refused: [] });
    expect(google.filesGet.mock.calls.map(([p]) => p)).toEqual([
      {
        fileId: ID_A,
        fields:
          "id,name,mimeType,size,md5Checksum,version,modifiedTime,webViewLink,parents,trashed",
        supportsAllDrives: true,
      },
      {
        fileId: ID_B,
        fields:
          "id,name,mimeType,size,md5Checksum,version,modifiedTime,webViewLink,parents,trashed",
        supportsAllDrives: true,
      },
    ]);
    const rows = db.tables.driveFile ?? [];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      userId: "user-1",
      provider: "GOOGLE",
      sourceKey: "acct-1",
      sourceAccountId: "acct-1",
      externalId: ID_A,
      name: "Google name 1A.pdf",
      mimeType: "application/pdf",
      isFolder: false,
      sizeBytes: 2048n,
      parentExternalId: "0ParentFolderId0000000000",
      webUrl: `https://drive.google.com/file/d/${ID_A}/view`,
      etag: "md5:md5-1A",
      trashed: false,
      storageKey: null,
    });
    expect(rows[1]).toMatchObject({ externalId: ID_B, etag: "v:3" });
    expect(res.body).not.toMatch(SECRETS);
    expect(logged.join("\n")).not.toMatch(SECRETS);
    await app.close();
  });

  it("client-supplied metadata is never accepted: only the ids are read from the body", async () => {
    googleHas({ [ID_A]: resource(ID_A) });
    const { app, me } = await build();
    const res = await app.inject({
      ...picked({
        ids: [ID_A],
        name: "evil.exe",
        files: [{ id: ID_A, name: "evil.exe", webViewLink: "https://evil.example/x" }],
      }),
      headers: me,
    });
    expect(res.statusCode).toBe(200);
    expect(db.tables.driveFile?.[0]).toMatchObject({
      name: "Google name 1A.pdf",
      webUrl: `https://drive.google.com/file/d/${ID_A}/view`,
    });
    // A picked "id" that carries metadata is not an id.
    const objects = await app.inject({
      ...picked({ ids: [{ id: ID_A, name: "evil.exe" }] }),
      headers: me,
    });
    expect(objects.statusCode).toBe(400);
    expect(db.tables.driveFile).toHaveLength(1);
    await app.close();
  });

  it.each([
    ["no ids", { ids: [] }],
    [
      "more than 50 ids",
      { ids: Array.from({ length: 51 }, (_, i) => `1Id${String(i).padStart(30, "0")}`) },
    ],
    ["ids that are not a list", { ids: { 0: ID_A } }],
    ["no body", undefined],
  ])("%s answers 400 and calls nothing", async (_label, payload) => {
    const { app, me } = await build();
    const res = await app.inject({ ...picked(payload), headers: me });
    expect(res.statusCode).toBe(400);
    expect(google.clients).toHaveLength(0);
    expect(google.filesGet).not.toHaveBeenCalled();
    expect(db.writes).toEqual({});
    await app.close();
  });

  it("a 404 is a file this grant cannot see; a trashed file is refused the same way", async () => {
    googleHas({ [ID_A]: resource(ID_A, { trashed: true }) });
    const { app, me } = await build();
    const res = await app.inject({ ...picked({ ids: [ID_A, ID_B] }), headers: me });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      added: 0,
      refused: [
        { id: ID_A, code: "not-accessible" },
        { id: ID_B, code: "not-accessible" },
      ],
    });
    expect(db.tables.driveFile).toHaveLength(0);
    await app.close();
  });

  it("folders and shortcuts cannot be picked", async () => {
    googleHas({
      [ID_A]: resource(ID_A, { mimeType: "application/vnd.google-apps.folder" }),
      [ID_B]: resource(ID_B, { mimeType: "application/vnd.google-apps.shortcut" }),
      [ID_C]: resource(ID_C, { mimeType: "application/vnd.google-apps.document", size: undefined }),
    });
    const { app, me } = await build();
    const res = await app.inject({ ...picked({ ids: [ID_A, ID_B, ID_C] }), headers: me });
    expect(res.json()).toEqual({
      added: 1,
      refused: [
        { id: ID_A, code: "folder" },
        { id: ID_B, code: "shortcut" },
      ],
    });
    expect(db.tables.driveFile?.map((r) => r.externalId)).toEqual([ID_C]);
    await app.close();
  });

  it("an id that is not a Drive id is refused as invalid without asking Google; repeats count once", async () => {
    googleHas({ [ID_A]: resource(ID_A) });
    const { app, me } = await build();
    const res = await app.inject({
      ...picked({ ids: ["../etc/passwd", ID_A, "x' or 1=1", ID_A] }),
      headers: me,
    });
    expect(res.json()).toEqual({
      added: 1,
      refused: [
        { id: "../etc/passwd", code: "invalid" },
        { id: "x' or 1=1", code: "invalid" },
      ],
    });
    expect(google.filesGet).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("Google answering another file than the one asked for is refused as invalid", async () => {
    googleHas({ [ID_A]: resource(ID_B) });
    const { app, me } = await build();
    const res = await app.inject({ ...picked({ ids: [ID_A] }), headers: me });
    expect(res.json()).toEqual({ added: 0, refused: [{ id: ID_A, code: "invalid" }] });
    expect(db.tables.driveFile).toHaveLength(0);
    await app.close();
  });

  it("500 rows per account: the files past the cap are refused, the first ones fit", async () => {
    const existing = Array.from({ length: 499 }, (_, i) => driveRow(i + 1));
    googleHas({ [ID_A]: resource(ID_A), [ID_B]: resource(ID_B), [ID_C]: resource(ID_C) });
    const { app, me } = await build({ driveFile: existing });
    const res = await app.inject({ ...picked({ ids: [ID_A, ID_B, ID_C] }), headers: me });
    expect(res.json()).toEqual({
      added: 1,
      refused: [
        { id: ID_B, code: "cap" },
        { id: ID_C, code: "cap" },
      ],
    });
    expect(db.tables.driveFile).toHaveLength(500);
    await app.close();
  });

  it("at the cap a file already indexed is still refreshed; a new one is refused without asking Google", async () => {
    const existing = Array.from({ length: 500 }, (_, i) => driveRow(i + 1));
    const indexed = existing[0]?.externalId as string;
    googleHas({
      [indexed]: resource(indexed, { name: "renamed at Google.pdf" }),
      [ID_A]: resource(ID_A),
    });
    const { app, me } = await build({ driveFile: existing });
    const res = await app.inject({ ...picked({ ids: [indexed, ID_A] }), headers: me });
    expect(res.json()).toEqual({ added: 1, refused: [{ id: ID_A, code: "cap" }] });
    expect(google.filesGet.mock.calls.map(([p]) => p.fileId)).toEqual([indexed]);
    expect(db.tables.driveFile).toHaveLength(500);
    expect(db.tables.driveFile?.[0]?.name).toBe("renamed at Google.pdf");
    await app.close();
  });

  it("the cap counts this account's rows only, trashed ones included", async () => {
    const existing = [
      ...Array.from({ length: 499 }, (_, i) =>
        driveRow(i + 1, {
          userId: "user-2",
          sourceKey: "acct-other",
          sourceAccountId: "acct-other",
        }),
      ),
      driveRow(600, { trashed: true }),
    ];
    googleHas({ [ID_A]: resource(ID_A) });
    const { app, me } = await build({ driveFile: existing });
    const res = await app.inject({ ...picked({ ids: [ID_A] }), headers: me });
    expect(res.json()).toEqual({ added: 1, refused: [] });
    await app.close();
  });

  it("another user's account answers 404 and asks Google nothing", async () => {
    const { app, me } = await build();
    const res = await app.inject({ ...picked({ ids: [ID_A] }, "acct-other"), headers: me });
    expect(res.statusCode).toBe(404);
    expect(google.clients).toHaveLength(0);
    expect(google.filesGet).not.toHaveBeenCalled();
    expect(db.tables.driveFile).toHaveLength(0);
    await app.close();
  });

  it("an account flagged for reconnect answers 409", async () => {
    const { app, me } = await build({}, { needsReconnect: true });
    const res = await app.inject({ ...picked({ ids: [ID_A] }), headers: me });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "needs-reconnect" });
    expect(google.filesGet).not.toHaveBeenCalled();
    await app.close();
  });

  it("a grant revoked while picking answers 409, flags the account and writes nothing", async () => {
    google.filesGet.mockRejectedValue(
      Object.assign(new Error("Invalid Credentials"), {
        status: 401,
        config: { headers: { Authorization: `Bearer ${STORED_ACCESS}` } },
      }),
    );
    const { app, me } = await build();
    const res = await app.inject({ ...picked({ ids: [ID_A, ID_B] }), headers: me });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "needs-reconnect" });
    expect(db.tables.linkedDriveAccount?.[0]?.needsReconnect).toBe(true);
    expect(db.tables.driveFile).toHaveLength(0);
    expect(logged.join("\n")).not.toMatch(SECRETS);
    await app.close();
  });

  it.each([
    ["a 5xx", { status: 503 }],
    ["a 429", { status: 429 }],
    ["a 403 rate limit", { status: 403, errors: [{ reason: "userRateLimitExceeded" }] }],
    ["the network", { code: "ECONNRESET" }],
  ])("Google failing (%s) answers 502, writes nothing, and logs no token", async (_label, shape) => {
    google.filesGet.mockRejectedValue(
      Object.assign(new Error("Google said no"), {
        ...shape,
        config: { headers: { Authorization: `Bearer ${STORED_ACCESS}` } },
      }),
    );
    const { app, me } = await build();
    const res = await app.inject({ ...picked({ ids: [ID_A] }), headers: me });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: "drive-unavailable" });
    expect(db.tables.driveFile).toHaveLength(0);
    expect(res.body).not.toMatch(SECRETS);
    expect(logged.join("\n")).not.toMatch(SECRETS);
    await app.close();
  });

  it.each([
    ["accessNotConfigured"],
    ["insufficientPermissions"],
    ["forbidden"],
  ])("a 403 %s is a fault of the setup or the grant, not of the file: 502, nothing written", async (reason) => {
    google.filesGet.mockRejectedValue(
      Object.assign(new Error("Forbidden"), { status: 403, errors: [{ reason }] }),
    );
    const { app, me } = await build();
    const res = await app.inject({ ...picked({ ids: [ID_A] }), headers: me });
    expect(res.statusCode).toBe(502);
    expect(db.tables.driveFile).toHaveLength(0);
    await app.close();
  });

  it("one file read fine and the next failing at Google writes nothing at all", async () => {
    google.filesGet.mockImplementation((params: { fileId: string }) =>
      params.fileId === ID_A
        ? Promise.resolve({ data: resource(ID_A) })
        : Promise.reject(Object.assign(new Error("Backend Error"), { status: 500 })),
    );
    const { app, me } = await build();
    const res = await app.inject({ ...picked({ ids: [ID_A, ID_B] }), headers: me });
    expect(res.statusCode).toBe(502);
    expect(db.tables.driveFile).toHaveLength(0);
    await app.close();
  });

  it("a 403 that is not a rate limit (the file is not this app's to read) is not-accessible", async () => {
    google.filesGet.mockRejectedValue(
      Object.assign(new Error("The user has not granted the app"), {
        status: 403,
        errors: [{ reason: "appNotAuthorizedToFile" }],
      }),
    );
    const { app, me } = await build();
    const res = await app.inject({ ...picked({ ids: [ID_A] }), headers: me });
    expect(res.json()).toEqual({ added: 0, refused: [{ id: ID_A, code: "not-accessible" }] });
    await app.close();
  });

  it("queues each indexed file's summary while summaries are on", async () => {
    vi.stubEnv("DRIVE_SUMMARIES_ENABLED", "true");
    googleHas({ [ID_A]: resource(ID_A) });
    const { app, me } = await build();
    await app.inject({ ...picked({ ids: [ID_A] }), headers: me });
    const file = db.tables.driveFile?.[0];
    expect(db.tables.driveFileSummary).toHaveLength(1);
    expect(db.tables.driveFileSummary?.[0]).toMatchObject({
      driveFileId: file?.id,
      status: "PENDING",
      sourceEtag: "md5:md5-1A",
    });
    await app.close();
  });

  it("needs the plan while the paywall is on", async () => {
    vi.stubEnv("PAYWALL_ENABLED", "true");
    plan.value = "FREE";
    const { app, me } = await build();
    const res = await app.inject({ ...picked({ ids: [ID_A] }), headers: me });
    expect(res.statusCode).toBe(403);
    expect(google.filesGet).not.toHaveBeenCalled();
    await app.close();
  });
});
