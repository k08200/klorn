/**
 * D3: the durable pending-purge record (storage/purge-queue.ts) over a fake
 * database that evaluates each `where`. A record is written when a deletion
 * starts, survives the account row, and is finished only by a pass that started
 * after the late-upload grace and emptied the prefix.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => dbHolder.current as FakeDb);
  return { prisma, db: prisma };
});

import {
  duePurges,
  isStoragePurgePending,
  LATE_UPLOAD_GRACE_MS,
  markPurgePending,
  PURGE_RETRY_BASE_MS,
  PURGE_RETRY_MAX_MS,
  purgeRetryDelayMs,
  recordPurgePassFailed,
  recordPurgePassSucceeded,
} from "../storage/purge-queue.js";

const T0 = Date.parse("2026-10-14T00:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms);

let db: FakeDb;
const rows = () => db.tables.storagePurge ?? [];

beforeEach(() => {
  db = createFakeDb({ storagePurge: [] });
  dbHolder.current = db;
});

describe("markPurgePending", () => {
  it("records the user as purging, due at once", async () => {
    await markPurgePending("user-1", at(0));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      userId: "user-1",
      requestedAt: at(0),
      attempts: 0,
      lastError: null,
      nextAttemptAt: at(0),
    });
    expect(await isStoragePurgePending("user-1")).toBe(true);
    expect(await isStoragePurgePending("user-2")).toBe(false);
  });

  it("a second deletion restarts the grace and keeps the failure history", async () => {
    await markPurgePending("user-1", at(0));
    await recordPurgePassFailed("user-1", "unreachable", at(1_000));
    await markPurgePending("user-1", at(5_000));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      requestedAt: at(5_000),
      nextAttemptAt: at(5_000),
      attempts: 1,
      lastError: "unreachable",
    });
  });
});

describe("recordPurgePassSucceeded", () => {
  it("keeps the record while late uploads may still land, due again when the grace ends", async () => {
    await markPurgePending("user-1", at(0));
    expect(await recordPurgePassSucceeded("user-1", at(10))).toBe("settling");
    expect(rows()[0]).toMatchObject({
      nextAttemptAt: at(10 + LATE_UPLOAD_GRACE_MS),
      lastError: null,
    });
    expect(await isStoragePurgePending("user-1")).toBe(true);
  });

  it("finishes the record for a pass that started after the grace", async () => {
    await markPurgePending("user-1", at(0));
    expect(await recordPurgePassSucceeded("user-1", at(LATE_UPLOAD_GRACE_MS))).toBe("done");
    expect(rows()).toEqual([]);
    expect(await isStoragePurgePending("user-1")).toBe(false);
  });

  it("does not finish a record a newer deletion refreshed while the pass ran", async () => {
    await markPurgePending("user-1", at(0));
    await markPurgePending("user-1", at(LATE_UPLOAD_GRACE_MS));
    // This pass started after the FIRST request's grace, not after the second's.
    expect(await recordPurgePassSucceeded("user-1", at(LATE_UPLOAD_GRACE_MS + 1))).toBe("settling");
    expect(await isStoragePurgePending("user-1")).toBe(true);
  });

  it("resets the failure count, so the stuck alert counts consecutive failures", async () => {
    await markPurgePending("user-1", at(0));
    await recordPurgePassFailed("user-1", "unreachable", at(1));
    await recordPurgePassFailed("user-1", "unreachable", at(2));
    await recordPurgePassSucceeded("user-1", at(3));
    expect(rows()[0]).toMatchObject({ attempts: 0, lastError: null });
    expect(await recordPurgePassFailed("user-1", "unreachable", at(4))).toBe(1);
  });

  it("answers done when the record is already gone", async () => {
    expect(await recordPurgePassSucceeded("user-1", at(LATE_UPLOAD_GRACE_MS))).toBe("done");
  });
});

describe("recordPurgePassFailed", () => {
  it("counts the attempt, keeps the code, and backs off", async () => {
    await markPurgePending("user-1", at(0));
    expect(await recordPurgePassFailed("user-1", "access-denied", at(100))).toBe(1);
    expect(rows()[0]).toMatchObject({
      attempts: 1,
      lastError: "access-denied",
      nextAttemptAt: at(100 + PURGE_RETRY_BASE_MS),
    });
    expect(await recordPurgePassFailed("user-1", "unreachable", at(200))).toBe(2);
    expect(rows()[0]).toMatchObject({
      attempts: 2,
      lastError: "unreachable",
      nextAttemptAt: at(200 + 2 * PURGE_RETRY_BASE_MS),
    });
  });

  it("the backoff doubles from the sweep interval and stops at a day", () => {
    expect(purgeRetryDelayMs(1)).toBe(PURGE_RETRY_BASE_MS);
    expect(purgeRetryDelayMs(2)).toBe(2 * PURGE_RETRY_BASE_MS);
    expect(purgeRetryDelayMs(4)).toBe(8 * PURGE_RETRY_BASE_MS);
    expect(purgeRetryDelayMs(50)).toBe(PURGE_RETRY_MAX_MS);
    expect(PURGE_RETRY_MAX_MS).toBe(24 * 60 * 60_000);
  });

  it("writes nothing when the record is already gone", async () => {
    expect(await recordPurgePassFailed("user-1", "unreachable", at(0))).toBe(0);
    expect(rows()).toEqual([]);
  });
});

describe("duePurges", () => {
  it("answers the due users, oldest first, at most the batch", async () => {
    await markPurgePending("user-late", at(3_000));
    await markPurgePending("user-early", at(1_000));
    await markPurgePending("user-future", at(9_000));
    expect(await duePurges(at(5_000), 10)).toEqual(["user-early", "user-late"]);
    expect(await duePurges(at(5_000), 1)).toEqual(["user-early"]);
  });
});
