// Pins packages/web/src/lib/source-provider.ts (SourceBadge glyphs) and the
// web toLiveTier fold used by LaneChip. Run from the api suite because the web
// package has no unit-test runner (see web-tool-labels.test.ts).
import { describe, expect, it } from "vitest";
import { sourceGlyph, sourceLabel } from "../../../web/src/lib/source-provider";
import { toLiveTier } from "../../../web/src/lib/tiers";
import { toLiveTier as apiToLiveTier } from "../judge/tiers";

describe("sourceGlyph", () => {
  it.each([
    ["GOOGLE", "G", "Google"],
    ["OUTLOOK", "M", "Microsoft"],
    ["NAVER", "N", "Naver"],
    ["ICLOUD", "iC", "iCloud"],
    ["IMAP", "IMAP", "IMAP"],
    ["KLORN", "K", "Klorn"],
  ])("maps %s to the %s monogram", (provider, glyph, name) => {
    expect(sourceGlyph(provider)).toEqual({ glyph, name });
  });

  it("is case-insensitive", () => {
    expect(sourceGlyph("google").glyph).toBe("G");
  });

  it("falls back to the generic glyph for unknown or missing providers", () => {
    expect(sourceGlyph("YAHOO")).toEqual({ glyph: "IMAP", name: "Mail" });
    expect(sourceGlyph(null).glyph).toBe("IMAP");
    expect(sourceGlyph("").glyph).toBe("IMAP");
  });
});

describe("sourceLabel", () => {
  it("spells the provider out with an optional nickname", () => {
    expect(sourceLabel("GOOGLE", "work@")).toBe("From Google · work@");
    expect(sourceLabel("NAVER")).toBe("From Naver");
    expect(sourceLabel("NAVER", "   ")).toBe("From Naver");
    expect(sourceLabel("UNKNOWN")).toBe("From Mail");
  });
});

describe("web toLiveTier", () => {
  it.each([
    "PUSH",
    "MEETING",
    "QUEUE",
    "INFO",
    "SILENT",
    "AUTO",
    "CALL",
    "BOGUS",
    "",
  ])("agrees with the API fold for %j", (value) => {
    expect(toLiveTier(value)).toBe(apiToLiveTier(value));
  });

  it("never yields a retired lane", () => {
    expect(toLiveTier("AUTO")).toBe("QUEUE");
    expect(toLiveTier("CALL")).toBe("PUSH");
  });
});
