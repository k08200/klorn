import { describe, expect, it } from "vitest";
import {
  filterSuppressedContextItems,
  formatRecentProposalSuppressions,
  type RecentProposalSuppression,
  safeJson,
  shouldSuppressContextText,
} from "../agent-proposal-dedup.js";

function suppression(
  overrides: Partial<RecentProposalSuppression> = {},
): RecentProposalSuppression {
  return {
    id: "p-1",
    toolName: "send_email",
    status: "PENDING",
    createdAt: new Date(Date.now() - 30 * 60 * 1000), // 30m ago
    message: "Follow up with Alpha Capital about the SAFE",
    toolArgs: { to: "mina@alpha-capital.com" },
    tokens: new Set(["alpha", "capital", "safe", "mina"]),
    ...overrides,
  };
}

describe("safeJson", () => {
  it("parses well-formed JSON", () => {
    expect(safeJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns empty object literal output for empty input", () => {
    expect(safeJson("")).toEqual({});
  });

  it("returns the raw value when parsing fails", () => {
    expect(safeJson("not-json")).toBe("not-json");
  });
});

describe("shouldSuppressContextText", () => {
  it("returns false when there are no suppressions", () => {
    expect(shouldSuppressContextText("anything", [])).toBe(false);
  });

  it("returns false for empty or whitespace text even with active suppressions", () => {
    expect(shouldSuppressContextText("", [suppression()])).toBe(false);
    expect(shouldSuppressContextText("   ", [suppression()])).toBe(false);
  });

  it("suppresses text that overlaps suppression anchors", () => {
    // areSimilarProposalIssues is implemented in agent-logic.ts and matches
    // on shared anchor tokens — "alpha capital" is in the suppression, so
    // a context item mentioning Alpha Capital must be hidden from the LLM.
    expect(
      shouldSuppressContextText("Email from Alpha Capital about the SAFE", [suppression()]),
    ).toBe(true);
  });

  it("does not suppress unrelated text", () => {
    expect(
      shouldSuppressContextText("Random calendar event with no overlap", [suppression()]),
    ).toBe(false);
  });
});

describe("filterSuppressedContextItems", () => {
  it("returns the input array verbatim when suppressions are empty", () => {
    const items = [{ text: "a" }, { text: "b" }];
    const result = filterSuppressedContextItems(items, (i) => i.text, []);
    expect(result.visible).toEqual(items);
    expect(result.hidden).toBe(0);
  });

  it("partitions items into visible vs hidden", () => {
    const items = [
      { text: "Email from Alpha Capital about the SAFE" },
      { text: "Unrelated reminder about lunch" },
    ];
    const result = filterSuppressedContextItems(items, (i) => i.text, [suppression()]);
    expect(result.visible).toEqual([{ text: "Unrelated reminder about lunch" }]);
    expect(result.hidden).toBe(1);
  });
});

describe("formatRecentProposalSuppressions", () => {
  it("returns empty string when no suppressions", () => {
    expect(formatRecentProposalSuppressions([])).toBe("");
  });

  it("renders the block with anchors and age", () => {
    const out = formatRecentProposalSuppressions([suppression()]);
    expect(out).toContain("Suppressed Recent Proposal Topics");
    expect(out).toContain("send_email");
    expect(out).toContain("anchors:");
    // 30-minute age renders as "30m ago" (allow rounding ±1m)
    expect(out).toMatch(/(29|30|31)m ago/);
  });

  it("caps the list at 8 rows even with more suppressions", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      suppression({ id: `p-${i}`, toolName: `tool_${i}` }),
    );
    const out = formatRecentProposalSuppressions(many);
    // 12 inputs but only 8 lines should render; counting tool_N prefixes:
    const toolMatches = out.match(/tool_\d+/g) ?? [];
    expect(toolMatches).toHaveLength(8);
  });
});
