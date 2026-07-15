import { beforeEach, describe, expect, it, vi } from "vitest";

// getVoiceProfile reads a stored JSON row back. A legacy/hallucinated row (bad
// tone enum, stringified number, missing arrays) must be coerced to safe values
// on read — never bare-cast straight into LLM prompt context — and malformed
// JSON must yield null.

const memoryFindUnique = vi.hoisted(() => vi.fn());
vi.mock("../db.js", () => ({
  prisma: { memory: { findUnique: memoryFindUnique } },
}));

// getVoiceProfile only touches prisma.memory; stub the heavier deps the module
// imports so the import graph stays cheap and side-effect-free.
vi.mock("googleapis", () => ({ google: { auth: { OAuth2: vi.fn() }, gmail: vi.fn() } }));
vi.mock("../crypto-tokens.js", () => ({
  decryptToken: vi.fn(),
  decryptOptional: vi.fn(),
}));
vi.mock("../memory.js", () => ({ remember: vi.fn() }));
vi.mock("../llm/openai.js", () => ({ createCompletion: vi.fn(), MODEL: "test-model" }));

import { getVoiceProfile } from "../voice-profile-extractor.js";

beforeEach(() => memoryFindUnique.mockReset());

describe("getVoiceProfile — coerce on read", () => {
  it("coerces a hallucinated tone and stringified number to safe values", async () => {
    memoryFindUnique.mockResolvedValue({
      content: JSON.stringify({
        tone: "urgent", // not a valid enum member
        avgLengthWords: "120", // stringified number
        closingPhrases: "Best,", // not an array
        keyTraits: ["concise", 42, "direct"], // mixed array
        exampleOpeners: null,
        confidence: 2.5, // out of [0,1]
        sampledAt: "2026-06-01T00:00:00.000Z",
      }),
    });

    const profile = await getVoiceProfile("user-1");
    expect(profile).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted non-null above
    const p = profile!;
    expect(p.tone).toBe("mixed"); // hallucinated enum → fallback
    expect(p.avgLengthWords).toBe(120); // coerced from string
    expect(p.closingPhrases).toEqual([]); // non-array → []
    expect(p.keyTraits).toEqual(["concise", "direct"]); // non-strings dropped
    expect(p.exampleOpeners).toEqual([]);
    expect(p.confidence).toBe(1); // clamped to [0,1]
    expect(p.sampledAt).toBe("2026-06-01T00:00:00.000Z"); // stored value preserved
  });

  it("returns a valid profile unchanged", async () => {
    memoryFindUnique.mockResolvedValue({
      content: JSON.stringify({
        tone: "formal",
        avgLengthWords: 90,
        closingPhrases: ["Best,"],
        keyTraits: ["concise"],
        exampleOpeners: ["Hi team,"],
        confidence: 0.8,
        sampledAt: "2026-06-10T00:00:00.000Z",
      }),
    });
    const p = await getVoiceProfile("user-1");
    expect(p).toMatchObject({
      tone: "formal",
      avgLengthWords: 90,
      confidence: 0.8,
    });
  });

  it("returns null on malformed JSON", async () => {
    memoryFindUnique.mockResolvedValue({ content: "{not valid json" });
    expect(await getVoiceProfile("user-1")).toBeNull();
  });

  it("returns null when no row exists", async () => {
    memoryFindUnique.mockResolvedValue(null);
    expect(await getVoiceProfile("user-1")).toBeNull();
  });
});
