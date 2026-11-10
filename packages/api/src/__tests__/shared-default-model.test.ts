/**
 * In-code model defaults. Since the Claude-only switch (2026-11-01) every
 * surface defaults to the native claude-haiku-5-5 whatever NODE_ENV says —
 * the old split (paid flash on a funded deploy, a :free id elsewhere) only
 * existed for the retired proxy lane. Per-surface envs still override.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const SURFACE_ENVS = ["CHAT_MODEL", "AGENT_MODEL", "JUDGE_MODEL", "DRAFT_MODEL", "VISION_MODEL"];

async function loadDefaults(nodeEnv: string) {
  vi.stubEnv("NODE_ENV", nodeEnv);
  for (const name of SURFACE_ENVS) vi.stubEnv(name, "");
  vi.resetModules();
  return await import("../llm/openai.js");
}

describe("shared default model", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each([
    "production",
    "test",
  ])("defaults every surface to claude-haiku-5-5 (NODE_ENV=%s)", async (nodeEnv) => {
    const { MODEL, AGENT_MODEL, JUDGE_MODEL, DRAFT_MODEL, VISION_MODEL } =
      await loadDefaults(nodeEnv);
    expect([MODEL, AGENT_MODEL, JUDGE_MODEL, DRAFT_MODEL, VISION_MODEL]).toEqual([
      "claude-haiku-5-5",
      "claude-haiku-5-5",
      "claude-haiku-5-5",
      "claude-haiku-5-5",
      "claude-haiku-5-5",
    ]);
  });

  it("still honors an explicit CHAT_MODEL override", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CHAT_MODEL", "claude-sonnet-5");
    vi.resetModules();
    const { MODEL, AGENT_MODEL } = await import("../llm/openai.js");
    expect(MODEL).toBe("claude-sonnet-5");
    // AGENT_MODEL follows CHAT_MODEL unless it is set itself.
    expect(AGENT_MODEL).toBe("claude-sonnet-5");
  });
});
