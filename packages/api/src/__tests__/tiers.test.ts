import { describe, expect, it } from "vitest";
import { isTier, normalizeTier, TIERS } from "../tiers.js";

describe("TIERS", () => {
  it("is exactly the canonical 4 tiers — no CALL", () => {
    expect(TIERS).toEqual(["SILENT", "QUEUE", "PUSH", "AUTO"]);
    expect(TIERS).not.toContain("CALL");
  });
});

describe("normalizeTier", () => {
  it("passes through each valid tier unchanged", () => {
    for (const tier of TIERS) {
      expect(normalizeTier(tier)).toBe(tier);
    }
  });

  it("maps the retired CALL tier to PUSH, not QUEUE", () => {
    // Legacy AttentionItem rows written before CALL was retired must keep
    // their interrupt semantics (PUSH), not silently demote to QUEUE.
    expect(normalizeTier("CALL")).toBe("PUSH");
  });

  it("defaults null/undefined/unknown to QUEUE (visible)", () => {
    expect(normalizeTier(null)).toBe("QUEUE");
    expect(normalizeTier(undefined)).toBe("QUEUE");
    expect(normalizeTier("")).toBe("QUEUE");
    expect(normalizeTier("GARBAGE")).toBe("QUEUE");
  });
});

describe("isTier", () => {
  it("accepts canonical tiers and rejects everything else", () => {
    expect(isTier("PUSH")).toBe(true);
    expect(isTier("CALL")).toBe(false);
    expect(isTier(null)).toBe(false);
    expect(isTier(42)).toBe(false);
  });
});
