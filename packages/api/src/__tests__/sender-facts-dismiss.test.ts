/**
 * P0-B slice 2 (consume): a dismissed-only sender grounds a NEGATIVE
 * engagement fact for the judge's senderTrust. Covers the two pure surfaces —
 * engagementKindOf (ledger classification) and buildSenderFactsBlock (the
 * prompt rendering). Flag-gated end-to-end (CONTACT_ENGAGEMENT_IN_JUDGE), so
 * this only reaches the prompt when a real engagement fact is built.
 */

import { describe, expect, it } from "vitest";
import { buildSenderFactsBlock } from "../poc-judge.js";
import { engagementKindOf, type SenderFacts } from "../sender-policy.js";

const facts = (engagement: SenderFacts["engagement"]): SenderFacts => ({
  tierHistory: {} as SenderFacts["tierHistory"],
  manualOverrides: 0,
  interaction: null,
  commitments: null,
  engagement,
});

describe("engagementKindOf", () => {
  it("classifies a dismissed-only sender as DISMISSED", () => {
    expect(
      engagementKindOf(
        facts({ importance: 0, outboundCount: 0, dismissCount: 4, propagated: false }),
      ),
    ).toBe("DISMISSED");
  });

  it("classifies an engaged sender as DIRECT even if also dismissed once", () => {
    expect(
      engagementKindOf(
        facts({ importance: 0.8, outboundCount: 5, dismissCount: 1, propagated: false }),
      ),
    ).toBe("DIRECT");
  });

  it("classifies an org-propagated prior as PROPAGATED", () => {
    expect(engagementKindOf(facts({ importance: 0.3, outboundCount: 0, propagated: true }))).toBe(
      "PROPAGATED",
    );
  });

  it("returns null when there is no engagement fact", () => {
    expect(engagementKindOf(facts(null))).toBeNull();
  });
});

describe("buildSenderFactsBlock — dismissed-only rendering", () => {
  it("renders a measured negative line for a dismissed-only sender", () => {
    const block = buildSenderFactsBlock(
      facts({ importance: 0, outboundCount: 0, dismissCount: 5, propagated: false }),
    );
    expect(block).toContain("dismissed this sender's mail 5 times");
    expect(block).toContain("low-importance");
    // Hedged so a genuinely urgent email can still override the prior.
    expect(block).toContain("unless the email itself is clearly urgent");
    // Must NOT claim positive engagement.
    expect(block).not.toContain("strong signal this sender matters");
  });

  it("still renders the positive line for an engaged sender", () => {
    const block = buildSenderFactsBlock(
      facts({ importance: 0.9, outboundCount: 6, dismissCount: 0, propagated: false }),
    );
    expect(block).toContain("strongly engages with this sender");
    expect(block).not.toContain("dismissed this sender");
  });

  it("singularizes a single dismiss", () => {
    const block = buildSenderFactsBlock(
      facts({ importance: 0, outboundCount: 0, dismissCount: 1, propagated: false }),
    );
    expect(block).toContain("dismissed this sender's mail 1 time ");
  });
});
