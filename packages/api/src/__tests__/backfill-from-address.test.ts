/**
 * Backfill transform — the pure per-row mapping from an EmailMessage.from
 * header to the normalized fromAddress column value. Must use the same
 * extractEmailAddress helper as persist + query so backfilled rows match.
 */

import { describe, expect, it } from "vitest";

import { rowToFromAddress } from "../../scripts/backfill-from-address.js";

describe("rowToFromAddress", () => {
  it("extracts the address from a display-name header", () => {
    expect(rowToFromAddress("Jane Doe <jane@acme.com>")).toBe("jane@acme.com");
  });

  it("lowercases the extracted address", () => {
    expect(rowToFromAddress("Support <SUPPORT@Corp.COM>")).toBe("support@corp.com");
  });

  it("handles a bare address with no angle brackets", () => {
    expect(rowToFromAddress("plain@example.com")).toBe("plain@example.com");
  });

  it("returns null for an empty/whitespace header so the column stays null-safe", () => {
    expect(rowToFromAddress("")).toBeNull();
    expect(rowToFromAddress("   ")).toBeNull();
  });
});
