import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_OPENROUTER_FALLBACK_CHAIN,
  parseFallbackChain,
} from "../llm/openrouter-fallback-chain.js";

describe("parseFallbackChain", () => {
  it("returns the default chain when no env value is set", () => {
    expect(parseFallbackChain(undefined)).toEqual(DEFAULT_OPENROUTER_FALLBACK_CHAIN);
    expect(parseFallbackChain("")).toEqual(DEFAULT_OPENROUTER_FALLBACK_CHAIN);
  });

  it("splits a comma-separated env value into trimmed entries", () => {
    expect(parseFallbackChain("a/b:free, c/d:free ,e/f:free")).toEqual([
      "a/b:free",
      "c/d:free",
      "e/f:free",
    ]);
  });

  it("drops empty entries from a malformed env value", () => {
    expect(parseFallbackChain("a/b:free,,,e/f:free, ")).toEqual(["a/b:free", "e/f:free"]);
  });

  it("default chain contains only :free SKUs (we never want to bill silently)", () => {
    for (const model of DEFAULT_OPENROUTER_FALLBACK_CHAIN) {
      expect(model).toMatch(/:free$/);
    }
  });

  it("default chain has at least 3 entries (resilience across multiple retirements)", () => {
    expect(DEFAULT_OPENROUTER_FALLBACK_CHAIN.length).toBeGreaterThanOrEqual(3);
  });

  it("default chain has no duplicates", () => {
    const set = new Set(DEFAULT_OPENROUTER_FALLBACK_CHAIN);
    expect(set.size).toBe(DEFAULT_OPENROUTER_FALLBACK_CHAIN.length);
  });
});

import { walkFallbackChain } from "../llm/openrouter-fallback-chain.js";

describe("walkFallbackChain", () => {
  it("returns the first success result and stops walking", async () => {
    const calls: string[] = [];
    const result = await walkFallbackChain(
      ["a:free", "b:free", "c:free"],
      "a:free", // already-tried (skip)
      async (model) => {
        calls.push(model);
        if (model === "b:free") return { ok: true, model };
        throw Object.assign(new Error("No endpoints found"), { status: 404 });
      },
    );
    expect(result).toEqual({ ok: true, model: "b:free" });
    expect(calls).toEqual(["b:free"]);
  });

  it("returns null when every chain entry is model-unavailable", async () => {
    const calls: string[] = [];
    const result = await walkFallbackChain(["x:free", "y:free"], undefined, async (model) => {
      calls.push(model);
      throw Object.assign(new Error("No endpoints found"), { status: 404 });
    });
    expect(result).toBeNull();
    expect(calls).toEqual(["x:free", "y:free"]);
  });

  it("skips the already-tried model so we don't retry the original failure", async () => {
    const calls: string[] = [];
    await walkFallbackChain(
      ["a:free", "b:free", "c:free"],
      "b:free", // skip this one
      async (model) => {
        calls.push(model);
        throw Object.assign(new Error("No endpoints found"), { status: 404 });
      },
    );
    expect(calls).toEqual(["a:free", "c:free"]);
  });

  it("propagates non-model-unavailable errors immediately", async () => {
    await expect(
      walkFallbackChain(["a:free", "b:free"], undefined, async (model) => {
        if (model === "a:free") {
          throw Object.assign(new Error("502 Bad Gateway"), { status: 502 });
        }
        return { ok: true };
      }),
    ).rejects.toThrow(/502/);
  });

  it("treats credit and key-limit errors as 'bail out of chain' signals (returns null)", async () => {
    let calls = 0;
    const r1 = await walkFallbackChain(["a:free", "b:free"], undefined, async () => {
      calls++;
      throw Object.assign(new Error("429 rate limit"), { status: 429 });
    });
    expect(r1).toBeNull();
    expect(calls).toBe(1); // bailed after the rate-limit on first attempt
  });

  it("returns null for an empty chain without calling the executor", async () => {
    let calls = 0;
    const r = await walkFallbackChain([], undefined, async () => {
      calls++;
      return { ok: true };
    });
    expect(r).toBeNull();
    expect(calls).toBe(0);
  });
});
