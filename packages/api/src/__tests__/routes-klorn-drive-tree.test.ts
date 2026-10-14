/**
 * D3: the Klorn drive's folders, download, rename/move and delete, over the real
 * modules, a fake database and the in-memory object store. Every route finds the
 * row under the session's user; an external file is read-only; a folder cannot
 * move into itself; a delete removes the object before the row. Dark (Fastify's
 * default 404) unless all three flags are on, and rate limited per address and
 * per user.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Row } from "./helpers/fake-db.js";
import {
  buildKlornDriveApp,
  FLAGS,
  flagsOn,
  type KlornDriveTestApp,
  klornRow,
  PREFIX,
  resetRowIds,
  upload,
} from "./helpers/klorn-drive-app.js";

vi.mock("../db.js", async () => {
  const { klornDriveDbMock } = await import("./helpers/klorn-drive-app.js");
  return klornDriveDbMock();
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { deleteKlornItem, klornDownloadLink } from "../drive/klorn-remove.js";
import {
  DRIVE_FOLDER_WALK_MAX_ITEMS,
  DRIVE_MAX_FOLDER_DEPTH,
  updateKlornItem,
} from "../drive/klorn-tree.js";
import { StorageError } from "../storage/errors.js";
import { setObjectStoreForTests } from "../storage/runtime.js";

const text = (value: string) => new TextEncoder().encode(value);
let t: KlornDriveTestApp;
const rows = () => t.db.tables.driveFile ?? [];
const names = () =>
  rows()
    .map((row) => row.name)
    .sort();

type Method = "GET" | "POST" | "PATCH" | "DELETE";
function call(method: Method, path: string, headers: Record<string, string>, payload?: object) {
  return t.app.inject({
    method,
    url: `${PREFIX}${path}`,
    headers,
    ...(payload && { payload }),
  });
}

function folder(over: Row = {}): Row {
  return klornRow({ isFolder: true, mimeType: null, sizeBytes: null, ...over });
}

/** A Klorn file with its object in the store. */
async function storedFile(over: Row = {}): Promise<Row> {
  const userId = (over.userId as string | undefined) ?? "user-1";
  const res = await upload(t, userId === "user-1" ? t.me : t.other, {
    filename: (over.name as string | undefined) ?? "a.txt",
    data: text("hello"),
    ...(over.parentExternalId ? { parent: over.parentExternalId as string } : {}),
  });
  expect(res.statusCode).toBe(201);
  const created = rows().find((row) => row.id === res.json().file.id);
  if (!created) throw new Error("upload wrote no row");
  return created;
}

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

describe("dark unless DRIVE_ENABLED, KLORN_DRIVE_ENABLED and OBJECT_STORAGE_ENABLED are all on", () => {
  const ID = "00000000-0000-4000-8000-000000000001";
  const ROUTES: Array<[Method, string]> = [
    ["POST", "/files"],
    ["POST", "/folders"],
    ["GET", `/files/${ID}/download`],
    ["PATCH", `/files/${ID}`],
    ["DELETE", `/files/${ID}`],
  ];

  it.each(FLAGS)("with %s off, every route answers like one that does not exist", async (flag) => {
    vi.stubEnv(flag, "false");
    const bare = Fastify();
    await bare.ready();
    for (const [method, path] of ROUTES) {
      const dark = await call(method, path, {});
      const missing = await bare.inject({ method, url: `${PREFIX}${path}` });
      expect(dark.statusCode).toBe(404);
      expect(dark.body).toBe(missing.body);
    }
    await bare.close();
  });

  it("with KLORN_DRIVE_ENABLED off, an uploaded file disappears from the list", async () => {
    await storedFile();
    vi.stubEnv("KLORN_DRIVE_ENABLED", "false");
    const list = await call("GET", "/files", t.me);
    expect(list.json().files).toEqual([]);
  });
});

