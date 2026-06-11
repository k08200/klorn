import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => {
  const prisma = {
    attentionItem: {
      findFirst: vi.fn(async () => ({ id: "item-1" })),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});

import { findOpenEmailAttentionItemId, overrideAttentionTier } from "../attention-override.js";
import { prisma } from "../db.js";

type AttentionItemMock = {
  findFirst: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
const attentionItem = (prisma as unknown as { attentionItem: AttentionItemMock }).attentionItem;

beforeEach(() => {
  vi.clearAllMocks();
  attentionItem.findFirst.mockResolvedValue({ id: "item-1" });
});

describe("overrideAttentionTier", () => {
  it("stamps the poc-judge ground-truth tierReason convention", async () => {
    const result = await overrideAttentionTier("user-1", "item-1", "QUEUE");
    expect(result).toEqual({ ok: true, tier: "QUEUE" });
    expect(attentionItem.update).toHaveBeenCalledWith({
      where: { id: "item-1" },
      data: { tier: "QUEUE", tierReason: "Manual override — user moved to QUEUE" },
    });
  });

  it("checks ownership before mutating", async () => {
    await overrideAttentionTier("user-1", "item-1", "SILENT");
    expect(attentionItem.findFirst).toHaveBeenCalledWith({
      where: { id: "item-1", userId: "user-1" },
      select: { id: true },
    });
  });

  it("returns not_found for items the user does not own", async () => {
    attentionItem.findFirst.mockResolvedValueOnce(null);
    const result = await overrideAttentionTier("user-1", "other-users-item", "QUEUE");
    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(attentionItem.update).not.toHaveBeenCalled();
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
