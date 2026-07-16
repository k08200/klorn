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

  it("never mandates a tool call", () => {
    expect(BRIEFING_SYSTEM_PROMPT).not.toMatch(/propose_action/i);
    expect(BRIEFING_SYSTEM_PROMPT).not.toMatch(/notify_user/i);
    expect(BRIEFING_SYSTEM_PROMPT).toMatch(/never call tools/i);
  });

  it("asks for prose briefing text", () => {
    expect(BRIEFING_SYSTEM_PROMPT).toMatch(/briefing/i);
    expect(BRIEFING_SYSTEM_PROMPT).toMatch(/markdown|prose/i);
  });
});
