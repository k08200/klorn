import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());
vi.mock("../db.js", () => ({ prisma: { dataWipe: { findMany, update } } }));
const finishDataWipe = vi.hoisted(() => vi.fn());
vi.mock("../user-deletion.js", () => ({ finishDataWipe }));
const captureError = vi.hoisted(() => vi.fn());
vi.mock("../sentry.js", () => ({ captureError }));

import { runDataWipeSweep } from "../privacy/data-wipe-sweep.js";

const NOW = new Date("2026-10-19T04:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue({});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("runDataWipeSweep", () => {
  it("asks for pending wipes past the grace, fewest attempts first", async () => {
    findMany.mockResolvedValue([]);
    await runDataWipeSweep(NOW);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { purgedAt: null, requestedAt: { lt: minutesAgo(2) } },
        orderBy: [{ attempts: "asc" }, { requestedAt: "asc" }],
      }),
    );
  });

  it("finishes each pending wipe and counts a failure without stopping", async () => {
    findMany.mockResolvedValue([
      { userId: "u1", requestedAt: minutesAgo(5) },
      { userId: "u2", requestedAt: minutesAgo(5) },
    ]);
    finishDataWipe.mockRejectedValueOnce(new Error("timed out")).mockResolvedValueOnce("purged");

    await expect(runDataWipeSweep(NOW)).resolves.toEqual({ finished: 1, failed: 1 });
    expect(finishDataWipe).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith({
      where: { userId: "u1" },
      data: { attempts: { increment: 1 } },
    });
    expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { scope: "data-wipe.sweep", userId: "u1" },
    });
  });

  it("reports a wipe pending for over 30 minutes as stuck", async () => {
    findMany.mockResolvedValue([{ userId: "u1", requestedAt: minutesAgo(31) }]);
    finishDataWipe.mockRejectedValue(new Error("timed out"));
    await runDataWipeSweep(NOW);
    expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { scope: "data-wipe.stuck", userId: "u1" },
    });
  });

  it("does not report a younger failure as stuck", async () => {
    findMany.mockResolvedValue([{ userId: "u1", requestedAt: minutesAgo(10) }]);
    finishDataWipe.mockRejectedValue(new Error("timed out"));
    await runDataWipeSweep(NOW);
    const scopes = captureError.mock.calls.map(
      (c) => (c[1] as { tags: { scope: string } }).tags.scope,
    );
    expect(scopes).toEqual(["data-wipe.sweep"]);
  });
});
