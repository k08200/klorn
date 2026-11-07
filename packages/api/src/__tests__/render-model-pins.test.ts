/**
 * Prod model pins in render.yaml (the Render blueprint syncs these values).
 *
 * CHAT_MODEL is MODEL in code (llm/openai.ts): the default for every
 * background summary surface (thread brief, sender dossier, commitments,
 * drive summaries, voice profile, attachment text) and the model Settings
 * shows as the default. After #1611 it was Claude Sonnet 5, and background
 * work moved from Haiku to Sonnet without anyone choosing that: 197 calls,
 * 1.81M prompt tokens in 2026-11-04..07 (≈ $4 vs ≈ $0.2 on Haiku). Founder
 * decision 2026-11-07: background runs on Haiku; a user can still pick Sonnet
 * or Opus for their own chat in Settings (that is `userModel`, not this pin).
 *
 * Changing a pin here changes prod cost — do it deliberately, with this test.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CURATED_MODELS } from "../llm/model-catalog.js";

const RENDER_YAML = readFileSync(resolve(__dirname, "../../../../render.yaml"), "utf8");

function pin(key: string): string | undefined {
  const match = RENDER_YAML.match(new RegExp(`- key: ${key}\\n\\s+value: "([^"]+)"`));
  return match?.[1];
}

describe("render.yaml model pins", () => {
  it.each([
    "CHAT_MODEL",
    "AGENT_MODEL",
    "JUDGE_MODEL",
    "VISION_MODEL",
  ])("%s runs Claude Haiku 5.5", (key) => {
    expect(pin(key)).toBe("claude-haiku-5-5");
  });

  it("keeps Sonnet and Opus available as a user's own chat pick", () => {
    const ids = CURATED_MODELS.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(["claude-sonnet-5", "claude-opus-4-8"]));
  });
});
