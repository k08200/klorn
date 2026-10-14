/**
 * D3: POST /api/drive/files, the Klorn drive's upload, over the real modules, a
 * fake database and the in-memory object store. The object is stored first and
 * the row written after it; a request that does not end cleanly leaves neither.
 * The type comes from the bytes, never from the client. The size is checked
 * before the first byte and counted while the bytes flow.
 */

import { createHash } from "node:crypto";
import { Readable } from "node:stream";
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

import { warnIfKlornDriveQuotaMissing } from "../drive/klorn-quota.js";
import {
  KLORN_DRIVE_MAX_FILE_BYTES,
  storeKlornUpload,
  UPLOAD_HEAD_TIMEOUT_MS,
} from "../drive/klorn-upload.js";
import { uploadRequestFailure } from "../routes/klorn-drive.js";
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

describe("a body longer than the sniffed head, sent in many chunks", () => {
  it("is stored byte for byte, with the etag of every byte", async () => {
    const data = new Uint8Array(10 * 1024 + 7).map((_, i) => (i * 31) % 251);
    const body = multipart([
      { name: "size", value: String(data.length) },
      { name: "file", filename: "long.bin", data },
    ]);
    const CHUNK = 997;
    const chunks: Buffer[] = [];
    for (let at = 0; at < body.payload.length; at += CHUNK) {
      chunks.push(body.payload.subarray(at, at + CHUNK));
    }
    const res = await t.app.inject({
      method: "POST",
      url: `${PREFIX}/files`,
      headers: { ...t.me, ...body.headers, "content-length": String(body.payload.length) },
      payload: Readable.from(chunks),
    });
    expect(res.statusCode).toBe(201);
    const stored = await t.store.getObject(t.store.keys()[0] ?? "");
    const parts: Buffer[] = [];
    for await (const chunk of stored?.body ?? []) parts.push(Buffer.from(chunk));
    expect(Buffer.concat(parts).equals(Buffer.from(data))).toBe(true);
    expect(rows()[0]?.etag).toBe(`sha256:${createHash("sha256").update(data).digest("hex")}`);
  });
});

