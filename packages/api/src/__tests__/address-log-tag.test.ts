import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { addressLogTag } from "../security/address-log-tag.js";

describe("addressLogTag", () => {
  it("is a short hex tag that carries no part of the address", () => {
    const tag = addressLogTag("alice.partner@example.com");
    expect(tag).toMatch(/^addr_[0-9a-f]{12}$/);
    expect(tag).not.toContain("alice");
    expect(tag).not.toContain("example");
  });

  it("is stable for one address, whatever its case or surrounding space", () => {
    const tag = addressLogTag("alice@example.com");
    expect(addressLogTag("alice@example.com")).toBe(tag);
    expect(addressLogTag("  Alice@Example.COM ")).toBe(tag);
  });

  it("tells different addresses apart", () => {
    expect(addressLogTag("alice@example.com")).not.toBe(addressLogTag("bob@example.com"));
  });

  it("is keyed: it is not the plain hash a guessed address could be checked against", () => {
    const address = "alice@example.com";
    const plain = createHash("sha256").update(address).digest("hex");
    expect(addressLogTag(address).slice("addr_".length)).not.toBe(plain.slice(0, 12));
  });
});
