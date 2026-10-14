/**
 * D3: the hourly sweep that finishes pending purges. It retries a failed pass
 * with backoff, and it is the pass that catches an object an upload landed after
 * the deletion's own pass. Off, it reads nothing.
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

import { getSchedulerHealth, resetSchedulerHeartbeats } from "../scheduler-heartbeat.js";
import { StorageError } from "../storage/errors.js";
import { newObjectKey } from "../storage/keys.js";
import { MemoryObjectStore } from "../storage/memory-store.js";
import {
  LATE_UPLOAD_GRACE_MS,
  markPurgePending,
  PURGE_RETRY_BASE_MS,
} from "../storage/purge-queue.js";
import {
  checkStoragePurgesAtStartup,
  PURGE_SWEEP_BATCH,
  PURGE_SWEEP_INTERVAL_MS,
  resetStalledPurgeReportForTests,
  runStoragePurgeSweep,
  startStoragePurgeScheduler,
  stopStoragePurgeScheduler,
  storagePurgeTick,
} from "../storage/purge-sweep.js";
import { purgeUserObjects, setObjectStoreForTests } from "../storage/runtime.js";
import { PURGE_DEADLINE_MS } from "../storage/user-storage.js";
import { bytesOf } from "./helpers/storage-bytes.js";

const T0 = Date.parse("2026-10-14T00:00:00.000Z");
let db: FakeDb;
let store: MemoryObjectStore;
const pending = () => (db.tables.storagePurge ?? []).map((row) => row.userId);

async function put(userId: string): Promise<void> {
  await store.putObject(newObjectKey(userId, "drive"), bytesOf("x"), {
    contentType: "text/plain",
    size: 1,
  });
}

function clock(ms: number): void {
  vi.setSystemTime(T0 + ms);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: T0 });
  resetStalledPurgeReportForTests();
  captureError.mockReset();
  db = createFakeDb({ storagePurge: [] });
  dbHolder.current = db;
  store = new MemoryObjectStore();
  setObjectStoreForTests(store);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubEnv("OBJECT_STORAGE_ENABLED", "true");
});

afterEach(() => {
  stopStoragePurgeScheduler();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setObjectStoreForTests(null);
});

describe("runStoragePurgeSweep", () => {
  it("while object storage is off it only counts the pending purges, and runs none", async () => {
    vi.stubEnv("OBJECT_STORAGE_ENABLED", "false");
    expect(await runStoragePurgeSweep()).toEqual({ state: "off", passes: 0, done: 0, failed: 0 });
    expect(db.reads).toEqual(["storagePurge"]);
    expect(db.writes).toEqual({});
    expect(captureError).not.toHaveBeenCalled();
  });

  it("catches an object an upload landed after the deletion's pass, then finishes the record", async () => {
    await put("user-1");
    await purgeUserObjects("user-1");
    expect(store.keys()).toEqual([]);

    clock(60_000);
    await put("user-1"); // the late upload
    clock(5 * 60_000);
    expect((await runStoragePurgeSweep()).passes).toBe(0); // still inside the grace
    expect(store.keys()).toHaveLength(1);

    clock(LATE_UPLOAD_GRACE_MS + 1);
    expect(await runStoragePurgeSweep()).toEqual({ state: "ran", passes: 1, done: 1, failed: 0 });
    expect(store.keys()).toEqual([]);
    expect(pending()).toEqual([]);
  });

  it("retries a failed purge with backoff until the bucket is back", async () => {
    await put("user-1");
    const deleteByPrefix = vi
      .spyOn(store, "deleteByPrefix")
      .mockRejectedValue(new StorageError("unreachable", "object storage did not answer"));
    await purgeUserObjects("user-1");
    expect(db.tables.storagePurge?.[0]).toMatchObject({ attempts: 1 });

    clock(PURGE_RETRY_BASE_MS);
    expect((await runStoragePurgeSweep()).failed).toBe(1);
    expect(db.tables.storagePurge?.[0]).toMatchObject({
      attempts: 2,
      nextAttemptAt: new Date(T0 + 3 * PURGE_RETRY_BASE_MS),
    });

    clock(2 * PURGE_RETRY_BASE_MS);
    expect((await runStoragePurgeSweep()).passes).toBe(0); // backing off

    deleteByPrefix.mockRestore();
    clock(3 * PURGE_RETRY_BASE_MS);
    expect(await runStoragePurgeSweep()).toEqual({ state: "ran", passes: 1, done: 1, failed: 0 });
    expect(store.keys()).toEqual([]);
    expect(pending()).toEqual([]);
  });

  it("does not start a second sweep while one is running", async () => {
    await put("user-1");
    await purgeUserObjects("user-1");
    clock(LATE_UPLOAD_GRACE_MS + 1);
    let release: () => void = () => {};
    vi.spyOn(store, "deleteByPrefix").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ deleted: 0, more: false });
        }),
    );
    const first = runStoragePurgeSweep();
    await vi.waitFor(() => expect(store.deleteByPrefix).toHaveBeenCalled());
    expect(await runStoragePurgeSweep()).toEqual({ state: "busy", passes: 0, done: 0, failed: 0 });
    release();
    expect((await first).done).toBe(1);
  });
});

describe("purges that cannot run are reported, once per process, by count", () => {
  async function pendingFor(...userIds: string[]): Promise<void> {
    for (const userId of userIds) await markPurgePending(userId, new Date());
  }

  it("object storage off with pending purges: one warning and one Sentry event, no ids", async () => {
    await pendingFor("user-1", "user-2");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("OBJECT_STORAGE_ENABLED", "false");
    await runStoragePurgeSweep();
    await runStoragePurgeSweep();
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(captureError.mock.calls[0]?.[1]).toEqual({
      tags: { scope: "storage.purge.stalled", reason: "object-storage-off" },
      extra: { pending: 2 },
    });
    const output = warn.mock.calls.flat().join(" ");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(output).toContain("2 account purges");
    expect(output).not.toContain("user-1");
  });

  it("at boot with background work disabled", async () => {
    await pendingFor("user-1");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await checkStoragePurgesAtStartup({ backgroundDisabled: true });
    expect(captureError.mock.calls[0]?.[1]).toEqual({
      tags: { scope: "storage.purge.stalled", reason: "background-disabled" },
      extra: { pending: 1 },
    });
  });

  it("at boot with object storage off", async () => {
    await pendingFor("user-1");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("OBJECT_STORAGE_ENABLED", "false");
    await checkStoragePurgesAtStartup({ backgroundDisabled: false });
    expect(captureError.mock.calls[0]?.[1]).toMatchObject({
      tags: { reason: "object-storage-off" },
    });
  });

  it("says nothing when the sweep can run, or when nothing is pending", async () => {
    await pendingFor("user-1");
    await checkStoragePurgesAtStartup({ backgroundDisabled: false });
    expect(db.reads).toEqual([]);
    db.tables.storagePurge = [];
    vi.stubEnv("OBJECT_STORAGE_ENABLED", "false");
    await checkStoragePurgesAtStartup({ backgroundDisabled: true });
    expect(captureError).not.toHaveBeenCalled();
  });
});

describe("the scheduler", () => {
  it("runs the first sweep after the boot delay, then every interval, once however often it is started", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "setInterval", "clearTimeout", "clearInterval"],
      now: T0,
    });
    await put("user-1");
    await purgeUserObjects("user-1");
    await put("user-1"); // a late object
    const duePurgesSpy = vi.spyOn(await import("../storage/purge-queue.js"), "duePurges");
    startStoragePurgeScheduler();
    startStoragePurgeScheduler();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    // Inside the grace: the first sweep ran and found nothing due.
    expect(store.keys()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(PURGE_SWEEP_INTERVAL_MS);
    expect(store.keys()).toEqual([]);
    expect(pending()).toEqual([]);
    expect(duePurgesSpy.mock.calls.length).toBe(2);
    stopStoragePurgeScheduler();
    await vi.advanceTimersByTimeAsync(3 * PURGE_SWEEP_INTERVAL_MS);
    expect(duePurgesSpy.mock.calls.length).toBe(2);
  });

  it("a sweep that throws is reported and records no heartbeat", async () => {
    resetSchedulerHeartbeats();
    startStoragePurgeScheduler();
    const before = getSchedulerHealth().schedulers.find(
      (s) => s.name === "storage-purge",
    )?.lastSeenAt;
    clock(60_000);
    dbHolder.current = {
      ...db,
      model: () => {
        throw new Error("database is down");
      },
    };
    await storagePurgeTick();
    expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { scope: "storage.purge.sweep" },
    });
    const after = getSchedulerHealth().schedulers.find(
      (s) => s.name === "storage-purge",
    )?.lastSeenAt;
    expect(after).toBe(before);
    dbHolder.current = db;
    await storagePurgeTick();
    expect(
      getSchedulerHealth().schedulers.find((s) => s.name === "storage-purge")?.lastSeenAt,
    ).toBe(T0 + 60_000);
  });

  it("registers its heartbeat at the sweep interval and stops cleanly", () => {
    resetSchedulerHeartbeats();
    startStoragePurgeScheduler();
    const entry = getSchedulerHealth().schedulers.find((s) => s.name === "storage-purge");
    expect(entry).toMatchObject({ intervalMs: PURGE_SWEEP_INTERVAL_MS });
    expect(PURGE_SWEEP_INTERVAL_MS).toBe(PURGE_RETRY_BASE_MS);
    stopStoragePurgeScheduler();
  });

  it("one sweep fits inside its interval even when every pass runs to its deadline", () => {
    expect(PURGE_SWEEP_BATCH * PURGE_DEADLINE_MS).toBeLessThan(PURGE_SWEEP_INTERVAL_MS / 2);
  });
});
