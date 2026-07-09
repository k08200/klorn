import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
const update = vi.fn();
const recordFeedback = vi.fn();

vi.mock("../db.js", () => ({
  prisma: {
    attentionItem: {
      findFirst: (args: unknown) => findFirst(args),
      update: (args: unknown) => update(args),
    },
  },
}));
vi.mock("../feedback.js", () => ({ recordFeedback: (args: unknown) => recordFeedback(args) }));

import { dismissAttentionItem } from "../attention-dismiss.js";

describe("dismissAttentionItem", () => {
  beforeEach(() => {
    findFirst.mockReset();
    update.mockReset();
    recordFeedback.mockReset();
  });

  it("returns not_found and never mutates when the item isn't the user's", async () => {
    findFirst.mockResolvedValue(null);

    const res = await dismissAttentionItem("u1", "i1");

    expect(res).toEqual({ ok: false, reason: "not_found" });
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "i1", userId: "u1" },
      select: { id: true, source: true, sourceId: true },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("marks an owned item DISMISSED with a resolvedAt stamp", async () => {
    findFirst.mockResolvedValue({ id: "i1" });
    update.mockResolvedValue({});

    const res = await dismissAttentionItem("u1", "i1");

    expect(res).toEqual({ ok: true });
    const call = update.mock.calls[0][0] as {
      where: { id: string };
      data: { status: string; resolvedAt: Date };
    };
    expect(call.where).toEqual({ id: "i1" });
    expect(call.data.status).toBe("DISMISSED");
    expect(call.data.resolvedAt).toBeInstanceOf(Date);
  });

  it("records a DISMISSED learning signal for the dismissed item", async () => {
    findFirst.mockResolvedValue({ id: "i1" });
    update.mockResolvedValue({});

    await dismissAttentionItem("u1", "i1");

    expect(recordFeedback).toHaveBeenCalledTimes(1);
    expect(recordFeedback.mock.calls[0][0]).toMatchObject({
      userId: "u1",
      source: "ATTENTION_ITEM",
      sourceId: "i1",
      signal: "DISMISSED",
    });
  });

  it("does not record feedback when the item isn't the user's", async () => {
    findFirst.mockResolvedValue(null);
    await dismissAttentionItem("u1", "i1");
    expect(recordFeedback).not.toHaveBeenCalled();
  });
});
