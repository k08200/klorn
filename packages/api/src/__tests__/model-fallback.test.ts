import { describe, expect, it } from "vitest";
import { isKeyLimitError, nextDailyResetMs } from "../model-fallback.js";

describe("model fallback error classification", () => {
  it("treats provider 429s as quota/rate-limit errors", () => {
    expect(isKeyLimitError({ status: 429, message: "Provider returned error" })).toBe(true);
    expect(isKeyLimitError(new Error("429 Provider returned error"))).toBe(true);
  });

  it("keeps generic 403 auth failures out of quota fallback", () => {
    expect(isKeyLimitError({ status: 403, message: "Invalid API key" })).toBe(false);
    expect(isKeyLimitError(new Error("403 Forbidden"))).toBe(false);
  });

  it("does not match transient upstream 5xx as a quota error", () => {
    expect(isKeyLimitError(new Error("Provider returned error"))).toBe(false);
    expect(isKeyLimitError(new Error("Internal Server Error"))).toBe(false);
  });
});

describe("nextDailyResetMs", () => {
  it("targets the next UTC midnight, never today's", () => {
    const noon = new Date(Date.UTC(2026, 4, 24, 12, 0, 0));
    const reset = new Date(nextDailyResetMs(noon));
    expect(reset.getUTCFullYear()).toBe(2026);
    expect(reset.getUTCMonth()).toBe(4);
    expect(reset.getUTCDate()).toBe(25);
    expect(reset.getUTCHours()).toBe(0);
    expect(reset.getUTCMinutes()).toBe(0);
  });

  it("rolls to next month/year at the boundary", () => {
    const lastDayOfYear = new Date(Date.UTC(2026, 11, 31, 23, 59, 0));
    const reset = new Date(nextDailyResetMs(lastDayOfYear));
    expect(reset.getUTCFullYear()).toBe(2027);
    expect(reset.getUTCMonth()).toBe(0);
    expect(reset.getUTCDate()).toBe(1);
  });

  it("returns under 24h from any UTC time", () => {
    const sample = new Date(Date.UTC(2026, 6, 4, 23, 30, 0));
    const diff = nextDailyResetMs(sample) - sample.getTime();
    expect(diff).toBeGreaterThan(0);
    expect(diff).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });
});
