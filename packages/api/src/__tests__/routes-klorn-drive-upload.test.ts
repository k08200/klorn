/**
 * D3: POST /api/drive/files, the Klorn drive's upload, over the real modules, a
 * fake database and the in-memory object store. The object is stored first and
 * the row written after it; a request that does not end cleanly leaves neither.
 * The type comes from the bytes, never from the client. The size is checked
 * before the first byte and counted while the bytes flow.
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildKlornDriveApp,
  flagsOn,
  type KlornDriveTestApp,
  klornRow,
  multipart,
  PNG,
  PREFIX,
  resetRowIds,
  upload,
} from "./helpers/klorn-drive-app.js";

vi.mock("../db.js", async () => {
  const { klornDriveDbMock } = await import("./helpers/klorn-drive-app.js");
  return klornDriveDbMock();
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { KLORN_DRIVE_MAX_FILE_BYTES } from "../drive/klorn-upload.js";
import { setObjectStoreForTests } from "../storage/runtime.js";

const text = (value: string) => new TextEncoder().encode(value);
let t: KlornDriveTestApp;
const rows = () => t.db.tables.driveFile ?? [];

beforeEach(async () => {
  resetRowIds();
  flagsOn();
  vi.spyOn(console, "error").mockImplementation(() => {});
  t = await buildKlornDriveApp();
});

afterEach(async () => {
  await t.app.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setObjectStoreForTests(null);
});

describe("a clean upload", () => {
  it("stores the object, then writes the row, and answers the file", async () => {
    const res = await upload(t, t.me, { filename: "chart.png", data: PNG });
    expect(res.statusCode).toBe(201);
    const { file } = res.json();
    expect(file).toMatchObject({
      provider: "KLORN",
      sourceKey: "klorn",
      name: "chart.png",
      mimeType: "image/png",
      isFolder: false,
      sizeBytes: PNG.length,
      parentExternalId: null,
      webUrl: null,
      readOnly: false,
    });
    expect(file).not.toHaveProperty("storageKey");
    const [key] = t.store.keys();
    expect(key).toMatch(/^u\/user-1\/drive\/[0-9a-f-]{36}$/);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      storageKey: key,
      externalId: file.externalId,
      sizeBytes: BigInt(PNG.length),
      etag: `sha256:${createHash("sha256").update(PNG).digest("hex")}`,
    });
    expect(file.externalId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("is listed in the root folder and nowhere else", async () => {
    await upload(t, t.me, { filename: "chart.png", data: PNG });
    const root = await t.app.inject({
      method: "GET",
      url: `${PREFIX}/files?folder=root`,
      headers: t.me,
    });
    expect(root.json().files.map((f: { name: string }) => f.name)).toEqual(["chart.png"]);
    const other = await t.app.inject({ method: "GET", url: `${PREFIX}/files`, headers: t.other });
    expect(other.json().files).toEqual([]);
  });

  it("keeps a Korean name composed, and strips a bidi override", async () => {
    const res = await upload(t, t.me, {
      filename: "보고서‮txt.exe".normalize("NFD"),
      data: text("hello"),
    });
    expect(res.json().file.name).toBe("보고서txt.exe".normalize("NFC"));
  });

  it("lands in the named folder", async () => {
    const folder = klornRow({ isFolder: true, mimeType: null, sizeBytes: null, name: "Docs" });
    t = await buildKlornDriveApp({ seed: [folder] });
    const res = await upload(t, t.me, {
      filename: "a.txt",
      data: text("hi"),
      parent: folder.externalId as string,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().file.parentExternalId).toBe(folder.externalId);
  });
});

describe("the type comes from the bytes, never from the client", () => {
  it("PNG bytes sent as text/html are an image/png", async () => {
    const res = await upload(t, t.me, { filename: "x.png", data: PNG, contentType: "text/html" });
    expect(res.json().file.mimeType).toBe("image/png");
  });

  it("HTML sent as image/png is stored as octet-stream", async () => {
    const html = text("<!doctype html><script>alert(1)</script>");
    const res = await upload(t, t.me, { filename: "x.png", data: html, contentType: "image/png" });
    expect(res.statusCode).toBe(201);
    expect(res.json().file.mimeType).toBe("application/octet-stream");
    const head = await t.store.headObject(t.store.keys()[0] ?? "");
    expect(head?.contentType).toBe("application/octet-stream");
  });

  it("an executable is stored, labelled octet-stream", async () => {
    const res = await upload(t, t.me, { filename: "setup.exe", data: text("MZ\u0090\u0000rest") });
    expect(res.statusCode).toBe(201);
    expect(res.json().file.mimeType).toBe("application/octet-stream");
  });
});

describe("size", () => {
  it("a declared size over the cap is refused before a byte is stored", async () => {
    const res = await upload(t, t.me, {
      filename: "big.bin",
      data: text("x"),
      size: String(KLORN_DRIVE_MAX_FILE_BYTES + 1),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({
      error: "The file is larger than the upload limit.",
      code: "too-large",
      retryable: false,
    });
    expect(t.store.keys()).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it("a body over the cap is refused while it streams, even with an honest-looking size", async () => {
    const data = new Uint8Array(KLORN_DRIVE_MAX_FILE_BYTES + 1);
    const res = await upload(t, t.me, {
      filename: "big.bin",
      data,
      size: String(KLORN_DRIVE_MAX_FILE_BYTES),
    });
    expect([400, 413]).toContain(res.statusCode);
    expect(t.store.keys()).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it.each([
    ["longer than declared", "3"],
    ["shorter than declared", "50"],
  ])("a body %s is refused and nothing is kept", async (_label, size) => {
    const res = await upload(t, t.me, { filename: "a.txt", data: text("hello"), size });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid-upload");
    expect(t.store.keys()).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it.each(["", "-1", "1e3", "0x10", " 12x"])("size %j is refused", async (size) => {
    const res = await upload(t, t.me, { filename: "a.txt", data: text("hello"), size });
    expect(res.statusCode).toBe(400);
    expect(t.store.keys()).toEqual([]);
  });

  it("a request without the size field is refused", async () => {
    const body = multipart([{ name: "file", filename: "a.txt", data: text("hello") }]);
    const res = await t.app.inject({
      method: "POST",
      url: `${PREFIX}/files`,
      headers: { ...t.me, ...body.headers },
      payload: body.payload,
    });
    expect(res.statusCode).toBe(400);
    expect(t.store.keys()).toEqual([]);
  });
});

describe("the request must end cleanly before the row is written", () => {
  it("a second file part: the stored object is deleted and no row is written", async () => {
    const body = multipart([
      { name: "size", value: "5" },
      { name: "file", filename: "a.txt", data: text("hello") },
      { name: "file", filename: "b.txt", data: text("world") },
    ]);
    const res = await t.app.inject({
      method: "POST",
      url: `${PREFIX}/files`,
      headers: { ...t.me, ...body.headers },
      payload: body.payload,
    });
    expect(res.statusCode).toBe(400);
    expect(t.store.keys()).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it("a field after the file: same", async () => {
    const body = multipart([
      { name: "size", value: "5" },
      { name: "file", filename: "a.txt", data: text("hello") },
      { name: "parentExternalId", value: "x" },
    ]);
    const res = await t.app.inject({
      method: "POST",
      url: `${PREFIX}/files`,
      headers: { ...t.me, ...body.headers },
      payload: body.payload,
    });
    expect(res.statusCode).toBe(400);
    expect(t.store.keys()).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it("not multipart at all", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: `${PREFIX}/files`,
      headers: { ...t.me, "content-type": "application/json" },
      payload: { size: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid-upload");
  });
});

describe("object first, then the row", () => {
  it("when the row cannot be written, the object is deleted", async () => {
    const res = await uploadWithFailingRow();
    expect(res.statusCode).toBe(500);
    expect(t.store.keys()).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it("when the object cannot be stored, no row is written", async () => {
    vi.spyOn(t.store, "putObject").mockRejectedValue(
      Object.assign(new Error("down"), { name: "StorageError" }),
    );
    const res = await upload(t, t.me, { filename: "a.txt", data: text("hello") });
    expect(res.statusCode).toBe(500);
    expect(rows()).toEqual([]);
  });

  it("a storage outage answers 503, retryable", async () => {
    const { StorageError } = await import("../storage/errors.js");
    vi.spyOn(t.store, "putObject").mockRejectedValue(
      new StorageError("unreachable", "object storage did not answer"),
    );
    const res = await upload(t, t.me, { filename: "a.txt", data: text("hello") });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "storage-unavailable", retryable: true });
    expect(rows()).toEqual([]);
  });
});

/** Upload while every DriveFile upsert fails (the fake's model is rebuilt per call). */
async function uploadWithFailingRow() {
  const original = t.db.model.bind(t.db);
  vi.spyOn(t.db, "model").mockImplementation((name: string) => {
    const model = original(name);
    if (name !== "driveFile") return model;
    return { ...model, upsert: async () => Promise.reject(new Error("database is down")) };
  });
  return await upload(t, t.me, { filename: "a.txt", data: text("hello") });
}

