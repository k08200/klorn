/**
 * Semantic correction re-ranking (Phase 3a). Forces embeddings ON via a partial
 * mock of ../embedding.js (real cosineSimilarity/rankBySimilarity kept; only the
 * network embedText/isEmbeddingEnabled overridden) and asserts the incoming
 * email's semantic nearest correction outranks the lexical same-sender one.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const attentionFindMany = vi.hoisted(() => vi.fn());
const emailFindMany = vi.hoisted(() => vi.fn());
const embedTextsMock = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({
  db: {
    attentionItem: { findMany: attentionFindMany },
    emailMessage: { findMany: emailFindMany },
  },
  prisma: {},
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../learning/trust-score.js", () => ({ getTrustScore: vi.fn(async () => null) }));
vi.mock("../learning/interaction-graph.js", () => ({
  getCachedInteractionNode: vi.fn(async () => null),
}));

// Partial mock: keep the real pure math, override only the model-facing parts.
vi.mock("../embedding.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../embedding.js")>();
  return { ...actual, isEmbeddingEnabled: () => true, embedTexts: embedTextsMock };
});

import { buildJudgeContext } from "../judge-context.js";

beforeEach(() => {
  attentionFindMany.mockReset();
  emailFindMany.mockReset();
  embedTextsMock.mockReset();
  // No sender history; only the corrections pool matters here.
  attentionFindMany.mockImplementation((args: { where: Record<string, unknown> }) =>
    "isManualOverride" in args.where
      ? Promise.resolve([
          { sourceId: "near", tier: "PUSH" },
          { sourceId: "far", tier: "QUEUE" },
        ])
      : Promise.resolve([]),
  );
  emailFindMany.mockImplementation((args: { where: Record<string, unknown> }) =>
    "from" in args.where
      ? Promise.resolve([])
      : Promise.resolve([
          // "far" is the SAME sender as the incoming email (lexical would rank it #1).
          { id: "far", from: "Alice <alice@corp.com>", subject: "quarterly board deck review" },
          // "near" is a DIFFERENT sender but semantically closest to the query.
          { id: "near", from: "Bob <bob@elsewhere.com>", subject: "can you review the PR today" },
        ]),
  );
});

describe("semantic correction re-ranking", () => {
  it("ranks by embedding similarity, overriding the lexical same-sender order", () => {
    // Query [1,0]; make the "elsewhere" (near) candidate identical to the query
    // and the same-sender (far) candidate orthogonal. Real rankBySimilarity then
    // puts `near` first — proving semantic beat lexical.
    embedTextsMock.mockImplementation(async (texts: string[]) =>
      texts.map((t, i) => {
        if (i === 0) return [1, 0]; // the incoming email (query)
        return t.includes("elsewhere") ? [1, 0] : [0, 1];
      }),
    );

    return buildJudgeContext("u1", {
      from: "Alice <alice@corp.com>",
      subject: "please review the PR today",
    }).then((ctx) => {
      expect(ctx.corrections[0].from).toContain("elsewhere");
      expect(ctx.corrections.map((c) => c.tier)).toEqual(["PUSH", "QUEUE"]);
    });
  });

  it("falls back to lexical ranking when the query embedding fails (null)", async () => {
    // embedText query returns null → semanticRankCorrections returns null →
    // deterministic lexical ranking (same sender first) is used instead.
    embedTextsMock.mockImplementation(async (texts: string[]) => texts.map(() => null));
    const ctx = await buildJudgeContext("u1", {
      from: "Alice <alice@corp.com>",
      subject: "please review the PR today",
    });
    // Lexical: same-sender "far" (Alice) ranks first.
    expect(ctx.corrections[0].from).toContain("alice@corp.com");
  });
});
