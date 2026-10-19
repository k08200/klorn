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
vi.mock("../purge-user-data.js", () => ({ purgeUserData }));

import { deleteUserAndAllData, purgeAllUserData } from "../user-deletion.js";

const TX = { marker: "tx" };

beforeEach(() => {
  vi.clearAllMocks();
  calls.order.length = 0;
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
  it("deletes the user's objects first, then every row, then sweeps once more", async () => {
    await purgeAllUserData("user-1");
    // The second pass runs after the first transaction committed: a sync that
    // still saw the user's tokens can have inserted rows after their
    // deleteMany ran inside the first one.
    expect(calls.order).toEqual(["storage", "database", "rows", "database", "rows"]);
    expect(purgeUserObjects).toHaveBeenCalledWith("user-1");
    expect(purgeUserData).toHaveBeenCalledWith(TX, "user-1");
  });

  it("keeps the 60 second transaction budget of the purge, for both passes", async () => {
    await purgeAllUserData("user-1");
    expect(prisma.$transaction.mock.calls[0]?.[1]).toEqual({ maxWait: 10_000, timeout: 60_000 });
    expect(prisma.$transaction.mock.calls[1]?.[1]).toEqual({ maxWait: 10_000, timeout: 60_000 });
  });

  it("does not sweep again when the first pass failed", async () => {
    prisma.$transaction.mockRejectedValueOnce(new Error("timed out"));
    await expect(purgeAllUserData("user-1")).rejects.toThrow("timed out");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("keeps every row when the objects could not be deleted", async () => {
    purgeUserObjects.mockRejectedValue(new Error("bucket is down"));
    await expect(purgeAllUserData("user-1")).rejects.toThrow("bucket is down");
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(purgeUserData).not.toHaveBeenCalled();
  });
});

describe("the routes use the shared deletion functions", () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  it("DELETE /api/user/me/data goes through purgeAllUserData", () => {
    const index = source("../index.ts");
    const handler = index.slice(index.indexOf('app.delete("/api/user/me/data"'));
    expect(handler.slice(0, handler.indexOf("\n});"))).toContain("await purgeAllUserData(userId)");
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
