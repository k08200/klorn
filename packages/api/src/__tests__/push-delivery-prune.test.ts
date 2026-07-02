/**
 * pruneOldPushDeliveryLogs — batched retention delete.
 *
 * Prisma has no LIMIT on deleteMany, so the pruner pages ids via findMany and
 * deletes them by id-set. DB wiring is mocked at the db.js boundary (repo
 * convention); we assert the batching loop, the id-set delete, and the total.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findManyMock = vi.hoisted(() => vi.fn());
const deleteManyMock = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({
  prisma: {
    pushDeliveryLog: { findMany: findManyMock, deleteMany: deleteManyMock },
  },
  db: {},
}));

import { pruneOldPushDeliveryLogs } from "../push-delivery.js";

beforeEach(() => {
  findManyMock.mockReset();
  deleteManyMock.mockReset();
  deleteManyMock.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => ({
    count: where.id.in.length,
  }));
});

describe("pruneOldPushDeliveryLogs", () => {
  it("deletes rows in batches by id and returns the total deleted", async () => {
    findManyMock
      .mockResolvedValueOnce([{ id: "a" }, { id: "b" }])
      .mockResolvedValueOnce([{ id: "c" }])
      .mockResolvedValueOnce([]);

    const total = await pruneOldPushDeliveryLogs(90, 2);

    expect(total).toBe(3);
    // Three finds: full batch, partial batch, empty page (stop).
    expect(findManyMock).toHaveBeenCalledTimes(3);
    expect(deleteManyMock).toHaveBeenCalledTimes(2);
    expect(deleteManyMock.mock.calls[0][0]).toEqual({ where: { id: { in: ["a", "b"] } } });
    expect(deleteManyMock.mock.calls[1][0]).toEqual({ where: { id: { in: ["c"] } } });
  });

  it("selects only ids older than the cutoff, capped at batchSize", async () => {
    findManyMock.mockResolvedValueOnce([]);

    const before = Date.now();
    await pruneOldPushDeliveryLogs(30, 5000);
    const after = Date.now();

    const args = findManyMock.mock.calls[0][0];
    expect(args.select).toEqual({ id: true });
    expect(args.take).toBe(5000);
    const cutoff = args.where.createdAt.lt as Date;
    // cutoff ≈ now − 30 days.
    const expectedLow = before - 30 * 24 * 60 * 60 * 1000;
    const expectedHigh = after - 30 * 24 * 60 * 60 * 1000;
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(expectedLow);
    expect(cutoff.getTime()).toBeLessThanOrEqual(expectedHigh);
  });

  it("returns 0 and never deletes when the first page is empty", async () => {
    findManyMock.mockResolvedValueOnce([]);

    const total = await pruneOldPushDeliveryLogs();

    expect(total).toBe(0);
    expect(deleteManyMock).not.toHaveBeenCalled();
  });
});