describe("parent folder", () => {
  it.each([
    ["an unknown id", () => "ext-missing"],
    ["another user's folder", () => "ext-theirs"],
    ["a file, not a folder", () => "ext-file"],
  ])("%s is refused before anything is stored", async (_label, parent) => {
    t = await buildKlornDriveApp({
      seed: [
        klornRow({ userId: "user-2", externalId: "ext-theirs", isFolder: true, sizeBytes: null }),
        klornRow({ externalId: "ext-file" }),
      ],
    });
    const res = await upload(t, t.me, { filename: "a.txt", data: text("hi"), parent: parent() });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("parent-not-found");
    expect(t.store.keys()).toEqual([]);
  });
});

describe("while the account's files are being deleted", () => {
  it("an upload is refused before anything is stored", async () => {
    t.db.tables.storagePurge = [
      { userId: "user-1", requestedAt: new Date(), attempts: 0, nextAttemptAt: new Date() },
    ];
    const res = await upload(t, t.me, { filename: "a.txt", data: text("hi") });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("account-purging");
    expect(t.store.keys()).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it("a deletion that starts during the PUT: the landed object is deleted, no row", async () => {
    const put = t.store.putObject.bind(t.store);
    vi.spyOn(t.store, "putObject").mockImplementation(async (key, body, options) => {
      const meta = await put(key, body, options);
      t.db.tables.storagePurge = [
        { userId: "user-1", requestedAt: new Date(), attempts: 0, nextAttemptAt: new Date() },
      ];
      return meta;
    });
    const res = await upload(t, t.me, { filename: "a.txt", data: text("hi") });
    expect(res.statusCode).toBe(409);
    expect(t.store.keys()).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it("another user's purge does not hold this user back", async () => {
    t.db.tables.storagePurge = [
      { userId: "user-2", requestedAt: new Date(), attempts: 0, nextAttemptAt: new Date() },
    ];
    expect((await upload(t, t.me, { filename: "a.txt", data: text("hi") })).statusCode).toBe(201);
  });
});

describe("quota (P3: a number set at flip time; unset means no limit)", () => {
  it("refuses an upload that would pass the limit, counting only the user's own files", async () => {
    vi.stubEnv("KLORN_DRIVE_QUOTA_BYTES", "10");
    t = await buildKlornDriveApp({
      seed: [klornRow({ sizeBytes: 8n }), klornRow({ userId: "user-2", sizeBytes: 9_999n })],
    });
    const refused = await upload(t, t.me, { filename: "a.txt", data: text("abc") });
    expect(refused.statusCode).toBe(413);
    expect(refused.json().code).toBe("quota-exceeded");
    expect(t.store.keys()).toEqual([]);
    const fits = await upload(t, t.me, { filename: "b.txt", data: text("ab") });
    expect(fits.statusCode).toBe(201);
  });

  it("an unusable value fails closed, without storing anything", async () => {
    vi.stubEnv("KLORN_DRIVE_QUOTA_BYTES", "10GB");
    const res = await upload(t, t.me, { filename: "a.txt", data: text("abc") });
    expect(res.statusCode).toBe(503);
    expect(t.store.keys()).toEqual([]);
  });
});

describe("authentication", () => {
  it("answers 401 without a session and stores nothing", async () => {
    const res = await upload(t, {}, { filename: "a.txt", data: text("abc") });
    expect(res.statusCode).toBe(401);
    expect(t.store.keys()).toEqual([]);
  });
});
