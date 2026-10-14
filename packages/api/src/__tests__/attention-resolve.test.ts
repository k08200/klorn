import { beforeEach, describe, expect, it, vi } from "vitest";

const updateMany = vi.hoisted(() => vi.fn(async () => ({ count: 1 })));

vi.mock("../db.js", () => ({ prisma: { attentionItem: { updateMany } } }));

import { resolveAttentionForEmails } from "../judge/attention-resolve.js";

beforeEach(() => {
  updateMany.mockClear();
});

describe("resolveAttentionForEmails", () => {
  it("resolves only the user's OPEN/SNOOZED email items for exactly those ids", async () => {
    await resolveAttentionForEmails("u1", ["e1", "e2"]);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        userId: "u1",
        source: "EMAIL",
        sourceId: { in: ["e1", "e2"] },
        status: { in: ["OPEN", "SNOOZED"] },
      },
      data: { status: "RESOLVED", resolvedAt: expect.any(Date) },
    });
  });

  it("does nothing for an empty list, and chunks a huge one under the bind-param cap", async () => {
    await resolveAttentionForEmails("u1", []);
    expect(updateMany).not.toHaveBeenCalled();
    const ids = Array.from({ length: 10_001 }, (_, i) => `e${i}`);
    await resolveAttentionForEmails("u1", ids);
    expect(updateMany).toHaveBeenCalledTimes(2);
    const [first, second] = updateMany.mock.calls.map(
      (call: unknown[]) =>
        (call[0] as { where: { sourceId: { in: string[] } } }).where.sourceId.in.length,
    );
    expect([first, second]).toEqual([10_000, 1]);
  });
});
