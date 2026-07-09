/**
 * Flip-gate integration test for learned contact-engagement.
 *
 * The unit tests cover each piece in isolation; this one locks the WHOLE path
 * with the flag flipped ON — the state the founder will ship. It exercises the
 * real wiring: buildJudgeContext → fetchLearnedImportanceFact → (real)
 * propagatedImportanceForDomain → SenderFacts → poc-judge.buildSenderFactsBlock,
 * asserting the engagement grounding text actually reaches the judge prompt for
 * both a directly-engaged sender and a cold-start org peer.
 *
 * Only the cache read (getCachedInteractionGraph) and the flag are stubbed; the
 * pure helpers stay real so a regression in the discount/denylist/direct-wins
 * logic would fail here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InteractionGraph } from "../interaction-graph.js";

const getGraphMock = vi.hoisted(() => vi.fn());

// Isolate the engagement branch: no corrections, no sender history, no traits.
vi.mock("../db.js", () => ({
  db: {
    attentionItem: { findMany: vi.fn(async () => []) },
    emailMessage: { findMany: vi.fn(async () => []) },
  },
  prisma: {},
}));

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../trust-score.js", () => ({ getTrustScore: vi.fn(async () => null) }));
vi.mock("../sender-trait-store.js", () => ({ getActiveSenderTraits: vi.fn(async () => []) }));
vi.mock("../learned-rule-store.js", () => ({ getAppliedRulesForMatch: vi.fn(async () => []) }));

// The flip: engagement grounding ON. Everything else in config stays real.
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, CONTACT_ENGAGEMENT_IN_JUDGE: true };
});

// Stub ONLY the cache read — keep propagatedImportanceForDomain / nodeMatchesEmail real.
vi.mock("../interaction-graph.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../interaction-graph.js")>();
  return { ...actual, getCachedInteractionGraph: getGraphMock };
});

import { CONTACT_ENGAGEMENT_IN_JUDGE } from "../config.js";
import { buildJudgeContext } from "../judge-context.js";
import { buildSenderFactsBlock } from "../poc-judge.js";

const BUILT_AT = new Date("2026-06-12T00:00:00Z").toISOString();

beforeEach(() => {
  getGraphMock.mockReset();
});

function graphWith(partial: Partial<InteractionGraph>): InteractionGraph {
  return { nodes: [], builtAt: BUILT_AT, ...partial };
}

describe("engagement flip gate — full judge-context → prompt path", () => {
  it("the mock actually flips the flag on", () => {
    expect(CONTACT_ENGAGEMENT_IN_JUDGE).toBe(true);
  });

  it("renders a DIRECT measured engagement fact into the prompt, even when the org also has a prior", async () => {
    getGraphMock.mockResolvedValue(
      graphWith({
        nodes: [
          {
            email: "alice@acme.com",
            name: "Alice",
            score: 70,
            emailCount: 20,
            lastEmailDaysAgo: 1,
            upcomingMeetings: 0,
            tags: ["you_engage"],
            learnedImportance: 0.9,
            outboundCount: 5,
          },
        ],
        // Direct engagement must win over this org-level prior for the same domain.
        orgImportance: { "acme.com": 1 },
      }),
    );

    const ctx = await buildJudgeContext("u1", { from: "Alice <alice@acme.com>" });
    expect(ctx.senderFacts?.engagement).toEqual({
      importance: 0.9,
      outboundCount: 5,
      propagated: false,
    });

    const block = buildSenderFactsBlock(ctx.senderFacts);
    expect(block).toContain("strongly engages");
    expect(block).toContain("5 times");
    expect(block).not.toContain("organization");
  });

  it("renders a PROPAGATED cold-start prior for an unseen sender at an engaged org", async () => {
    getGraphMock.mockResolvedValue(
      // No node for bob — only an org-level signal (≥2 engaged peers already
      // enforced at build time; here we assert the consumption side).
      graphWith({ orgImportance: { "acme.com": 1 } }),
    );

    const ctx = await buildJudgeContext("u1", { from: "bob@acme.com" });
    expect(ctx.senderFacts?.engagement).toEqual({
      importance: 0.4, // 1.0 × PROPAGATION_DISCOUNT
      outboundCount: 0,
      propagated: true,
    });

    const block = buildSenderFactsBlock(ctx.senderFacts);
    expect(block).toContain("other people at this sender's organization");
    expect(block).toContain("weigh it lightly");
    // A propagated prior must never masquerade as a measured reply.
    expect(block).not.toContain("has replied to or written them");
    expect(block).not.toContain("strongly engages");
  });

  it("does NOT propagate across a public mail provider, even with the flag on", async () => {
    getGraphMock.mockResolvedValue(graphWith({ orgImportance: { "gmail.com": 1 } }));

    const ctx = await buildJudgeContext("u1", { from: "stranger@gmail.com" });
    expect(ctx.senderFacts).toBeNull();
    expect(buildSenderFactsBlock(ctx.senderFacts)).toBe("");
  });

  it("yields no engagement fact when there's neither a node nor an org prior", async () => {
    getGraphMock.mockResolvedValue(graphWith({ orgImportance: {} }));

    const ctx = await buildJudgeContext("u1", { from: "nobody@unknown.io" });
    expect(ctx.senderFacts).toBeNull();
  });
});
