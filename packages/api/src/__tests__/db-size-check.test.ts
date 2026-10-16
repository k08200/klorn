import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The database-size alarm: one pg_database_size() read per hour, compared with
// DB_SIZE_LIMIT_MB. Supabase's free plan goes read-only above 500 MB, and on
// 2026-10-16 production was at 446 MB with nothing watching.

const MIB = 1024 * 1024;

const state = vi.hoisted(() => ({
  bytes: 0n as bigint,
  queryError: null as unknown,
  queries: [] as string[],
  delivery: { recipients: 1, created: 1 },
  deliveryError: null as unknown,
  notifications: [] as Array<{ dedupeKey: string; title: string; message: string }>,
  captured: [] as Array<{ err: unknown; ctx: unknown }>,
}));

vi.mock("../db.js", () => ({
  prisma: {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      state.queries.push(strings.join("?"));
      if (state.queryError) throw state.queryError;
      return [{ bytes: state.bytes }];
    }),
  },
}));
vi.mock("../ops/admin-ops-notification.js", () => ({
  createAdminOpsNotifications: vi.fn(
    async (input: { dedupeKey: string; title: string; message: string }) => {
      if (state.deliveryError) throw state.deliveryError;
      state.notifications.push(input);
      return state.delivery;
    },
  ),
}));
vi.mock("../sentry.js", () => ({
  captureError: (err: unknown, ctx: unknown) => state.captured.push({ err, ctx }),
}));

import {
  __resetDbSizeCheck,
  classifyDbSize,
  resolveDbSizeLimitBytes,
  runDbSizeCheck,
} from "../ops/db-size-check.js";

const NOW = Date.parse("2026-10-16T12:00:00Z");

describe("database size alarm", () => {
  beforeEach(() => {
    state.bytes = 0n;
    state.queryError = null;
    state.queries = [];
    state.delivery = { recipients: 1, created: 1 };
    state.deliveryError = null;
    state.notifications = [];
    state.captured = [];
    __resetDbSizeCheck();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.DB_SIZE_LIMIT_MB;
  });

  it("defaults the limit to the free plan's 500 MB and honours a valid override", () => {
    expect(resolveDbSizeLimitBytes({})).toBe(500 * MIB);
    expect(resolveDbSizeLimitBytes({ DB_SIZE_LIMIT_MB: "8192" })).toBe(8192 * MIB);
    for (const bad of ["", "abc", "0", "-5", "Infinity"]) {
      expect(resolveDbSizeLimitBytes({ DB_SIZE_LIMIT_MB: bad })).toBe(500 * MIB);
    }
  });

  it("warns from 80% and goes critical from 90%", () => {
    const limit = 1000;
    expect(classifyDbSize(799, limit)).toBe("ok");
    expect(classifyDbSize(800, limit)).toBe("warn");
    expect(classifyDbSize(899, limit)).toBe("warn");
    expect(classifyDbSize(900, limit)).toBe("critical");
    expect(classifyDbSize(1200, limit)).toBe("critical");
  });

  it("reads only the database size and stays quiet below 80%", async () => {
    state.bytes = BigInt(300 * MIB);

    const status = await runDbSizeCheck(NOW);

    expect(status).toMatchObject({ level: "ok", bytes: 300 * MIB, limitBytes: 500 * MIB });
    expect(state.queries).toEqual([
      expect.stringContaining("pg_database_size(current_database())"),
    ]);
    expect(state.notifications).toEqual([]);
    expect(state.captured).toEqual([]);
  });

  it("sends one deduped ops notification at the warn level, without Sentry", async () => {
    state.bytes = BigInt(446 * MIB);

    const status = await runDbSizeCheck(NOW);

    expect(status.level).toBe("warn");
    expect(state.notifications).toEqual([
      expect.objectContaining({
        dedupeKey: "db-size:warn:2026-10-16",
        message: expect.stringMatching(/89%.*500 MB/),
      }),
    ]);
    expect(state.notifications[0]?.message).toContain("read-only");
    expect(state.captured).toEqual([]);
  });

  it("is loud at the critical level only when this call created the alert", async () => {
    state.bytes = BigInt(470 * MIB);

    await runDbSizeCheck(NOW);
    expect(state.notifications[0]?.dedupeKey).toBe("db-size:critical:2026-10-16");
    expect(state.captured).toHaveLength(1);
    expect(console.error).toHaveBeenCalledTimes(1);

    // Same day, another instance already delivered it: no second page.
    state.delivery = { recipients: 1, created: 0 };
    await runDbSizeCheck(NOW + 60 * 60 * 1000);
    expect(state.captured).toHaveLength(1);
  });

  it("is loud once per day when no admin can receive the alert", async () => {
    state.bytes = BigInt(470 * MIB);
    state.delivery = { recipients: 0, created: 0 };

    await runDbSizeCheck(NOW);
    await runDbSizeCheck(NOW + 60 * 60 * 1000);
    expect(state.captured).toHaveLength(1);

    await runDbSizeCheck(NOW + 24 * 60 * 60 * 1000);
    expect(state.captured).toHaveLength(2);
  });

  it("still pages at critical when the notification write fails", async () => {
    state.bytes = BigInt(470 * MIB);
    state.deliveryError = new Error("db write failed");

    await expect(runDbSizeCheck(NOW)).resolves.toMatchObject({ level: "critical" });
    expect(state.captured).toHaveLength(1);
  });

  it("uses DB_SIZE_LIMIT_MB from the environment", async () => {
    process.env.DB_SIZE_LIMIT_MB = "8192";
    state.bytes = BigInt(446 * MIB);

    const status = await runDbSizeCheck(NOW);

    expect(status).toMatchObject({ level: "ok", limitBytes: 8192 * MIB });
    expect(state.notifications).toEqual([]);
  });

  it("lets a failed size read reach the caller", async () => {
    state.queryError = new Error("connection refused");

    await expect(runDbSizeCheck(NOW)).rejects.toThrow("connection refused");
    expect(state.notifications).toEqual([]);
  });
});
