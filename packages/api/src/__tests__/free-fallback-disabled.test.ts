/**
 * Privacy kill switch — DISABLE_FREE_MODEL_FALLBACK.
 *
 * Hosted prod must never degrade onto :free OpenRouter endpoints (their hosts
 * may train on request data — Limited Use violation). The switch disables the
 * 402 credit swap and strips :free entries from the retirement chain, so the
 * provider loop fails over to the next provider (paid Gemini) instead.
 */

import { afterEach, describe, expect, it } from "vitest";
import { isFreeModelFallbackDisabled } from "../llm/model-fallback.js";
import {
  activeFallbackChain,
  OPENROUTER_FALLBACK_CHAIN,
} from "../llm/openrouter-fallback-chain.js";

const ORIGINAL = process.env.DISABLE_FREE_MODEL_FALLBACK;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.DISABLE_FREE_MODEL_FALLBACK;
  else process.env.DISABLE_FREE_MODEL_FALLBACK = ORIGINAL;
});

describe("isFreeModelFallbackDisabled — env parsing", () => {
  it("is OFF by default (self-host keeps the $0 degradation net)", () => {
    delete process.env.DISABLE_FREE_MODEL_FALLBACK;
    expect(isFreeModelFallbackDisabled()).toBe(false);
  });

  it("accepts lenient truthy spellings (true/1/yes/on, trimmed, any case)", () => {
    for (const v of ["true", "TRUE", " 1 ", "yes", "On"]) {
      process.env.DISABLE_FREE_MODEL_FALLBACK = v;
      expect(isFreeModelFallbackDisabled(), `value ${JSON.stringify(v)}`).toBe(true);
    }
  });

  it("treats anything else as OFF (false/0/empty/garbage)", () => {
    for (const v of ["false", "0", "", "off", "nope"]) {
      process.env.DISABLE_FREE_MODEL_FALLBACK = v;
      expect(isFreeModelFallbackDisabled(), `value ${JSON.stringify(v)}`).toBe(false);
    }
  });
});

describe("activeFallbackChain — retirement chain under the switch", () => {
  it("returns the full configured chain when the switch is off", () => {
    delete process.env.DISABLE_FREE_MODEL_FALLBACK;
    expect(activeFallbackChain()).toEqual(OPENROUTER_FALLBACK_CHAIN);
  });

  it("strips every :free entry when the switch is on", () => {
    process.env.DISABLE_FREE_MODEL_FALLBACK = "true";
    const active = activeFallbackChain();
    expect(active.some((m) => m.endsWith(":free"))).toBe(false);
    // The default chain is all-:free, so prod's active retirement chain is
    // empty — the provider loop moves straight to the next provider.
    expect(active.every((m) => OPENROUTER_FALLBACK_CHAIN.includes(m))).toBe(true);
  });
});
