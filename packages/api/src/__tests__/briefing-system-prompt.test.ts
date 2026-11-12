/**
 * The briefing must NOT reuse the autonomous agent's tool-mandating system
 * prompt: a tool-following model returns empty text when the briefing call
 * passes no tools, silently degrading every briefing to the rule-based view
 * (prod 2026-07-17). This pins the briefing prompt as prose-only.
 */

import { describe, expect, it } from "vitest";
import { AGENT_SYSTEM_PROMPT } from "../agent/prompt.js";
import { BRIEFING_SYSTEM_PROMPT } from "../pim/briefing.js";

describe("BRIEFING_SYSTEM_PROMPT", () => {
  it("is not the tool-mandating agent prompt", () => {
    expect(BRIEFING_SYSTEM_PROMPT).not.toBe(AGENT_SYSTEM_PROMPT);
  });

  it("never mandates the agent's tools", () => {
    expect(BRIEFING_SYSTEM_PROMPT).not.toMatch(/propose_action/i);
    expect(BRIEFING_SYSTEM_PROMPT).not.toMatch(/notify_user/i);
  });

  it("asks for the briefing as the JSON answer the server checks and renders", () => {
    expect(BRIEFING_SYSTEM_PROMPT).toMatch(/briefing/i);
    expect(BRIEFING_SYSTEM_PROMPT).toMatch(/one JSON object/i);
    for (const key of ['"signal"', '"picks"', '"quote"', '"connected"', '"other"']) {
      expect(BRIEFING_SYSTEM_PROMPT).toContain(key);
    }
  });

  it("is static, so every user's briefing shares one cacheable prefix", () => {
    // No date, no language, no user data: those go in the user message.
    expect(BRIEFING_SYSTEM_PROMPT).not.toMatch(/\$\{|Today is|Korean only|English only/);
    // The cache needs a prefix of at least 512 tokens on the 5.5 family
    // (providers/anthropic-native.ts); ~4 characters per token.
    expect(BRIEFING_SYSTEM_PROMPT.length).toBeGreaterThan(2600);
  });

  it("carries the standard untrusted-content rule, and never asks for the tags back", () => {
    expect(BRIEFING_SYSTEM_PROMPT).toContain("<untrusted_content>");
    expect(BRIEFING_SYSTEM_PROMPT).toMatch(/data[^.]*not instructions/i);
    expect(BRIEFING_SYSTEM_PROMPT).toMatch(/never (repeat|copy|reproduce)[^.]*tags/i);
  });
});
