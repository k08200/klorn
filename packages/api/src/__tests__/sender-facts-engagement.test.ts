import { describe, expect, it } from "vitest";
import { buildSenderFactsBlock, type SenderFacts } from "../poc-judge.js";

const base: SenderFacts = {
  tierHistory: {},
  manualOverrides: 0,
  interaction: null,
  commitments: null,
  engagement: null,
};

describe("buildSenderFactsBlock — learned engagement grounding", () => {
  it("renders a measured engagement fact (replied N times) when present", () => {
    const block = buildSenderFactsBlock({
      ...base,
      engagement: { importance: 0.9, outboundCount: 5 },
    });
    expect(block).toContain("strongly engages");
    expect(block).toContain("5 times");
    expect(block).toContain("matters to them");
  });

  it("uses a softer qualifier for low importance and singular for one engagement", () => {
    const block = buildSenderFactsBlock({
      ...base,
      engagement: { importance: 0.2, outboundCount: 1 },
    });
    expect(block).toContain("sometimes engages");
    expect(block).toContain("1 time");
    expect(block).not.toContain("1 times");
  });

  it("renders nothing when there is no engagement (dark-ship default)", () => {
    expect(buildSenderFactsBlock(base)).toBe("");
  });
});