describe("a malformed multipart body", () => {
  it("a body cut short is a 400 multipart-malformed, not a 500", async () => {
    const body = multipart([
      { name: "size", value: "5" },
      { name: "file", filename: "a.txt", data: text("hello") },
    ]);
    const cut = body.payload.subarray(0, body.payload.length - 30);
    const res = await t.app.inject({
      method: "POST",
      url: `${PREFIX}/files`,
      headers: { ...t.me, ...body.headers },
      payload: cut,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "multipart-malformed", retryable: false });
    expect(t.store.keys()).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it("a body with no closing boundary before the first part is a 400 too", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: `${PREFIX}/files`,
      headers: { ...t.me, "content-type": "multipart/form-data; boundary=xyz" },
      payload: '--xyz\r\nContent-Disposition: form-data; name="size"\r\n\r\n5',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("multipart-malformed");
  });
});

describe("a client that goes away mid-upload", () => {
  it.each([
    "ERR_STREAM_PREMATURE_CLOSE",
    "FST_MP_PREMATURE_CLOSE",
  ])("%s is the client's doing: a 400, not a 500", (code) => {
    const mapped = uploadRequestFailure(Object.assign(new Error("closed"), { code }));
    expect(mapped).toMatchObject({ code: "invalid-upload" });
  });

  it("an error without a known code is left as it is", () => {
    const err = new Error("boom");
    expect(uploadRequestFailure(err)).toBe(err);
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
    expect(res.statusCode).toBe(413);
    expect(res.json().code).toBe("too-large");
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

  it.each(["", "-1", "1e3", "0x10", " 12x", " 5", "05"])("size %j is refused", async (size) => {
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

  it("an unexpected store failure is a 500, and no row is written", async () => {
    vi.spyOn(t.store, "putObject").mockRejectedValue(new Error("unexpected"));
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

  it("when the check after the PUT fails, the object is deleted, not orphaned", async () => {
    const original = t.db.model.bind(t.db);
    let checks = 0;
    vi.spyOn(t.db, "model").mockImplementation((name: string) => {
      const model = original(name);
      if (name !== "storagePurge") return model;
      return {
        ...model,
        findUnique: async (args: never) => {
          checks += 1;
          // Before anything, right before the PUT, then after it: the third fails.
          if (checks === 3) throw new Error("database is down");
          return model.findUnique(args);
        },
      };
    });
    const res = await upload(t, t.me, { filename: "a.txt", data: text("hi") });
    expect(res.statusCode).toBe(500);
    expect(checks).toBe(3);
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

describe("races the commit closes", () => {
  it("the quota is checked again right before the row: a file that landed meanwhile counts", async () => {
    vi.stubEnv("KLORN_DRIVE_QUOTA_BYTES", "10");
    const put = t.store.putObject.bind(t.store);
    vi.spyOn(t.store, "putObject").mockImplementation(async (key, body, options) => {
      const meta = await put(key, body, options);
      await t.db.model("driveFile").create({ data: klornRow({ sizeBytes: 5n }) }); // another upload committed
      return meta;
    });
    const res = await upload(t, t.me, { filename: "a.txt", data: text("abcdefgh") });
    expect(res.statusCode).toBe(413);
    expect(res.json().code).toBe("quota-exceeded");
    expect(t.store.keys()).toEqual([]);
    expect(rows()).toHaveLength(1);
  });

  it("a data deletion that starts while the row is written: row and object go again", async () => {
    const original = t.db.model.bind(t.db);
    vi.spyOn(t.db, "model").mockImplementation((name: string) => {
      const model = original(name);
      if (name !== "driveFile") return model;
      return {
        ...model,
        upsert: async (args: never) => {
          const row = await model.upsert(args);
          t.db.tables.storagePurge = [
            { userId: "user-1", requestedAt: new Date(), attempts: 0, nextAttemptAt: new Date() },
          ];
          return row;
        },
      };
    });
    const res = await upload(t, t.me, { filename: "a.txt", data: text("hi") });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("account-purging");
    expect(rows()).toEqual([]);
    expect(t.store.keys()).toEqual([]);
  });
});

describe("a body that never starts", () => {
  it(`is refused after ${UPLOAD_HEAD_TIMEOUT_MS / 1000} s, and released`, async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const release = vi.fn(async () => ({ done: true as const, value: undefined }));
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
        return: release,
      }),
    };
    const stored = storeKlornUpload({
      userId: "user-1",
      fileName: "slow.txt",
      declaredSize: "5",
      parentExternalId: undefined,
      body,
    });
    const outcome = expect(stored).rejects.toMatchObject({ code: "invalid-upload" });
    await vi.advanceTimersByTimeAsync(UPLOAD_HEAD_TIMEOUT_MS);
    await outcome;
    expect(release).toHaveBeenCalled();
    expect(t.store.keys()).toEqual([]);
    vi.useRealTimers();
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

  it("no quota configured: uploads are refused, nothing is stored", async () => {
    vi.stubEnv("KLORN_DRIVE_QUOTA_BYTES", "");
    const res = await upload(t, t.me, { filename: "a.txt", data: text("abc") });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "quota-not-configured", retryable: false });
    expect(t.store.keys()).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it("boot names the missing variable while the drive is live, and only then", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("KLORN_DRIVE_QUOTA_BYTES", "");
    warnIfKlornDriveQuotaMissing();
    expect(warn.mock.calls.flat().join(" ")).toContain("KLORN_DRIVE_QUOTA_BYTES");
    warn.mockClear();
    vi.stubEnv("KLORN_DRIVE_ENABLED", "false");
    warnIfKlornDriveQuotaMissing();
    vi.stubEnv("KLORN_DRIVE_ENABLED", "true");
    vi.stubEnv("KLORN_DRIVE_QUOTA_BYTES", "1000");
    warnIfKlornDriveQuotaMissing();
    expect(warn).not.toHaveBeenCalled();
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
