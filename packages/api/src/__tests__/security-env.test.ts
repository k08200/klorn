import { describe, expect, it } from "vitest";
import { isDevFallbackSecretAllowed } from "../security-env.js";

describe("isDevFallbackSecretAllowed", () => {
  it("allows the public dev fallback only for development and test", () => {
    expect(isDevFallbackSecretAllowed("development")).toBe(true);
    expect(isDevFallbackSecretAllowed("test")).toBe(true);
  });

  it("rejects production, staging, an empty string, and any typo (fails closed)", () => {
    expect(isDevFallbackSecretAllowed("production")).toBe(false);
    expect(isDevFallbackSecretAllowed("staging")).toBe(false);
    expect(isDevFallbackSecretAllowed("prod")).toBe(false);
    expect(isDevFallbackSecretAllowed("Production")).toBe(false);
    expect(isDevFallbackSecretAllowed("")).toBe(false);
  });

  it("rejects an unset NODE_ENV (the no-arg default reads process.env)", () => {
    const prev = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      expect(isDevFallbackSecretAllowed()).toBe(false);
    } finally {
      if (prev !== undefined) process.env.NODE_ENV = prev;
    }
  });
});
