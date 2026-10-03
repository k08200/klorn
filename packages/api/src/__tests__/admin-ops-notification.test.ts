/**
 * The shared ops-alert recipient path: one deduped `ops` Notification per
 * ADMIN user. Used by the cost-cap trip alert and the judge fallback alarm.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const created = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const behavior = vi.hoisted(() => ({
  failWith: null as unknown,
  admins: [] as Array<{ id: string }>,
}));

vi.mock("../db.js", () => ({
  prisma: {
    user: { findMany: vi.fn(async () => behavior.admins) },
    notification: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        if (behavior.failWith) throw behavior.failWith;
        created.push(args.data);
        return { id: `n-${created.length}` };
      }),
    },
  },
}));

import { createAdminOpsNotifications } from "../ops/admin-ops-notification.js";

afterEach(() => {
  created.length = 0;
  behavior.failWith = null;
  behavior.admins = [];
});

describe("createAdminOpsNotifications", () => {
  it("creates one ops Notification per ADMIN with the shared dedupeKey", async () => {
    behavior.admins = [{ id: "a1" }, { id: "a2" }];
    const delivery = await createAdminOpsNotifications({
      dedupeKey: "judge-fallback:2026-10-02T13:00:00.000Z",
      title: "LLM judge failing",
      message: "m",
    });
    expect(delivery).toEqual({ recipients: 2, created: 2 });
    expect(created).toEqual([
      {
        userId: "a1",
        type: "ops",
        dedupeKey: "judge-fallback:2026-10-02T13:00:00.000Z",
        title: "LLM judge failing",
        message: "m",
      },
      {
        userId: "a2",
        type: "ops",
        dedupeKey: "judge-fallback:2026-10-02T13:00:00.000Z",
        title: "LLM judge failing",
        message: "m",
      },
    ]);
  });

  it("treats a P2002 (another instance won the dedupe race) as already sent", async () => {
    behavior.admins = [{ id: "a1" }];
    behavior.failWith = Object.assign(new Error("unique"), { code: "P2002" });
    await expect(
      createAdminOpsNotifications({ dedupeKey: "k", title: "t", message: "m" }),
    ).resolves.toEqual({ recipients: 1, created: 0 });
  });

  it("rethrows any other write failure so the caller can log it", async () => {
    behavior.admins = [{ id: "a1" }];
    behavior.failWith = new Error("db down");
    await expect(
      createAdminOpsNotifications({ dedupeKey: "k", title: "t", message: "m" }),
    ).rejects.toThrow("db down");
  });

  it("is a no-op with no ADMIN users", async () => {
    await expect(
      createAdminOpsNotifications({ dedupeKey: "k", title: "t", message: "m" }),
    ).resolves.toEqual({ recipients: 0, created: 0 });
    expect(created).toEqual([]);
  });
});
