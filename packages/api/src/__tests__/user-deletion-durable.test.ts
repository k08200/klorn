/**
 * D3: account deletion end to end over the real purge (runtime.ts and
 * durable-purge.ts), a fake database and the in-memory store. With
 * OBJECT_STORAGE_ENABLED on, a bucket that fails no longer keeps the account:
 * the rows go, and a pending purge keeps the user id for the sweep. The
 * deletion still stops when that record cannot be written.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "./helpers/fake-db.js";

const state = vi.hoisted(() => ({
  db: null as unknown,
  userRows: new Set<string>(),
  order: [] as string[],
}));

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const fake = fakePrismaClient(() => state.db as FakeDb) as Record<string, unknown>;
  const prisma = {
    get storagePurge() {
      return fake.storagePurge;
    },
    llmUsageLog: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    user: {
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        state.userRows.delete(where.id);
        return { id: where.id };
      }),
      findUnique: vi.fn(async () => ({ email: "user@example.com" })),
    },
    waitlist: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    $transaction: vi.fn(async (work: unknown) => {
      state.order.push("rows");
      return Array.isArray(work) ? Promise.all(work) : (work as (tx: unknown) => unknown)(prisma);
    }),
  };
  return { prisma, db: prisma, INTERACTIVE_TX_OPTIONS: { maxWait: 10_000, timeout: 15_000 } };
});
vi.mock("../purge-user-data.js", () => ({ purgeUserData: vi.fn(async () => {}) }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { StorageError } from "../storage/errors.js";
import { newObjectKey } from "../storage/keys.js";
import { MemoryObjectStore } from "../storage/memory-store.js";
import { setObjectStoreForTests } from "../storage/runtime.js";
import { deleteUserAndAllData, purgeAllUserData } from "../user-deletion.js";
import { bytesOf } from "./helpers/storage-bytes.js";

let db: FakeDb;
let store: MemoryObjectStore;
const pending = () => (db.tables.storagePurge ?? []).map((row) => row.userId);

beforeEach(async () => {
  db = createFakeDb({ storagePurge: [] });
  state.db = db;
  state.userRows = new Set(["user-1", "user-2"]);
  state.order = [];
  store = new MemoryObjectStore();
  for (const userId of ["user-1", "user-1", "user-2"]) {
    await store.putObject(newObjectKey(userId, "drive"), bytesOf("x"), {
      contentType: "text/plain",
      size: 1,
    });
  }
  setObjectStoreForTests(store);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("OBJECT_STORAGE_ENABLED", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setObjectStoreForTests(null);
});

describe.each([
  ["deleteUserAndAllData", deleteUserAndAllData],
  ["purgeAllUserData", purgeAllUserData],
])("%s with object storage on", (name, remove) => {
  // The data wipe sweeps twice (stragglers from a sync that started before the
  // first commit); account deletion is one transaction.
  const passes = name === "purgeAllUserData" ? ["rows", "rows"] : ["rows"];
  it("a failing store leaves a pending purge, and the rows are gone anyway", async () => {
    vi.spyOn(store, "deleteByPrefix").mockRejectedValue(
      new StorageError("unreachable", "object storage did not answer (TimeoutError)"),
    );
    await expect(remove("user-1")).resolves.toBeUndefined();
    expect(state.order).toEqual(passes);
    expect(pending()).toEqual(["user-1"]);
    expect(db.tables.storagePurge?.[0]).toMatchObject({ attempts: 1, lastError: "unreachable" });
    expect(store.keys()).toHaveLength(3);
  });

  it("a working store deletes the objects, and the record stays for the late-object pass", async () => {
    await remove("user-1");
    expect(store.keys().every((key) => key.startsWith("u/user-2/"))).toBe(true);
    expect(pending()).toEqual(["user-1"]);
    expect(state.order).toEqual(passes);
  });

  it("stops before any row when the pending purge cannot be recorded", async () => {
    state.db = {
      ...db,
      model: () => {
        throw new Error("database is down");
      },
    };
    await expect(remove("user-1")).rejects.toThrow("database is down");
    expect(state.order).toEqual([]);
    expect(store.keys()).toHaveLength(3);
  });
});

describe("account deletion removes the user row while the bucket is down", () => {
  it("the user row is gone and the record still names the user", async () => {
    vi.spyOn(store, "deleteByPrefix").mockRejectedValue(
      new StorageError("upstream", "object storage answered 503", { status: 503 }),
    );
    await deleteUserAndAllData("user-1");
    expect(state.userRows.has("user-1")).toBe(false);
    expect(pending()).toEqual(["user-1"]);
  });
});
