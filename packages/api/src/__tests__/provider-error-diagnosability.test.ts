/**
 * Provider failure diagnosability + single-provider cooldown semantics.
 *
 * The 2026-07-26 → 08-02 judge outage was diagnosable only where the upstream
 * error survived: a 401 propagates untouched (`throw err`) and showed up in CI
 * logs as "401 User not found", while the 429/403 path was swallowed —
 * `markKeyLimited` logged its own classification, the raw body was dropped, and
 * the chain rethrew a generic AllProvidersExhaustedError. Root-causing the
 * second failure from logs alone was impossible.
 *
 * Two invariants pinned here:
 *   1. the upstream message survives into the operator log and the error chain,
 *      with key-shaped tokens redacted and the user-facing message unchanged;
 *   2. a deployment with no failover provider (single Anthropic key) never
 *      locks its ONLY provider out for an hour on an unspecified 429 — that
 *      turns a transient upstream blip into a fleet-wide outage of our own
 *      making (judge degrades to the keyword fallback, which structurally
 *      cannot emit PUSH — tier-policy.ts push.confidence 0.7 > fallback 0.55).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearFallbackState,
  describeErrorChain,
  getProviderCooldownInfo,
  markKeyLimited,
  redactProviderMessage,
} from "../llm/model-fallback.js";

describe("redactProviderMessage", () => {
  it("returns null when there is no usable message", () => {
    expect(redactProviderMessage(undefined)).toBeNull();
    expect(redactProviderMessage(null)).toBeNull();
    expect(redactProviderMessage(new Error(""))).toBeNull();
  });

  it("keeps the provider's own wording — that is the whole point", () => {
    expect(redactProviderMessage(new Error("429 Rate limit exceeded: 20 per 1m"))).toBe(
      "429 Rate limit exceeded: 20 per 1m",
    );
  });

  it("accepts a plain status/message object (SDK errors are not always Errors)", () => {
    expect(redactProviderMessage({ status: 429, message: "Too Many Requests" })).toBe(
      "Too Many Requests",
    );
  });

  it("redacts key-shaped tokens so an operator log never becomes a secret leak", () => {
    expect(
      redactProviderMessage(new Error("bad key sk-ant-api03-abc123def456ghi789 rejected")),
    ).toBe("bad key sk-*** rejected");
    expect(redactProviderMessage(new Error("Authorization: Bearer abc123def456ghi789jkl"))).toBe(
      "Authorization: Bearer ***",
    );
  });

  it("truncates a long provider body instead of flooding the log", () => {
    const out = redactProviderMessage(new Error("x".repeat(500)));
    expect(out).not.toBeNull();
    expect((out as string).length).toBeLessThanOrEqual(201);
    expect(out).toMatch(/…$/);
  });
});

describe("markKeyLimited — upstream reason survives into the operator log", () => {
  beforeEach(() => {
    clearFallbackState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearFallbackState();
  });

  it("logs the upstream provider message alongside the classification", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    markKeyLimited(
      "anthropic:env",
      new Error("429 rate_limit_error: This request would exceed your rate limit"),
    );
    const line = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(line).toContain("[MODEL-FALLBACK]");
    expect(line).toContain("429 rate_limit_error: This request would exceed your rate limit");
  });

  it("still logs when the caller passed no error at all", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    markKeyLimited("anthropic:env");
    expect(warn.mock.calls.length).toBeGreaterThan(0);
  });
});

describe("markKeyLimited — cooldown when the chain has no failover", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 2, 7, 49, 0)));
    clearFallbackState();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    clearFallbackState();
  });

  const cooldownMs = (quotaKey: string): number => {
    const until = getProviderCooldownInfo(quotaKey).keyLimitedUntil;
    if (!until) throw new Error(`${quotaKey} was not cooled down at all`);
    return until.getTime() - Date.now();
  };

  it("keeps the 1-hour ambiguous cooldown when a failover provider exists", () => {
    markKeyLimited("anthropic:env", new Error("429 Too Many Requests"), { hasFailover: true });
    expect(cooldownMs("anthropic:env")).toBeGreaterThan(50 * 60_000);
  });

  it("defaults to the failover-present behaviour when the option is omitted", () => {
    markKeyLimited("anthropic:env", new Error("429 Too Many Requests"));
    expect(cooldownMs("anthropic:env")).toBeGreaterThan(50 * 60_000);
  });

  it("shortens the ambiguous cooldown to 5 minutes when this is the only provider", () => {
    markKeyLimited("anthropic:env", new Error("429 Too Many Requests"), { hasFailover: false });
    const ms = cooldownMs("anthropic:env");
    expect(ms).toBeGreaterThan(4 * 60_000);
    expect(ms).toBeLessThanOrEqual(5 * 60_000 + 1);
  });

  it("still honours an EXPLICIT per-day quota signal with no failover", () => {
    // The provider said "per day" — retrying before the UTC reset only burns
    // failed calls. Only the *ambiguous* default is shortened.
    markKeyLimited("anthropic:env", new Error("429 rate limit exceeded per day"), {
      hasFailover: false,
    });
    const until = getProviderCooldownInfo("anthropic:env").keyLimitedUntil;
    expect(until?.getUTCDate()).toBe(3);
    expect(until?.getUTCHours()).toBe(0);
  });

  it("leaves the per-minute RPM cooldown at 5 minutes either way", () => {
    markKeyLimited("anthropic:env", new Error("429 rate limit exceeded per minute"), {
      hasFailover: false,
    });
    expect(cooldownMs("anthropic:env")).toBeLessThanOrEqual(5 * 60_000 + 1);
  });
});

describe("hasFailoverProvider — an already cooled-down peer is not a failover", () => {
  beforeEach(() => {
    clearFallbackState();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearFallbackState();
  });

  const provider = (quotaKey: string) => ({ quotaKey }) as never;

  it("reports a failover when a healthy peer is in the chain", async () => {
    const { hasFailoverProviderForTest } = await import("../llm/openai.js");
    const chain = [provider("anthropic:env"), provider("gemini:env")];
    expect(hasFailoverProviderForTest(chain, provider("anthropic:env"))).toBe(true);
  });

  it("reports none when the only peer is already cooled down", async () => {
    const { hasFailoverProviderForTest } = await import("../llm/openai.js");
    markKeyLimited("gemini:env", new Error("429 Too Many Requests"));
    const chain = [provider("anthropic:env"), provider("gemini:env")];
    expect(hasFailoverProviderForTest(chain, provider("anthropic:env"))).toBe(false);
  });

  it("reports none for a single-provider chain (the hosted single-key setup)", async () => {
    const { hasFailoverProviderForTest } = await import("../llm/openai.js");
    const chain = [provider("anthropic:env")];
    expect(hasFailoverProviderForTest(chain, provider("anthropic:env"))).toBe(false);
  });
});

describe("describeErrorChain — what a caller logs when it catches the wrapper", () => {
  it("appends the cause so the provider's own words reach the log", () => {
    const upstream = new Error("429 Rate limit exceeded: 20 per 1m");
    const wrapper = new Error("All AI providers are unavailable right now.", { cause: upstream });
    expect(describeErrorChain(wrapper)).toBe(
      "All AI providers are unavailable right now. (cause: 429 Rate limit exceeded: 20 per 1m)",
    );
  });

  it("returns the plain message when there is no cause", () => {
    expect(describeErrorChain(new Error("401 User not found."))).toBe("401 User not found.");
  });

  it("redacts key material anywhere in the chain", () => {
    const wrapper = new Error("wrapped", {
      cause: new Error("key sk-ant-api03-abcdef123456 denied"),
    });
    expect(describeErrorChain(wrapper)).toBe("wrapped (cause: key sk-*** denied)");
  });

  it("stops at a bounded depth so a self-referential cause cannot loop", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as Error & { cause?: unknown }).cause = b;
    expect(() => describeErrorChain(a)).not.toThrow();
  });
});

describe("buildExhaustedError — user message stays clean, cause is preserved", () => {
  afterEach(() => {
    clearFallbackState();
  });

  it("attaches the upstream error as `cause` without leaking it to the user", async () => {
    const { buildExhaustedError } = await import("../llm/openai.js");
    const upstream = new Error(
      "429 Rate limit exceeded: 20 per 1m for key sk-ant-api03-secret123456",
    );
    const err = buildExhaustedError([], upstream);

    expect(err.name).toBe("AllProvidersExhaustedError");
    // Operator-facing: the root cause travels with the error (Sentry follows
    // the cause chain), so the next 429 is diagnosable from the ledger.
    expect(err.cause).toBe(upstream);
    // User-facing: no provider body, no key material.
    expect(err.message).toContain("All AI providers are unavailable");
    expect(err.message).not.toContain("sk-ant");
    expect(err.message).not.toContain("20 per 1m");
  });
});
