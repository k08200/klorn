import { describe, expect, it } from "vitest";
import { decryptOptional, decryptToken, encryptOptional, encryptToken } from "../crypto-tokens.js";

describe("crypto-tokens", () => {
  it("round-trips a plaintext through encrypt/decrypt", () => {
    const plain = "ya29.fake-google-access-token-abc123";
    const ct = encryptToken(plain);
    expect(ct.startsWith("v1:")).toBe(true);
    expect(ct).not.toContain(plain);
    expect(decryptToken(ct)).toBe(plain);
  });

  it("uses a fresh IV per call so the same plaintext yields different ciphertext", () => {
    const plain = "same-value";
    const a = encryptToken(plain);
    const b = encryptToken(plain);
    expect(a).not.toBe(b);
    expect(decryptToken(a)).toBe(plain);
    expect(decryptToken(b)).toBe(plain);
  });

  it("refuses to use a non-v1 (plaintext) token instead of silently passing it through", () => {
    // Cutoff: a plaintext OAuth token in the DB must never be trusted as-is.
    // Callers treat a decrypt throw as "rotate/reconnect", so failing loud here
    // is the safe behaviour — the old silent passthrough hid the gap.
    const legacy = "already-stored-plaintext-token";
    expect(() => decryptToken(legacy)).toThrow(/non-v1/);
  });

  it("rejects tampered ciphertext via the GCM auth tag", () => {
    const ct = encryptToken("secret");
    const tampered = `${ct.slice(0, -4)}AAAA`;
    expect(() => decryptToken(tampered)).toThrow();
  });

  it("throws on malformed v1: envelopes", () => {
    expect(() => decryptToken("v1:not-enough-parts")).toThrow("Malformed encrypted token");
  });

  it("returns the empty string for empty input on both sides", () => {
    expect(encryptToken("")).toBe("");
    expect(decryptToken("")).toBe("");
  });

  it("encryptOptional / decryptOptional preserve null and undefined", () => {
    expect(encryptOptional(null)).toBeNull();
    expect(encryptOptional(undefined)).toBeNull();
    expect(decryptOptional(null)).toBeNull();
    expect(decryptOptional(undefined)).toBeNull();
  });

  it("encryptOptional wraps a non-empty string like encryptToken", () => {
    const ct = encryptOptional("refresh-token");
    expect(ct).not.toBeNull();
    expect(ct?.startsWith("v1:")).toBe(true);
    expect(decryptOptional(ct)).toBe("refresh-token");
  });
});
