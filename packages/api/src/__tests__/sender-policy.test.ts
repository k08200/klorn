/**
 * sender-policy invariants. The short-circuit allowlists encode a safety
 * property: a sender prior may skip the LLM, but it must NEVER be able to skip
 * straight to SILENT — a stale/wrong prior that mutes a sender is a silent
 * one-way door (the user never sees the suppressed mail, so never overrides it
 * to correct the prior). These tests pin that invariant so a future edit to the
 * allowlists can't quietly reopen the door.
 */

import { describe, expect, it } from "vitest";
import {
  engagementKindOf,
  PRIOR_SHORTCIRCUIT_TIERS,
  SENDER_PRIOR_POLICY,
  type SenderFacts,
} from "../learning/sender-policy.js";

const baseFacts: SenderFacts = {
  tierHistory: {},
  manualOverrides: 0,
  interaction: null,
  commitments: null,
  engagement: null,
};

describe("engagementKindOf", () => {
  it("returns null when there's no engagement fact (or no facts at all)", () => {
    expect(engagementKindOf(null)).toBeNull();
    expect(engagementKindOf(undefined)).toBeNull();
    expect(engagementKindOf(baseFacts)).toBeNull();
  });

  it("classifies measured engagement as DIRECT", () => {
    expect(
      engagementKindOf({
        ...baseFacts,
        engagement: { importance: 0.9, outboundCount: 5, propagated: false },
      }),
    ).toBe("DIRECT");
  });

  it("classifies an inferred org prior as PROPAGATED", () => {
    expect(
      engagementKindOf({
        ...baseFacts,
        engagement: { importance: 0.4, outboundCount: 0, propagated: true },
      }),
    ).toBe("PROPAGATED");
  });
});

describe("PRIOR_SHORTCIRCUIT_TIERS", () => {
  it("never lets a prior short-circuit to SILENT (no silent one-way door)", () => {
    expect(PRIOR_SHORTCIRCUIT_TIERS.override.has("SILENT")).toBe(false);
    expect(PRIOR_SHORTCIRCUIT_TIERS.history.has("SILENT")).toBe(false);
  });

  it("never lets a prior short-circuit to AUTO (floors are the LLM's job)", () => {
    expect(PRIOR_SHORTCIRCUIT_TIERS.override.has("AUTO")).toBe(false);
    expect(PRIOR_SHORTCIRCUIT_TIERS.history.has("AUTO")).toBe(false);
  });

  it("only an override prior (not history) may short-circuit to PUSH", () => {
    expect(PRIOR_SHORTCIRCUIT_TIERS.override.has("PUSH")).toBe(true);
    expect(PRIOR_SHORTCIRCUIT_TIERS.history.has("PUSH")).toBe(false);
  });

  it("both kinds may short-circuit to QUEUE", () => {
    expect(PRIOR_SHORTCIRCUIT_TIERS.override.has("QUEUE")).toBe(true);
    expect(PRIOR_SHORTCIRCUIT_TIERS.history.has("QUEUE")).toBe(true);
  });
});

describe("SENDER_PRIOR_POLICY", () => {
  it("requires a stronger signal for history than for overrides", () => {
    // A user correction is worth more than passive history, so the history bar
    // (count) must be at least as high as the override bar.
    expect(SENDER_PRIOR_POLICY.historyMin).toBeGreaterThanOrEqual(SENDER_PRIOR_POLICY.overrideMin);
  });

  it("keeps the few-shot cap within the correction pool it samples from", () => {
    expect(SENDER_PRIOR_POLICY.maxFewShot).toBeLessThanOrEqual(
      SENDER_PRIOR_POLICY.correctionPoolSize,
    );
  });
});
