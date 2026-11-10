/**
 * D3: the account purge is durable and no longer blocks a deletion (D1 review
 * M2). With OBJECT_STORAGE_ENABLED on, `purgeUserObjects` records a pending
 * purge first, tries the bucket once, and resolves whatever the bucket does; the
 * record and the hourly sweep finish the job. Only a failure to WRITE the record
 * still blocks, because then nothing would remember the objects. Off, nothing
 * here runs: no record, no query, no store.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => dbHolder.current as FakeDb);
  return { prisma, db: prisma };
});
const captureError = vi.hoisted(() => vi.fn());
vi.mock("../sentry.js", () => ({ captureError }));

import { StorageError } from "../storage/errors.js";
import { newObjectKey } from "../storage/keys.js";
import { MemoryObjectStore } from "../storage/memory-store.js";
import { LATE_UPLOAD_GRACE_MS, PURGE_ALERT_AFTER_ATTEMPTS } from "../storage/purge-queue.js";
import { purgeUserObjects, setObjectStoreForTests } from "../storage/runtime.js";
import { bytesOf } from "./helpers/storage-bytes.js";

const STORAGE_ENV = {
  OBJECT_STORAGE_ENDPOINT: "https://acct-id-0001.r2.cloudflarestorage.com",
  OBJECT_STORAGE_REGION: "auto",
  OBJECT_STORAGE_BUCKET: "klorn-objects",
  OBJECT_STORAGE_ACCESS_KEY_ID: "DURABLEACCESSKEY01",
  OBJECT_STORAGE_SECRET_ACCESS_KEY: "durable-secret",
} as const;

let db: FakeDb;
let store: MemoryObjectStore;
let errorSpy: ReturnType<typeof vi.spyOn>;
const record = () => (db.tables.storagePurge ?? [])[0];

async function seededStore(): Promise<MemoryObjectStore> {
  const seeded = new MemoryObjectStore({ deletePageSize: 2 });
  for (const userId of ["user-1", "user-1", "user-1", "user-2"]) {
    const key = newObjectKey(userId, "drive");
    await seeded.putObject(key, bytesOf("x"), { contentType: "text/plain", size: 1 });
  }
  return seeded;
}

function flag(value: "true" | "false", env: Record<string, string> = STORAGE_ENV): void {
  vi.stubEnv("OBJECT_STORAGE_ENABLED", value);
  for (const [name, setting] of Object.entries(env)) vi.stubEnv(name, setting);
}

beforeEach(async () => {
  db = createFakeDb({ storagePurge: [] });
  dbHolder.current = db;
  store = await seededStore();
  setObjectStoreForTests(store);
  captureError.mockReset();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-10-14T00:00:00.000Z") });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setObjectStoreForTests(null);
});

describe("flag on", () => {
  it("deletes the objects and leaves a settling record, so late objects are caught", async () => {
    flag("true");
    const result = await purgeUserObjects("user-1");
    expect(result).toEqual({ skipped: false, deleted: 3, outcome: "settling" });
    expect(store.keys()).toHaveLength(1);
    expect(record()).toMatchObject({
      userId: "user-1",
      attempts: 0,
      nextAttemptAt: new Date(Date.now() + LATE_UPLOAD_GRACE_MS),
    });
    expect(captureError).not.toHaveBeenCalled();
  });

  it("resolves when the bucket fails, and the pending record keeps the user id and the code", async () => {
    flag("true");
    const failure = new StorageError("unreachable", "object storage did not answer (TimeoutError)");
    vi.spyOn(store, "deleteByPrefix").mockRejectedValue(failure);

    expect(await purgeUserObjects("user-1")).toEqual({
      skipped: false,
      deleted: 0,
      outcome: "failed",
    });
    expect(record()).toMatchObject({ userId: "user-1", attempts: 1, lastError: "unreachable" });
    expect(captureError).toHaveBeenCalledWith(failure, {
      tags: { scope: "storage.purge", storageCode: "unreachable", retryable: "true" },
    });
    const output = errorSpy.mock.calls.flat().join("\n");
    expect(output).toContain("[STORAGE] purge failed (unreachable)");
    expect(output).not.toContain("durable-secret");
  });

  it("resolves when the config is not usable, and records why", async () => {
    setObjectStoreForTests(null);
    flag("true", {});
    expect((await purgeUserObjects("user-1")).outcome).toBe("failed");
    expect(record()).toMatchObject({ attempts: 1, lastError: "misconfigured" });
  });

  it("still blocks when the record cannot be written: no handle would be left", async () => {
    flag("true");
    const deleteSpy = vi.spyOn(store, "deleteByPrefix");
    dbHolder.current = {
      ...db,
      model: () => {
        throw new Error("database is down");
      },
    };
    await expect(purgeUserObjects("user-1")).rejects.toThrow("database is down");
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(store.keys()).toHaveLength(4);
  });

  it("raises a separate alert once a purge keeps failing", async () => {
    flag("true");
    vi.spyOn(store, "deleteByPrefix").mockRejectedValue(
      new StorageError("access-denied", "object storage refused the credentials"),
    );
    for (let attempt = 1; attempt <= PURGE_ALERT_AFTER_ATTEMPTS; attempt++) {
      await purgeUserObjects("user-1");
    }
    const stuck = captureError.mock.calls.filter(
      ([, context]) =>
        (context as { tags: { scope: string } }).tags.scope === "storage.purge.stuck",
    );
    expect(stuck).toHaveLength(1);
    expect(stuck[0]?.[1]).toMatchObject({
      tags: {
        scope: "storage.purge.stuck",
        storageCode: "access-denied",
        attempts: String(PURGE_ALERT_AFTER_ATTEMPTS),
      },
      extra: { userId: "user-1" },
    });
  });
});

describe("flag off", () => {
  it("touches neither storage nor the database", async () => {
    flag("false");
    const deleteSpy = vi.spyOn(store, "deleteByPrefix");
    expect(await purgeUserObjects("user-1")).toEqual({ skipped: true, deleted: 0 });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(db.reads).toEqual([]);
    expect(db.writes).toEqual({});
    expect(store.keys()).toHaveLength(4);
  });
});
