/**
 * Read-behavior grounding (engagement channel, CONTACT_ENGAGEMENT_IN_JUDGE):
 * per-sender read rate rendered into the judge prompt as a SOFT senderTrust
 * fact. Motivated by the 2026-07-16 real-mail measurement: the founder reads
 * 100% of two buried-as-SILENT senders and 4% of another — a measured signal
 * the engagement channel (outbound replies + dismisses only) was blind to.
 *
 * Pure render surface only — the fetch path is covered by
 * judge-context-read-behavior.test.ts.
 */

import { describe, expect, it } from "vitest";
import { buildSenderFactsBlock } from "../judge/poc-judge.js";
import type { SenderFacts } from "../learning/sender-policy.js";

const facts = (readBehavior: SenderFacts["readBehavior"]): SenderFacts => ({
  tierHistory: {} as SenderFacts["tierHistory"],
  manualOverrides: 0,
  interaction: null,
  commitments: null,
  engagement: null,
  readBehavior,
});

describe("buildSenderFactsBlock — read-behavior rendering", () => {
  it("renders a positive attention line for a high read rate", () => {
    const block = buildSenderFactsBlock(facts({ read: 12, total: 12 }));
    expect(block).toContain("reads nearly every email from this sender (12 of the last 12)");
    // Soft grounding, not a tier instruction.
    expect(block).toContain("senderTrust");
    expect(block).not.toMatch(/\bSILENT\b.*\bnever\b/);
  });

  it("renders a measured low-attention line for a low read rate", () => {
    const block = buildSenderFactsBlock(facts({ read: 1, total: 25 }));
    expect(block).toContain("rarely opens this sender's email (1 of the last 25)");
    // Hedged: urgency must still be able to win.
    expect(block).toContain("unless the email itself is clearly urgent");
  });

  it("renders a plain neutral count for a middling read rate", () => {
    const block = buildSenderFactsBlock(facts({ read: 5, total: 10 }));
    expect(block).toContain("Reads 5 of the last 10 emails from this sender");
  });

  it("renders nothing read-related when the fact is absent", () => {
    expect(buildSenderFactsBlock(facts(null))).not.toContain("last");
    expect(buildSenderFactsBlock(facts(undefined))).not.toContain("last");
  });
});
