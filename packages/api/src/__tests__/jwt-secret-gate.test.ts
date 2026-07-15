import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// auth.ts imports db/stripe with load-time side effects; stub them so we can
// unit-test the JWT-secret gate in isolation.
vi.mock("../db.js", () => ({ db: {}, prisma: {} }));
vi.mock("../billing/stripe.js", () => ({ getEffectivePlan: () => "FREE" }));

import { isDemoAccessEnabled, resolveEffectiveJwtSecret } from "../auth.js";

const ORIGINAL_ENV = { ...process.env };

function reset() {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.JWT_SECRET;
  delete process.env.ENABLE_DEMO_USER;
  process.env.NODE_ENV = "test";
}

describe("resolveEffectiveJwtSecret", () => {
  beforeEach(reset);
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns the configured secret in any environment", () => {
    process.env.NODE_ENV = "production";
    process.env.JWT_SECRET = "a-real-configured-secret";
    expect(resolveEffectiveJwtSecret()).toBe("a-real-configured-secret");
  });

  it("uses the dev secret only in development/test when JWT_SECRET is unset", () => {
    for (const env of ["development", "test"]) {
      process.env.NODE_ENV = env;
      expect(resolveEffectiveJwtSecret()).toContain("dev-secret");
    }
  });

  it("throws (never signs with the public dev secret) outside dev/test with no JWT_SECRET", () => {
    for (const env of ["production", "staging", "prod", "Production"]) {
      process.env.NODE_ENV = env;
      expect(() => resolveEffectiveJwtSecret()).toThrow(/JWT_SECRET must be set/);
    }
    delete process.env.NODE_ENV;
    expect(() => resolveEffectiveJwtSecret()).toThrow(/JWT_SECRET must be set/);
  });
});

describe("isDemoAccessEnabled", () => {
  beforeEach(reset);
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("is enabled only in dev/test with the explicit opt-in", () => {
    process.env.ENABLE_DEMO_USER = "true";
    process.env.NODE_ENV = "development";
    expect(isDemoAccessEnabled()).toBe(true);
    process.env.NODE_ENV = "test";
    expect(isDemoAccessEnabled()).toBe(true);
  });

  it("is disabled (fail-closed) for staging/prod-typo/unset even with the opt-in set", () => {
    process.env.ENABLE_DEMO_USER = "true";
    for (const env of ["production", "staging", "prod", "Production"]) {
      process.env.NODE_ENV = env;
      expect(isDemoAccessEnabled()).toBe(false);
    }
    delete process.env.NODE_ENV;
    expect(isDemoAccessEnabled()).toBe(false);
  });

  it("is disabled in dev/test without the opt-in", () => {
    process.env.NODE_ENV = "development";
    delete process.env.ENABLE_DEMO_USER;
    expect(isDemoAccessEnabled()).toBe(false);
  });
});
