import { describe, expect, it } from "vitest";
import { parseAiSummary } from "../email-summarize.js";

/**
 * parseAiSummary is the pure parse seam for the email summary LLM call. It must
 * keep every field inside its declared contract: a :free model can return a
 * hallucinated enum or a non-array where an array is required, which the old
 * `parsed.x || default` passed straight through (only catching falsy values).
 */
describe("parseAiSummary shape validation", () => {
  it("passes a well-formed response through unchanged", () => {
    const r = parseAiSummary(
      JSON.stringify({
        summary: "A short summary",
        category: "billing",
        keyPoints: ["a", "b"],
        actionItems: ["do x"],
        sentiment: "positive",
        priority: "URGENT",
      }),
      "subject fallback",
    );
    expect(r).toEqual({
      summary: "A short summary",
      category: "billing",
      keyPoints: ["a", "b"],
      actionItems: ["do x"],
      sentiment: "positive",
      priority: "URGENT",
    });
  });

  it("rejects hallucinated enums and non-array fields", () => {
    const r = parseAiSummary(
      JSON.stringify({
        summary: "ok",
        sentiment: "angry", // not in the union
        priority: "ULTRA_URGENT", // not in the union
        keyPoints: "not-an-array",
        actionItems: [1, "keep", null],
      }),
      "fallback",
    );
    expect(r.sentiment).toBe("neutral");
    expect(r.priority).toBe("NORMAL");
    expect(r.keyPoints).toEqual([]);
    expect(r.actionItems).toEqual(["keep"]);
  });

  it("falls back to the subject when summary is missing or non-string", () => {
    const r = parseAiSummary(JSON.stringify({ summary: 123 }), "the subject");
    expect(r.summary).toBe("the subject");
    expect(r.category).toBe("other");
  });

  it("returns safe defaults on non-JSON content", () => {
    const r = parseAiSummary("not json at all", "subj");
    expect(r).toEqual({
      summary: "subj",
      category: "other",
      keyPoints: [],
      actionItems: [],
      sentiment: "neutral",
      priority: "NORMAL",
    });
  });
});
