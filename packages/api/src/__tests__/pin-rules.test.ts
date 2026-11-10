/**
 * pin-rules — the ONE implementation of tier-pin validation and replace
 * semantics, shared by the /:id/pin-tier routes, the NL rule compiler's
 * apply path, and the settings Rules UI. Validation is the write-side twin
 * of fetchPinnedTier's read-side rules: live lanes only (AUTO/CALL are
 * retired), exact address or exact non-public domain, lowercased.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ruleFindMany = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const ruleCreate = vi.hoisted(() => vi.fn(async () => ({ id: "new-1" })));
const ruleDeleteMany = vi.hoisted(() => vi.fn(async () => ({ count: 0 })));
const dbTransaction = vi.hoisted(() => vi.fn(async (ops: unknown[]) => Promise.all(ops)));

vi.mock("../db.js", () => {
  const prisma = {
    emailRule: { findMany: ruleFindMany, create: ruleCreate, deleteMany: ruleDeleteMany },
    $transaction: dbTransaction,
  };
  return { prisma, db: prisma };
});

import { listTierPins, replaceTierPins, validateTierPin } from "../mail/pin-rules.js";

beforeEach(() => {
  ruleFindMany.mockReset();
  ruleFindMany.mockResolvedValue([]);
  ruleCreate.mockReset();
  ruleCreate.mockResolvedValue({ id: "new-1" });
  ruleDeleteMany.mockClear();
  dbTransaction.mockClear();
});

describe("validateTierPin", () => {
  it("accepts a sender pin and normalizes to lowercase", () => {
    const v = validateTierPin({ scope: "sender", value: "Boss@Acme.com", tier: "PUSH" });
    expect(v).toEqual({ ok: { scope: "sender", value: "boss@acme.com", tier: "PUSH" } });
  });

  it("accepts a domain pin, stripping a leading @", () => {
    const v = validateTierPin({ scope: "domain", value: "@Acme.com", tier: "SILENT" });
    expect(v).toEqual({ ok: { scope: "domain", value: "acme.com", tier: "SILENT" } });
  });

  it("rejects the retired AUTO lane", () => {
    const v = validateTierPin({ scope: "sender", value: "a@b.com", tier: "AUTO" });
    expect("error" in v).toBe(true);
  });

  it("rejects a malformed address for sender scope", () => {
    expect(
      "error" in validateTierPin({ scope: "sender", value: "not-an-address", tier: "PUSH" }),
    ).toBe(true);
  });

  it("rejects an address where a domain should be", () => {
    expect("error" in validateTierPin({ scope: "domain", value: "a@b.com", tier: "PUSH" })).toBe(
      true,
    );
  });

  it("rejects a public mailbox domain", () => {
    expect("error" in validateTierPin({ scope: "domain", value: "gmail.com", tier: "PUSH" })).toBe(
      true,
    );
  });

  it("rejects an unknown scope or tier outright", () => {
    expect("error" in validateTierPin({ scope: "galaxy", value: "a@b.com", tier: "PUSH" })).toBe(
      true,
    );
    expect("error" in validateTierPin({ scope: "sender", value: "a@b.com", tier: "LOUD" })).toBe(
      true,
    );
  });
});

describe("replaceTierPins", () => {
  it("creates rules in the pin-tier shape inside one transaction", async () => {
    const applied = await replaceTierPins("u1", [
      { scope: "sender", value: "boss@acme.com", tier: "PUSH" },
      { scope: "domain", value: "acme.com", tier: "SILENT" },
    ]);
    expect(applied).toHaveLength(2);
    expect(dbTransaction).toHaveBeenCalledTimes(1);
    expect(ruleCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "u1",
          name: "Pin: boss@acme.com",
          conditions: { from: ["boss@acme.com"] },
          actionType: "PIN_TIER",
          actionValue: "PUSH",
        }),
      }),
    );
    expect(ruleCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "Pin: @acme.com",
          conditions: { fromDomain: ["acme.com"] },
          actionValue: "SILENT",
        }),
      }),
    );
  });

  it("replaces existing pins for the same entity (one findMany, stale ids deleted)", async () => {
    ruleFindMany.mockResolvedValue([
      { id: "old-sender", conditions: { from: ["boss@acme.com"] } },
      { id: "old-domain", conditions: { fromDomain: ["acme.com"] } },
      { id: "unrelated", conditions: { from: ["other@x.com"] } },
    ]);
    await replaceTierPins("u1", [{ scope: "sender", value: "boss@acme.com", tier: "QUEUE" }]);
    expect(ruleFindMany).toHaveBeenCalledTimes(1);
    expect(ruleDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["old-sender"] }, userId: "u1" },
    });
  });

  it("no pins → no transaction", async () => {
    const applied = await replaceTierPins("u1", []);
    expect(applied).toEqual([]);
    expect(dbTransaction).not.toHaveBeenCalled();
  });
});

describe("listTierPins", () => {
  it("maps stored pin rules to wire pins and skips generic rules", async () => {
    ruleFindMany.mockResolvedValue([
      { id: "r1", conditions: { from: ["boss@acme.com"] }, actionValue: "PUSH" },
      { id: "r2", conditions: { fromDomain: ["acme.com"] }, actionValue: "SILENT" },
      // Generic multi-condition rule authored via /rules — not a pin, skipped.
      { id: "r3", conditions: { from: ["a@b.com", "c@d.com"] }, actionValue: "PUSH" },
      // Junk tier — never surfaces on the wire.
      { id: "r4", conditions: { from: ["x@y.com"] }, actionValue: "CALL" },
    ]);
    const pins = await listTierPins("u1");
    expect(pins).toEqual([
      { id: "r1", scope: "sender", value: "boss@acme.com", tier: "PUSH" },
      { id: "r2", scope: "domain", value: "acme.com", tier: "SILENT" },
    ]);
  });
});

describe("replaceTierPins — in-request duplicates", () => {
  it("dedupes the same entity within one request, last wins", async () => {
    await replaceTierPins("u1", [
      { scope: "sender", value: "a@b.com", tier: "PUSH" },
      { scope: "sender", value: "a@b.com", tier: "QUEUE" },
    ]);
    expect(ruleCreate).toHaveBeenCalledTimes(1);
    expect(ruleCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ actionValue: "QUEUE" }),
      }),
    );
  });
});
