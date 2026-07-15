import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyKeyLimitError,
  clearFallbackState,
  getProviderCooldownInfo,
  isKeyLimitError,
  isKeyLimited,
  markKeyLimited,
  nextDailyResetMs,
} from "../llm/model-fallback.js";

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

describe("classifyKeyLimitError", () => {
  it("recognises per-minute RPM messages", () => {
    expect(classifyKeyLimitError(new Error("Rate limit exceeded per minute"))).toBe("minute");
    expect(classifyKeyLimitError(new Error("Quota exceeded for per-minute requests"))).toBe(
      "minute",
    );
  });

  it("recognises per-day / daily quota messages", () => {
    expect(classifyKeyLimitError(new Error("Quota exceeded per day"))).toBe("daily");
    expect(classifyKeyLimitError(new Error("Daily limit reached for free models"))).toBe("daily");
    expect(classifyKeyLimitError(new Error("Weekly limit exceeded"))).toBe("daily");
  });

  it("falls back to ambiguous for bare 429s and unspecified rate-limit text", () => {
    expect(classifyKeyLimitError(new Error("429 Too Many Requests"))).toBe("ambiguous");
    expect(classifyKeyLimitError(new Error("Rate limit exceeded"))).toBe("ambiguous");
    expect(classifyKeyLimitError(undefined)).toBe("ambiguous");
  });
});

describe("markKeyLimited cooldown durations", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 24, 12, 0, 0)));
    clearFallbackState();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearFallbackState();
  });

  it("applies a 5-minute cooldown when the error is per-minute", () => {
    markKeyLimited("openrouter:test", new Error("429 rate limit exceeded per minute"));
    const info = getProviderCooldownInfo("openrouter:test");
    expect(info.keyLimitedUntil).not.toBeNull();
    const diffMs = (info.keyLimitedUntil as Date).getTime() - Date.now();
    expect(diffMs).toBeGreaterThan(4 * 60_000);
    expect(diffMs).toBeLessThanOrEqual(5 * 60_000 + 1);
  });

  it("holds until next UTC midnight for daily/weekly quotas", () => {
    markKeyLimited("gemini:test", new Error("quota exceeded per day"));
    const info = getProviderCooldownInfo("gemini:test");
    expect(info.keyLimitedUntil?.getUTCDate()).toBe(25);
    expect(info.keyLimitedUntil?.getUTCHours()).toBe(0);
  });

  it("uses a 1-hour ambiguous cooldown for unspecified 429s", () => {
    markKeyLimited("ambig:test", new Error("429 Too Many Requests"));
    const info = getProviderCooldownInfo("ambig:test");
    const diffMs = (info.keyLimitedUntil as Date).getTime() - Date.now();
    expect(diffMs).toBeGreaterThan(50 * 60_000);
    expect(diffMs).toBeLessThanOrEqual(60 * 60_000 + 1);
  });

  it("isKeyLimited clears the slot once the cooldown elapses", () => {
    markKeyLimited("expiring:test", new Error("rate limit exceeded per minute"));
    expect(isKeyLimited("expiring:test")).toBe(true);
    vi.advanceTimersByTime(5 * 60_000 + 1000);
    expect(isKeyLimited("expiring:test")).toBe(false);
  });
});
