/**
 * Both deletion paths remove the user's stored objects BEFORE the database rows
 * and stop when they cannot (step D1 of docs/providers/unified-platform-plan.md).
 * Once the rows are gone nothing else names the objects, so a deletion that
 * reported success while the bucket was down would strand files for good.
 */

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ order: [] as string[] }));

const prisma = vi.hoisted(() => ({
  $transaction: vi.fn(),
  llmUsageLog: { deleteMany: vi.fn((arg: unknown) => ({ op: "llmUsageLog.deleteMany", arg })) },
  user: {
    delete: vi.fn((arg: unknown) => ({ op: "user.delete", arg })),
    findUnique: vi.fn(async () => ({ email: "Ann@Example.com" })),
  },
  waitlist: { deleteMany: vi.fn((arg: unknown) => ({ op: "waitlist.deleteMany", arg })) },
}));
vi.mock("../db.js", () => ({
  prisma,
  db: prisma,
  INTERACTIVE_TX_OPTIONS: { maxWait: 10_000, timeout: 15_000 },
}));

const purgeUserObjects = vi.hoisted(() => vi.fn());
vi.mock("../storage/runtime.js", () => ({ purgeUserObjects }));

const purgeUserData = vi.hoisted(() => vi.fn());
const revokeUserAccess = vi.hoisted(() => vi.fn());
vi.mock("../purge-user-data.js", () => ({ purgeUserData, revokeUserAccess }));

const captureError = vi.hoisted(() => vi.fn());
vi.mock("../sentry.js", () => ({ captureError }));

import { deleteUserAndAllData, finishDataWipe, purgeAllUserData } from "../user-deletion.js";

const STAMPED = {
  purgedAt: new Date("2026-10-19T03:00:00Z"),
  fenceUntil: new Date("2026-10-19T03:05:00Z"),
};
const TX = {
  marker: "tx",
  $queryRaw: vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    calls.order.push(strings.join("?").includes("FOR UPDATE") ? "lock" : "stamp");
    return [STAMPED];
  }),
  dataWipe: {
    upsert: vi.fn(async () => {
      calls.order.push("record");
      return {};
    }),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  calls.order.length = 0;
  TX.$queryRaw.mockClear();
  TX.dataWipe.upsert.mockClear();
  prisma.$transaction.mockReset().mockImplementation(async (work: unknown) => {
    calls.order.push("database");
    return typeof work === "function" ? await work(TX) : [];
  });
  purgeUserObjects.mockReset().mockImplementation(() => {
    calls.order.push("storage");
    return Promise.resolve({ skipped: false, deleted: 2 });
  });
  purgeUserData.mockReset().mockImplementation(() => {
    calls.order.push("rows");
    return Promise.resolve();
  });
  revokeUserAccess.mockReset().mockImplementation(() => {
    calls.order.push("access");
    return Promise.resolve();
  });
});

describe("deleteUserAndAllData (account deletion)", () => {
  it("deletes the user's objects first, then the account", async () => {
    await deleteUserAndAllData("user-1");
    expect(calls.order).toEqual(["storage", "database"]);
    expect(purgeUserObjects).toHaveBeenCalledWith("user-1");
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: "user-1" } });
    expect(prisma.llmUsageLog.deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
  });

  it("removes the waitlist entry for the account's address in the same transaction", async () => {
    await deleteUserAndAllData("user-1");

    // Exact matches only: an insensitive filter is ILIKE, where "_" in an
    // address is a wildcard that could match someone else's entry.
    expect(prisma.waitlist.deleteMany).toHaveBeenCalledWith({
      where: { email: { in: ["Ann@Example.com", "ann@example.com"] } },
    });
    const ops = (prisma.$transaction.mock.calls[0]?.[0] as Array<{ op: string }>).map((o) => o.op);
    expect(ops).toEqual(["llmUsageLog.deleteMany", "waitlist.deleteMany", "user.delete"]);
  });

  it("keeps the account when the objects could not be deleted", async () => {
    purgeUserObjects.mockRejectedValue(new Error("bucket is down"));
    await expect(deleteUserAndAllData("user-1")).rejects.toThrow("bucket is down");
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });
});

