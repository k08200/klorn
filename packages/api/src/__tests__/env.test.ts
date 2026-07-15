import { afterEach, describe, expect, it } from "vitest";
import { isDevOrTestEnv } from "../env.js";

const ORIGINAL = process.env.NODE_ENV;

describe("isDevOrTestEnv", () => {
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL;
  });

  it("is true only for development and test", () => {
    process.env.NODE_ENV = "development";
    expect(isDevOrTestEnv()).toBe(true);
    process.env.NODE_ENV = "test";
    expect(isDevOrTestEnv()).toBe(true);
  });

  it("is false for production", () => {
    process.env.NODE_ENV = "production";
    expect(isDevOrTestEnv()).toBe(false);
  });

  it('fails closed for every non-dev/test value that === "production" checks missed', () => {
    for (const env of ["staging", "prod", "Production", "PRODUCTION", "dev", ""]) {
      process.env.NODE_ENV = env;
      expect(isDevOrTestEnv()).toBe(false);
    }
    process.env.NODE_ENV = undefined;
    expect(isDevOrTestEnv()).toBe(false);
    delete process.env.NODE_ENV;
    expect(isDevOrTestEnv()).toBe(false);
  });
});
