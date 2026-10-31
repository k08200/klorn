import { describe, expect, it, vi } from "vitest";
import type { FactsExtraction } from "../judge/v3/facts-extractor.js";
import { saveAttentionFacts, toAttentionFactsData } from "../judge/v3/facts-store.js";
import { parseRelationshipSnapshot, type RelationshipSnapshot } from "../judge/v3/relationship.js";

const extraction = (over: Partial<FactsExtraction> = {}): FactsExtraction => ({
  facts: {
    asks: [
      { kind: "reply", object: "confirm date", due: null, evidence: "could you confirm the date" },
    ],
    addressedTo: "me_direct",
    threadTurn: "mine_to_reply",
    event: null,
    transaction: null,
    risk: [],
    kind: "work_thread",
    ambiguous: false,
  },
  source: "llm",
  preFacts: { addressedTo: "me_direct" },
  signals: {
    automatedSender: false,
    noReplySender: false,
    transactionalSender: false,
    clearMarketing: false,
    listMail: false,
    autoSubmitted: false,
    spam: false,
    gmailCategory: "CATEGORY_PERSONAL",
    icsInvite: false,
    inviteSubject: false,
    schedulingIntent: false,
    toCount: 1,
    ccCount: 0,
    userInTo: true,
    userInCc: false,
    otherRecipients: 0,
  },
  model: "claude-haiku-5-5",
  provider: "anthropic",
  servedByUserKey: false,
  issues: [],
  evidenceCheck: { checked: 1, dropped: [] },
  escalate: false,
  escalateReasons: [],
  certain: ["addressedTo"],
  ...over,
});

const rel: RelationshipSnapshot = {
  sentCount: 3,
  lastSentAt: "2026-10-20T00:00:00.000Z",
  medianReplyLatencyMs: 7_200_000,
  sameOrgDomain: false,
  coAttendanceNext14d: null,
  pinned: false,
  vip: null,
  dismissCount: 0,
};

const at = new Date("2026-10-31T01:00:00Z");

describe("toAttentionFactsData", () => {
  it("maps an extraction to the row, with factsVersion and provenance", () => {
    const d = toAttentionFactsData({
      userId: "u1",
      source: "EMAIL",
      sourceId: "e1",
      extraction: extraction(),
      relationship: rel,
      v2Tier: "QUEUE",
      extractedAt: at,
    });
    expect(d).toMatchObject({
      userId: "u1",
      source: "EMAIL",
      sourceId: "e1",
      factsVersion: 1,
      factsSource: "llm",
      model: "claude-haiku-5-5",
      provider: "anthropic",
      extractedAt: at,
      certainFields: ["addressedTo"],
      escalate: false,
      escalateReasons: [],
      v2Tier: "QUEUE",
    });
    expect(d.facts).toEqual(extraction().facts);
    expect(d.relationship).toEqual(rel);
  });

  it("stores a no-LLM row as factsSource none with only the certain pre-facts", () => {
    const d = toAttentionFactsData({
      userId: "u1",
      source: "EMAIL",
      sourceId: "e1",
      extraction: extraction({ facts: null, source: "none", model: null, provider: null }),
      relationship: null,
      v2Tier: "QUEUE",
      extractedAt: at,
    });
    expect(d.factsSource).toBe("none");
    expect(d.facts).toEqual({ addressedTo: "me_direct" });
    expect(d.signals).toMatchObject({ userInTo: true, spam: false });
  });

  it("bounds the issue list so provider error text cannot bloat the row", () => {
    const issues = Array.from({ length: 50 }, (_, i) => `attempt ${i}: ${"x".repeat(1000)}`);
    const d = toAttentionFactsData({
      userId: "u1",
      source: "EMAIL",
      sourceId: "e1",
      extraction: extraction({ issues }),
      relationship: null,
      v2Tier: null,
      extractedAt: at,
    });
    expect(d.issues).toHaveLength(20);
    expect(Math.max(...(d.issues as string[]).map((s) => s.length))).toBeLessThanOrEqual(200);
  });
});

describe("saveAttentionFacts", () => {
  it("upserts on the item's natural key so a rerun replaces, never duplicates", async () => {
    const upsert = vi.fn(async () => ({}));
    await saveAttentionFacts(
      {
        userId: "u1",
        source: "EMAIL",
        sourceId: "e1",
        extraction: extraction(),
        relationship: rel,
        v2Tier: "QUEUE",
        extractedAt: at,
      },
      { attentionFacts: { upsert } } as never,
    );
    const [arg] = upsert.mock.calls[0] as unknown as [
      { where: unknown; create: Record<string, unknown>; update: Record<string, unknown> },
    ];
    expect(arg.where).toEqual({
      userId_source_sourceId: { userId: "u1", source: "EMAIL", sourceId: "e1" },
    });
    expect(arg.create.userId).toBe("u1");
    expect(arg.update).not.toHaveProperty("userId");
    expect(arg.update).not.toHaveProperty("sourceId");
    expect(arg.update.factsSource).toBe("llm");
  });
});

describe("parseRelationshipSnapshot", () => {
  it("round-trips a stored snapshot and rejects malformed JSON", () => {
    expect(parseRelationshipSnapshot(JSON.parse(JSON.stringify(rel)))).toEqual(rel);
    expect(parseRelationshipSnapshot(null)).toBeNull();
    expect(parseRelationshipSnapshot({ ...rel, sentCount: "3" })).toBeNull();
    expect(parseRelationshipSnapshot({ ...rel, pinned: 1 })).toBeNull();
    expect(parseRelationshipSnapshot({ ...rel, lastSentAt: "yesterday" })).toBeNull();
  });
});
