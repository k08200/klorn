import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTO_REPLY_GUIDELINE,
  effectiveAutoReplyGuideline,
  MAX_GUIDELINE_LENGTH,
  normalizeAttentionMode,
  normalizeAutoReplyGuideline,
} from "../learning/auto-reply-guideline.js";

describe("normalizeAttentionMode", () => {
  it("accepts AUTO, defaults everything else to BASIC", () => {
    expect(normalizeAttentionMode("AUTO")).toBe("AUTO");
    expect(normalizeAttentionMode("BASIC")).toBe("BASIC");
    expect(normalizeAttentionMode("auto")).toBe("BASIC");
    expect(normalizeAttentionMode(null)).toBe("BASIC");
    expect(normalizeAttentionMode(undefined)).toBe("BASIC");
    expect(normalizeAttentionMode(42)).toBe("BASIC");
  });
});

describe("normalizeAutoReplyGuideline", () => {
  it("trims, caps, and maps empty to null", () => {
    expect(normalizeAutoReplyGuideline("  keep it short  ")).toBe("keep it short");
    expect(normalizeAutoReplyGuideline("   ")).toBeNull();
    expect(normalizeAutoReplyGuideline("")).toBeNull();
    expect(normalizeAutoReplyGuideline(123)).toBeNull();
    expect(normalizeAutoReplyGuideline("x".repeat(MAX_GUIDELINE_LENGTH + 100))).toHaveLength(
      MAX_GUIDELINE_LENGTH,
    );
  });
});

describe("effectiveAutoReplyGuideline", () => {
  it("uses the override when present, the founder default otherwise", () => {
    expect(effectiveAutoReplyGuideline("my rules")).toBe("my rules");
    expect(effectiveAutoReplyGuideline(null)).toBe(DEFAULT_AUTO_REPLY_GUIDELINE);
    expect(effectiveAutoReplyGuideline("   ")).toBe(DEFAULT_AUTO_REPLY_GUIDELINE);
  });

  it("default carries all four founder principles", () => {
    expect(DEFAULT_AUTO_REPLY_GUIDELINE).toMatch(/polite and concise/);
    expect(DEFAULT_AUTO_REPLY_GUIDELINE).toMatch(/Never commit/);
    expect(DEFAULT_AUTO_REPLY_GUIDELINE).toMatch(/same language/);
    expect(DEFAULT_AUTO_REPLY_GUIDELINE).toMatch(/personal information/);
  });
});
