import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
const update = vi.fn();

vi.mock("../db.js", () => ({
  prisma: {
    attentionItem: {
      findFirst: (args: unknown) => findFirst(args),
      update: (args: unknown) => update(args),
    },
  },
}));

import { snoozeAttentionItem } from "../judge/attention-snooze.js";

describe("snoozeAttentionItem", () => {
  beforeEach(() => {
    findFirst.mockReset();
    update.mockReset();
  });

  it("returns not_found and never mutates when the item isn't the user's", async () => {
    findFirst.mockResolvedValue(null);

    const res = await snoozeAttentionItem("u1", "i1", new Date(Date.now() + 3_600_000));

    expect(res).toEqual({ ok: false, reason: "not_found" });
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "i1", userId: "u1" },
      select: { id: true },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("snoozes an owned item to SNOOZED with cleared amplification", async () => {
    findFirst.mockResolvedValue({ id: "i1" });
    update.mockResolvedValue({});
    const until = new Date(Date.now() + 3_600_000);

    const res = await snoozeAttentionItem("u1", "i1", until);

    expect(res).toEqual({ ok: true });
    expect(update).toHaveBeenCalledWith({
      where: { id: "i1" },
      data: { status: "SNOOZED", snoozedUntil: until, lastAmplifiedAt: null },
    });
  });
});