describe("purgeAllUserData (data wipe that keeps the account)", () => {
  it("records the wipe and cuts off access under the account lock, then purges once", async () => {
    await expect(purgeAllUserData("user-1")).resolves.toBe("purged");
    // The first transaction holds the account row FOR UPDATE: inserts in flight
    // commit before it and are purged; later ones see the record and are
    // rejected by the fence's trigger. So one purge is enough.
    expect(calls.order).toEqual([
      "storage",
      "database",
      "lock",
      "record",
      "access",
      "database",
      "rows",
      "stamp",
    ]);
    expect(revokeUserAccess).toHaveBeenCalledWith(TX, "user-1");
    expect(purgeUserData).toHaveBeenCalledWith(TX, "user-1");
  });

  it("locks the account row and records a pending wipe, clearing an older one", async () => {
    await purgeAllUserData("user-1");
    const [lockSql, lockedId] = TX.$queryRaw.mock.calls[0] ?? [];
    expect((lockSql as TemplateStringsArray).join("?")).toBe(
      'SELECT 1 FROM "User" WHERE "id" = ? FOR UPDATE',
    );
    expect(lockedId).toBe("user-1");
    const upsert = TX.dataWipe.upsert.mock.calls[0]?.[0] as unknown as {
      where: unknown;
      create: { requestedAt: Date };
      update: Record<string, unknown>;
    };
    expect(upsert.where).toEqual({ userId: "user-1" });
    expect(upsert.create.requestedAt).toBeInstanceOf(Date);
    expect(upsert.update).toMatchObject({ purgedAt: null, fenceUntil: null, attempts: 0 });
  });

  it("stamps the wipe purged with the fence window, inside the purge transaction", async () => {
    await purgeAllUserData("user-1");
    const [stampSql, ...values] = TX.$queryRaw.mock.calls[1] ?? [];
    const sql = (stampSql as TemplateStringsArray).join("?");
    expect(sql).toContain('UPDATE "DataWipe"');
    expect(sql).toContain("\"purgedAt\" = (now() AT TIME ZONE 'UTC')");
    expect(values).toEqual([300, "user-1"]);
  });

  it("keeps the 60 second transaction budget for both transactions", async () => {
    await purgeAllUserData("user-1");
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    for (const call of prisma.$transaction.mock.calls) {
      expect(call[1]).toEqual({ maxWait: 10_000, timeout: 60_000 });
    }
  });

  it("deletes no row when the wipe could not be recorded", async () => {
    prisma.$transaction.mockRejectedValueOnce(new Error("pool exhausted"));
    await expect(purgeAllUserData("user-1")).rejects.toThrow("pool exhausted");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(purgeUserData).not.toHaveBeenCalled();
  });

  it("answers pending, not an error, when the purge fails after access was cut off", async () => {
    const purgeError = new Error("timed out");
    prisma.$transaction
      .mockImplementationOnce(async (work: unknown) => (work as (tx: unknown) => unknown)(TX))
      .mockRejectedValueOnce(purgeError);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    // The record stays pending: the fence keeps rejecting inserts and the
    // data-wipe sweep finishes the purge.
    await expect(purgeAllUserData("user-1")).resolves.toBe("pending");
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("user-1"), purgeError);
    expect(captureError).toHaveBeenCalledWith(purgeError, {
      tags: { scope: "user-deletion.purge", userId: "user-1" },
    });
    expect(calls.order).not.toContain("stamp");
    logged.mockRestore();
  });

  it("keeps every row when the objects could not be deleted", async () => {
    purgeUserObjects.mockRejectedValue(new Error("bucket is down"));
    await expect(purgeAllUserData("user-1")).rejects.toThrow("bucket is down");
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(purgeUserData).not.toHaveBeenCalled();
  });
});

describe("finishDataWipe (the sweep's retry)", () => {
  it("purges and stamps in one transaction, without touching the record's lock", async () => {
    await finishDataWipe("user-1");
    expect(calls.order).toEqual(["database", "rows", "stamp"]);
  });
});

describe("the routes use the shared deletion functions", () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  it("DELETE /api/user/me/data goes through purgeAllUserData", () => {
    const index = source("../index.ts");
    const handler = index.slice(index.indexOf('app.delete("/api/user/me/data"'));
    expect(handler.slice(0, handler.indexOf("\n});"))).toContain("await purgeAllUserData(userId)");
    // 202 when access is gone but the purge has not committed: the sweep finishes it.
    expect(handler.slice(0, handler.indexOf("\n});"))).toMatch(
      /outcome === "purged"\s*\?\s*reply\.code\(204\)\.send\(\)\s*:\s*reply\.code\(202\)\.send\(\{ status: "pending" \}\)/,
    );
    // The row purge must not be reachable from the entry point without the
    // object purge in front of it.
    expect(index).not.toMatch(/\bpurgeUserData\b/);
  });

  it("no route deletes a user row on its own", () => {
    for (const path of ["../routes/auth.ts", "../routes/admin.ts", "../index.ts"]) {
      expect(source(path)).not.toMatch(/\.user\.delete\(/);
    }
  });
});
