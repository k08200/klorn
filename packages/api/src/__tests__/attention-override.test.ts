import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => {
  const prisma: {
    attentionItem: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    decisionLabel: { updateMany: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  } = {
    attentionItem: {
      findFirst: vi.fn(async () => ({ id: "item-1", source: "EMAIL", sourceId: "email-1" })),
      update: vi.fn(async () => ({})),
    },
    decisionLabel: {
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $transaction: vi.fn(),
  };
  // Interactive-transaction shim: run the callback with the mock itself as the
  // tx client, so tx.attentionItem / tx.decisionLabel resolve to the same spies
  // and a callback rejection rejects the whole transaction (as real Prisma does).
  prisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(prisma));
  return { prisma, db: prisma };
});

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import {
  confirmAttentionTier,
  findOpenEmailAttentionItemId,
  overrideAttentionTier,
} from "../attention-override.js";
import { prisma } from "../db.js";

type AttentionItemMock = {
  findFirst: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
const attentionItem = (prisma as unknown as { attentionItem: AttentionItemMock }).attentionItem;
const decisionLabel = (
  prisma as unknown as { decisionLabel: { updateMany: ReturnType<typeof vi.fn> } }
).decisionLabel;
const $transaction = (prisma as unknown as { $transaction: ReturnType<typeof vi.fn> }).$transaction;

beforeEach(() => {
  vi.clearAllMocks();
  attentionItem.findFirst.mockResolvedValue({ id: "item-1", source: "EMAIL", sourceId: "email-1" });
  decisionLabel.updateMany.mockResolvedValue({ count: 1 });
});

describe("overrideAttentionTier", () => {
  it("stamps the poc-judge ground-truth tierReason convention", async () => {
    const result = await overrideAttentionTier("user-1", "item-1", "QUEUE");
    expect(result).toEqual({ ok: true, tier: "QUEUE" });
    expect(attentionItem.update).toHaveBeenCalledWith({
      where: { id: "item-1" },
      data: {
        tier: "QUEUE",
        tierReason: "Manual override — user moved to QUEUE",
        isManualOverride: true,
      },
    });
  });

  it("is the only path that sets isManualOverride true (GHSA-cxc5-fmqv-pxv6)", async () => {
    // The ownership-checked human path is the sole legitimate writer of this
    // flag — judge-authored tierReason text must never be able to set it.
    await overrideAttentionTier("user-1", "item-1", "PUSH");
    const data = attentionItem.update.mock.calls[0][0].data;
    expect(data.isManualOverride).toBe(true);
  });

  it("checks ownership before mutating", async () => {
    await overrideAttentionTier("user-1", "item-1", "SILENT");
    expect(attentionItem.findFirst).toHaveBeenCalledWith({
      where: { id: "item-1", userId: "user-1" },
      select: { id: true, source: true, sourceId: true },
    });
  });

  it("stamps the decision ledger with the user's correction (OVERRIDE:<tier>)", async () => {
    await overrideAttentionTier("user-1", "item-1", "PUSH");
    expect(decisionLabel.updateMany).toHaveBeenCalledTimes(1);
    const args = decisionLabel.updateMany.mock.calls[0][0];
    expect(args.where).toEqual({
      userId: "user-1",
      source: "EMAIL",
      sourceId: "email-1",
      outcome: null,
    });
    expect(args.data.outcome).toBe("OVERRIDE:PUSH");
  });

  it("returns not_found for items the user does not own", async () => {
    attentionItem.findFirst.mockResolvedValueOnce(null);
    const result = await overrideAttentionTier("user-1", "other-users-item", "QUEUE");
    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(attentionItem.update).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });

  it("writes the visible tier and stamps the ledger in a single transaction", async () => {
    await overrideAttentionTier("user-1", "item-1", "QUEUE");
    // One transaction wraps both writes — no window where the tier is corrected
    // but the ground-truth ledger row is left unstamped.
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(attentionItem.update).toHaveBeenCalledTimes(1);
    expect(decisionLabel.updateMany).toHaveBeenCalledTimes(1);
  });

  it("propagates a ledger-stamp failure instead of silently losing the override", async () => {
    // A DB blip on the stamp must reject the whole override (rolling back the
    // tier write) rather than leaving a corrected tier with a lost ledger row.
    decisionLabel.updateMany.mockRejectedValueOnce(new Error("db blip"));
    await expect(overrideAttentionTier("user-1", "item-1", "PUSH")).rejects.toThrow("db blip");
  });
});

describe("confirmAttentionTier", () => {
  beforeEach(() => {
    // Confirm reads the item's current tier to stamp CONFIRM:<tier>.
    attentionItem.findFirst.mockResolvedValue({
      id: "item-1",
      source: "EMAIL",
      sourceId: "email-1",
      tier: "PUSH",
    });
  });

  it("stamps CONFIRM:<current tier> as positive ground truth", async () => {
    const result = await confirmAttentionTier("user-1", "item-1");
    expect(result).toEqual({ ok: true, tier: "PUSH" });
    expect(decisionLabel.updateMany).toHaveBeenCalledTimes(1);
    const args = decisionLabel.updateMany.mock.calls[0][0];
    expect(args.where).toEqual({
      userId: "user-1",
      source: "EMAIL",
      sourceId: "email-1",
      outcome: null, // first-action-wins, same guard as override
    });
    expect(args.data.outcome).toBe("CONFIRM:PUSH");
  });

  it("does NOT move the tier or set isManualOverride (agreement is not a correction)", async () => {
    // judge-context correction mining keys off isManualOverride; a confirm must
    // never look like a manual override, so it writes no AttentionItem row at all.
    await confirmAttentionTier("user-1", "item-1");
    expect(attentionItem.update).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });

  it("checks ownership before stamping", async () => {
    await confirmAttentionTier("user-1", "item-1");
    expect(attentionItem.findFirst).toHaveBeenCalledWith({
      where: { id: "item-1", userId: "user-1" },
      select: { id: true, source: true, sourceId: true, tier: true },
    });
  });

  it("returns not_found for items the user does not own, without stamping", async () => {
    attentionItem.findFirst.mockResolvedValueOnce(null);
    const result = await confirmAttentionTier("user-1", "other-users-item");
    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(decisionLabel.updateMany).not.toHaveBeenCalled();
  });

  it("normalizes a legacy CALL tier to PUSH before stamping", async () => {
    attentionItem.findFirst.mockResolvedValueOnce({
      id: "item-1",
      source: "EMAIL",
      sourceId: "email-1",
      tier: "CALL",
    });
    const result = await confirmAttentionTier("user-1", "item-1");
    expect(result).toEqual({ ok: true, tier: "PUSH" });
    expect(decisionLabel.updateMany.mock.calls[0][0].data.outcome).toBe("CONFIRM:PUSH");
  });
});

describe("findOpenEmailAttentionItemId", () => {
  it("resolves the OPEN EMAIL attention item for an email row", async () => {
    attentionItem.findFirst.mockResolvedValueOnce({ id: "att-1" });
    const id = await findOpenEmailAttentionItemId("user-1", "email-db-1");
    expect(id).toBe("att-1");
    expect(attentionItem.findFirst).toHaveBeenCalledWith({
      where: { userId: "user-1", source: "EMAIL", sourceId: "email-db-1", status: "OPEN" },
      select: { id: true },
    });
  });

  it("returns null when there is no matching item", async () => {
    attentionItem.findFirst.mockResolvedValueOnce(null);
    expect(await findOpenEmailAttentionItemId("user-1", "email-db-1")).toBeNull();
  });

  it("is best-effort: returns null instead of throwing on DB errors", async () => {
    attentionItem.findFirst.mockRejectedValueOnce(new Error("db down"));
    expect(await findOpenEmailAttentionItemId("user-1", "email-db-1")).toBeNull();
  });
});