describe("folders", () => {
  it("creates a folder at the root and one inside it", async () => {
    const top = await call("POST", "/folders", t.me, { name: "Projects" });
    expect(top.statusCode).toBe(201);
    expect(top.json().file).toMatchObject({ name: "Projects", isFolder: true, sizeBytes: null });
    const parent = top.json().file.externalId;
    const inner = await call("POST", "/folders", t.me, { name: "2026", parentExternalId: parent });
    expect(inner.json().file.parentExternalId).toBe(parent);
    const listing = await call("GET", `/files?folder=${parent}`, t.me);
    expect(listing.json().files.map((f: { name: string }) => f.name)).toEqual(["2026"]);
  });

  it("refuses an empty name, and a parent that is not the user's folder", async () => {
    t = await buildKlornDriveApp({ seed: [folder({ userId: "user-2", externalId: "theirs" })] });
    expect((await call("POST", "/folders", t.me, { name: "‮" })).json().code).toBe("invalid-name");
    const res = await call("POST", "/folders", t.me, { name: "x", parentExternalId: "theirs" });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("parent-not-found");
  });

  it(`refuses a folder deeper than ${DRIVE_MAX_FOLDER_DEPTH}`, async () => {
    const chain = Array.from({ length: DRIVE_MAX_FOLDER_DEPTH }, (_, i) =>
      folder({ externalId: `f${i}`, parentExternalId: i === 0 ? null : `f${i - 1}` }),
    );
    t = await buildKlornDriveApp({ seed: chain });
    const res = await call("POST", "/folders", t.me, {
      name: "one too many",
      parentExternalId: `f${DRIVE_MAX_FOLDER_DEPTH - 1}`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("too-deep");
    const fits = await call("POST", "/folders", t.me, {
      name: "fits",
      parentExternalId: `f${DRIVE_MAX_FOLDER_DEPTH - 2}`,
    });
    expect(fits.statusCode).toBe(201);
  });
});

describe("download", () => {
  it("answers a short-lived signed link that downloads as an attachment, never cached", async () => {
    const file = await storedFile({ name: "Q3 report.pdf" });
    const res = await call("GET", `/files/${file.id}/download`, t.me);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const { url, expiresInSeconds } = res.json();
    expect(expiresInSeconds).toBe(60);
    const link = new URL(url);
    expect(link.pathname).toContain(file.storageKey as string);
    expect(link.searchParams.get("response-content-disposition")).toMatch(/^attachment;/);
    expect(link.searchParams.get("response-content-type")).toBe("application/octet-stream");
  });

  it("another user's file is a 404, like an unknown id", async () => {
    const file = await storedFile();
    for (const id of [file.id as string, "00000000-0000-4000-8000-0000000000ff", "../x"]) {
      const res = await call("GET", `/files/${encodeURIComponent(id)}/download`, t.other);
      expect(res.statusCode).toBe(404);
    }
  });

  it("a folder has nothing to download", async () => {
    t = await buildKlornDriveApp({ seed: [folder()] });
    const res = await call("GET", `/files/${rows()[0]?.id}/download`, t.me);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("is-folder");
  });

  it("an external file is read-only here, whatever the route", async () => {
    const google = klornRow({
      provider: "GOOGLE",
      sourceKey: "acct-1",
      webUrl: "https://drive.google.com/file/d/x/view",
    });
    t = await buildKlornDriveApp({ seed: [google] });
    // GOOGLE has no connector registered, so the file is hidden: a 404.
    expect((await call("GET", `/files/${google.id}/download`, t.me)).statusCode).toBe(404);
    // With a connector on, it is visible, and every Klorn operation refuses it (V4).
    const withGoogle = { KLORN: () => true, GOOGLE: () => true };
    const id = google.id as string;
    const refusals = await Promise.allSettled([
      klornDownloadLink("user-1", id, withGoogle),
      updateKlornItem("user-1", id, { name: "x" }, withGoogle),
      deleteKlornItem("user-1", id, withGoogle),
    ]);
    for (const refusal of refusals) {
      expect(refusal).toMatchObject({ status: "rejected", reason: { code: "read-only" } });
    }
    expect(rows()).toHaveLength(1);
  });
});

describe("rename and move", () => {
  it("renames, keeping the content's modified time", async () => {
    const file = await storedFile({ name: "old.txt" });
    const res = await call("PATCH", `/files/${file.id}`, t.me, { name: "new.txt" });
    expect(res.statusCode).toBe(200);
    expect(res.json().file.name).toBe("new.txt");
    expect(res.json().file.modifiedAt).toBe((file.modifiedAt as Date).toISOString());
  });

  it("moves into a folder and back to the root", async () => {
    t = await buildKlornDriveApp({ seed: [folder({ externalId: "docs" })] });
    const file = await storedFile();
    const into = await call("PATCH", `/files/${file.id}`, t.me, { parentExternalId: "docs" });
    expect(into.json().file.parentExternalId).toBe("docs");
    const out = await call("PATCH", `/files/${file.id}`, t.me, { parentExternalId: null });
    expect(out.json().file.parentExternalId).toBeNull();
  });

  it("a folder cannot move into itself or into one of its own folders", async () => {
    t = await buildKlornDriveApp({
      seed: [
        folder({ externalId: "a" }),
        folder({ externalId: "b", parentExternalId: "a" }),
        folder({ externalId: "c", parentExternalId: "b" }),
      ],
    });
    const a = rows().find((row) => row.externalId === "a");
    for (const target of ["a", "b", "c"]) {
      const res = await call("PATCH", `/files/${a?.id}`, t.me, { parentExternalId: target });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("cycle");
    }
    expect(rows().find((row) => row.externalId === "a")?.parentExternalId).toBeNull();
  });

  it("a move that would put a folder past the depth bound is refused", async () => {
    const chain = Array.from({ length: DRIVE_MAX_FOLDER_DEPTH - 1 }, (_, i) =>
      folder({ externalId: `d${i}`, parentExternalId: i === 0 ? null : `d${i - 1}` }),
    );
    t = await buildKlornDriveApp({
      seed: [
        ...chain,
        folder({ externalId: "m" }),
        folder({ externalId: "m1", parentExternalId: "m" }),
      ],
    });
    const m = rows().find((row) => row.externalId === "m");
    const res = await call("PATCH", `/files/${m?.id}`, t.me, {
      parentExternalId: `d${DRIVE_MAX_FOLDER_DEPTH - 2}`,
    });
    expect(res.json().code).toBe("too-deep");
  });

  it("a move that exactly fits the depth bound is allowed", async () => {
    const chain = Array.from({ length: DRIVE_MAX_FOLDER_DEPTH - 2 }, (_, i) =>
      folder({ externalId: `d${i}`, parentExternalId: i === 0 ? null : `d${i - 1}` }),
    );
    t = await buildKlornDriveApp({
      seed: [
        ...chain,
        folder({ externalId: "m" }),
        folder({ externalId: "m1", parentExternalId: "m" }),
      ],
    });
    const m = rows().find((row) => row.externalId === "m");
    const res = await call("PATCH", `/files/${m?.id}`, t.me, {
      parentExternalId: `d${DRIVE_MAX_FOLDER_DEPTH - 3}`,
    });
    expect(res.statusCode).toBe(200);
  });

  it("refuses another user's file, a missing parent, and an empty body", async () => {
    const file = await storedFile();
    expect((await call("PATCH", `/files/${file.id}`, t.other, { name: "x" })).statusCode).toBe(404);
    const noParent = await call("PATCH", `/files/${file.id}`, t.me, { parentExternalId: "nope" });
    expect(noParent.json().code).toBe("parent-not-found");
    expect((await call("PATCH", `/files/${file.id}`, t.me, {})).statusCode).toBe(400);
  });

  it("a rename racing a delete does not bring the row back", async () => {
    const file = await storedFile();
    const original = t.db.model.bind(t.db);
    vi.spyOn(t.db, "model").mockImplementation((name: string) => {
      const model = original(name);
      if (name !== "driveFile") return model;
      return {
        ...model,
        updateMany: async (args: never) => {
          t.db.tables.driveFile = [];
          return model.updateMany(args);
        },
      };
    });
    const res = await call("PATCH", `/files/${file.id}`, t.me, { name: "renamed.txt" });
    expect(res.statusCode).toBe(404);
    expect(rows()).toEqual([]);
  });
});

describe("delete", () => {
  it("a file: the object goes first, then the row", async () => {
    const file = await storedFile();
    const order: string[] = [];
    const del = t.store.deleteObject.bind(t.store);
    vi.spyOn(t.store, "deleteObject").mockImplementation(async (key) => {
      order.push(`object:${rows().length}`);
      return del(key);
    });
    const res = await call("DELETE", `/files/${file.id}`, t.me);
    expect(res.json()).toEqual({ deleted: { files: 1, folders: 0 } });
    expect(order).toEqual(["object:1"]); // the row still existed while the object went
    expect(t.store.keys()).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it("when the object cannot be deleted, the row stays and the answer is retryable", async () => {
    const file = await storedFile();
    vi.spyOn(t.store, "deleteObject").mockRejectedValue(
      new StorageError("unreachable", "object storage did not answer"),
    );
    const res = await call("DELETE", `/files/${file.id}`, t.me);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "storage-unavailable", retryable: true });
    expect(rows()).toHaveLength(1);
  });

  it("another user's file is a 404 and stays, object and row", async () => {
    const file = await storedFile();
    expect((await call("DELETE", `/files/${file.id}`, t.other)).statusCode).toBe(404);
    expect(rows()).toHaveLength(1);
    expect(t.store.keys()).toHaveLength(1);
  });

  it("a folder goes with everything in it, and nothing outside it", async () => {
    t = await buildKlornDriveApp({
      seed: [
        folder({ externalId: "top", name: "top" }),
        folder({ externalId: "sub", name: "sub", parentExternalId: "top" }),
        folder({ externalId: "keep", name: "keep" }),
      ],
    });
    await storedFile({ name: "in-top.txt", parentExternalId: "top" });
    await storedFile({ name: "in-sub.txt", parentExternalId: "sub" });
    await storedFile({ name: "outside.txt", parentExternalId: "keep" });
    const top = rows().find((row) => row.externalId === "top");
    const res = await call("DELETE", `/files/${top?.id}`, t.me);
    expect(res.json()).toEqual({ deleted: { files: 2, folders: 2 } });
    expect(names()).toEqual(["keep", "outside.txt"]);
    expect(t.store.keys()).toHaveLength(1);
  });

  it("a partial folder delete keeps what is left and continues on the next request", async () => {
    t = await buildKlornDriveApp({ seed: [folder({ externalId: "top", name: "top" })] });
    for (let i = 0; i < 10; i++) await storedFile({ name: `f${i}.txt`, parentExternalId: "top" });
    const del = t.store.deleteObject.bind(t.store);
    let calls = 0;
    const spy = vi.spyOn(t.store, "deleteObject").mockImplementation(async (key) => {
      calls += 1;
      if (calls === 9) throw new StorageError("unreachable", "object storage did not answer");
      return del(key);
    });
    const top = rows().find((row) => row.externalId === "top");
    const first = await call("DELETE", `/files/${top?.id}`, t.me);
    expect(first.statusCode).toBe(503);
    // The first batch of 8 went, and in the second batch the one delete that
    // passed: object and row. The folder and the file that failed stay, and the
    // delete stopped there.
    expect(rows()).toHaveLength(2);
    expect(t.store.keys()).toHaveLength(1);
    expect(
      rows().every((row) => row.isFolder || t.store.keys().includes(row.storageKey as string)),
    ).toBe(true);
    spy.mockRestore();
    const second = await call("DELETE", `/files/${top?.id}`, t.me);
    expect(second.json()).toEqual({ deleted: { files: 1, folders: 1 } });
    expect(rows()).toEqual([]);
    expect(t.store.keys()).toEqual([]);
  });

  it("a folder caught in a cycle (two racing moves) can still be deleted", async () => {
    t = await buildKlornDriveApp({
      seed: [
        folder({ externalId: "a", name: "a", parentExternalId: "b" }),
        folder({ externalId: "b", name: "b", parentExternalId: "a" }),
        folder({ externalId: "keep", name: "keep" }),
      ],
    });
    await storedFile({ name: "in-a.txt", parentExternalId: "a" });
    const a = rows().find((row) => row.externalId === "a");
    const res = await call("DELETE", `/files/${a?.id}`, t.me);
    expect(res.json()).toEqual({ deleted: { files: 1, folders: 2 } });
    expect(names()).toEqual(["keep"]);
    expect(t.store.keys()).toEqual([]);
  });

  it(`a folder with exactly ${DRIVE_FOLDER_WALK_MAX_ITEMS} items is deleted in one request`, async () => {
    const many = Array.from({ length: DRIVE_FOLDER_WALK_MAX_ITEMS }, (_, i) =>
      klornRow({ externalId: `x${i}`, parentExternalId: "big", storageKey: null }),
    );
    t = await buildKlornDriveApp({ seed: [folder({ externalId: "big" }), ...many] });
    const big = rows().find((row) => row.externalId === "big");
    const res = await call("DELETE", `/files/${big?.id}`, t.me);
    expect(res.json()).toEqual({ deleted: { files: DRIVE_FOLDER_WALK_MAX_ITEMS, folders: 1 } });
    expect(rows()).toEqual([]);
  });

  it("stops at the first batch with a failure: later batches are not sent", async () => {
    t = await buildKlornDriveApp({ seed: [folder({ externalId: "top", name: "top" })] });
    for (let i = 0; i < 20; i++) await storedFile({ name: `f${i}.txt`, parentExternalId: "top" });
    const del = t.store.deleteObject.bind(t.store);
    let calls = 0;
    vi.spyOn(t.store, "deleteObject").mockImplementation(async (key) => {
      calls += 1;
      if (calls === 1) throw new StorageError("unreachable", "object storage did not answer");
      return del(key);
    });
    const top = rows().find((row) => row.externalId === "top");
    expect((await call("DELETE", `/files/${top?.id}`, t.me)).statusCode).toBe(503);
    expect(calls).toBe(8); // one batch of 8, then stop
    expect(t.store.keys()).toHaveLength(13);
    expect(rows()).toHaveLength(14); // the folder and the 13 files still holding objects
  });

  it("a partial delete whose row cleanup also fails still answers the storage error", async () => {
    t = await buildKlornDriveApp({ seed: [folder({ externalId: "top", name: "top" })] });
    for (let i = 0; i < 10; i++) await storedFile({ name: `f${i}.txt`, parentExternalId: "top" });
    const del = t.store.deleteObject.bind(t.store);
    let calls = 0;
    vi.spyOn(t.store, "deleteObject").mockImplementation(async (key) => {
      calls += 1;
      if (calls === 9) throw new StorageError("unreachable", "object storage did not answer");
      return del(key);
    });
    const original = t.db.model.bind(t.db);
    vi.spyOn(t.db, "model").mockImplementation((name: string) => {
      const model = original(name);
      if (name !== "driveFile") return model;
      return { ...model, deleteMany: async () => Promise.reject(new Error("database is down")) };
    });
    const top = rows().find((row) => row.externalId === "top");
    const res = await call("DELETE", `/files/${top?.id}`, t.me);
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("storage-unavailable");
  });

  it(`a folder with more than ${DRIVE_FOLDER_WALK_MAX_ITEMS} items is refused, and nothing is deleted`, async () => {
    const many = Array.from({ length: DRIVE_FOLDER_WALK_MAX_ITEMS + 1 }, (_, i) =>
      klornRow({ externalId: `x${i}`, parentExternalId: "big", storageKey: null }),
    );
    t = await buildKlornDriveApp({ seed: [folder({ externalId: "big" }), ...many] });
    const big = rows().find((row) => row.externalId === "big");
    const res = await call("DELETE", `/files/${big?.id}`, t.me);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("folder-too-large");
    expect(rows()).toHaveLength(DRIVE_FOLDER_WALK_MAX_ITEMS + 2);
  });
});

describe("rate limits", () => {
  const from = (ip: number, headers: Record<string, string>) => ({
    ...headers,
    "cf-connecting-ip": `10.0.0.${ip}`,
  });
  const ID = "00000000-0000-4000-8000-0000000000aa";

  it.each([
    ["download", "GET", `/files/${ID}/download`, 60],
    ["delete", "DELETE", `/files/${ID}`, 30],
  ] as const)("%s: per address, whoever asks", async (_name, method, path, max) => {
    t = await buildKlornDriveApp({ withRateLimit: true });
    for (let i = 0; i < max; i += 1) {
      expect((await call(method, path, i % 2 === 0 ? t.me : t.other)).statusCode).toBe(404);
    }
    expect((await call(method, path, t.me)).statusCode).toBe(429);
  });

  it.each([
    ["download", "GET", `/files/${ID}/download`, 60],
    ["delete", "DELETE", `/files/${ID}`, 30],
  ] as const)("%s: per user, from any address", async (_name, method, path, max) => {
    t = await buildKlornDriveApp({ withRateLimit: true });
    for (let i = 0; i < max; i += 1) {
      expect((await call(method, path, from(i, t.me))).statusCode).toBe(404);
    }
    expect((await call(method, path, from(250, t.me))).statusCode).toBe(429);
    expect((await call(method, path, from(251, t.other))).statusCode).toBe(404);
  });

  it("folders, rename and move: 60 a minute per user, from any address", async () => {
    t = await buildKlornDriveApp({ withRateLimit: true });
    for (let i = 0; i < 60; i += 1) {
      const res = await call("POST", "/folders", from(i, t.me), { name: `f${i}` });
      expect(res.statusCode).toBe(201);
    }
    expect((await call("POST", "/folders", from(250, t.me), { name: "late" })).statusCode).toBe(
      429,
    );
    expect(
      (await call("PATCH", `/files/${ID}`, from(251, t.other), { name: "x" })).statusCode,
    ).toBe(404);
  });

  it("upload: 20 a minute per user, from any address", async () => {
    t = await buildKlornDriveApp({ withRateLimit: true });
    for (let i = 0; i < 20; i += 1) {
      const res = await upload(t, from(i, t.me), { filename: `f${i}.txt`, data: text("x") });
      expect(res.statusCode).toBe(201);
    }
    const limited = await upload(t, from(99, t.me), { filename: "late.txt", data: text("x") });
    expect(limited.statusCode).toBe(429);
    expect(t.store.keys()).toHaveLength(20);
  });

  it("upload: 20 a minute per address, whoever asks", async () => {
    t = await buildKlornDriveApp({ withRateLimit: true });
    for (let i = 0; i < 20; i += 1) {
      const res = await upload(t, i % 2 === 0 ? t.me : t.other, {
        filename: "f.txt",
        data: text("x"),
      });
      expect(res.statusCode).toBe(201);
    }
    expect((await upload(t, t.me, { filename: "late.txt", data: text("x") })).statusCode).toBe(429);
  });
});
