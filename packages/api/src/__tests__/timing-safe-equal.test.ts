import { describe, expect, it } from "vitest";
import { timingSafeEqualStr } from "../timing-safe-equal.js";

describe("timingSafeEqualStr", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqualStr("s3cr3t-token", "s3cr3t-token")).toBe(true);
  });

  it("returns false for differing strings of equal length", () => {
    expect(timingSafeEqualStr("aaaaaa", "aaaaab")).toBe(false);
  });

  it("returns false (without throwing) for differing lengths", () => {
    expect(timingSafeEqualStr("short", "a-much-longer-secret")).toBe(false);
  });

  it("handles empty strings", () => {
    expect(timingSafeEqualStr("", "")).toBe(true);
    expect(timingSafeEqualStr("", "x")).toBe(false);
  });
});
