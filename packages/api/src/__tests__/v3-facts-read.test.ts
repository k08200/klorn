/**
 * Reading stored v3 facts back for the live decision and replay
 * (facts-store.ts parseStoredFacts). Stored JSON is not trusted blindly: a
 * row at another facts version, or one whose facts fail the v1 validator,
 * reads as "no LLM facts".
 */

import { describe, expect, it } from "vitest";
import { FACTS_VERSION } from "../judge/v3/facts-schema.js";
import { parseStoredFacts, type StoredFactsRow } from "../judge/v3/facts-store.js";
import type { FactsV1 } from "../judge/v3/policy-types.js";
import { UNKNOWN_RELATIONSHIP } from "../judge/v3/relationship.js";

const FACTS: FactsV1 = {
  asks: [
    {
      kind: "reply",
      object: "the contract",
      due: "2026-11-03T18:00:00+09:00",
      evidence: "by 6pm today",
    },
  ],
  addressedTo: "me_direct",
  threadTurn: "theirs",
  event: null,
  transaction: null,
  risk: [],
  kind: "work_thread",
  ambiguous: false,
};

const SIGNALS = { automatedSender: false, spam: true, listMail: false };

function row(over: Partial<StoredFactsRow> = {}): StoredFactsRow {
  return {
    factsVersion: FACTS_VERSION,
    factsSource: "llm",
    facts: FACTS,
    certainFields: ["addressedTo"],
    signals: SIGNALS,
    relationship: { ...UNKNOWN_RELATIONSHIP, sentCount: 3 },
    ...over,
  };
}

describe("parseStoredFacts", () => {
  it("returns LLM facts, the certain pre-facts, signals and relationship", () => {
    const s = parseStoredFacts(row());
    expect(s.factsSource).toBe("llm");
    expect(s.facts).toEqual(FACTS);
    expect(s.pre?.certain).toEqual(["addressedTo"]);
    expect(s.pre?.facts).toEqual({ addressedTo: "me_direct" });
    expect(s.signals?.spam).toBe(true);
    expect(s.relationship?.sentCount).toBe(3);
  });

  it("a 'none' row has no LLM facts but keeps its certain pre-facts", () => {
    const s = parseStoredFacts(
      row({ factsSource: "none", facts: { addressedTo: "bulk" }, certainFields: ["addressedTo"] }),
    );
    expect(s.factsSource).toBe("none");
    expect(s.facts).toBeNull();
    expect(s.pre?.facts).toEqual({ addressedTo: "bulk" });
  });

  it("reads LLM facts at another version, or invalid ones, as no LLM facts", () => {
    expect(parseStoredFacts(row({ factsVersion: FACTS_VERSION + 1 })).facts).toBeNull();
    expect(parseStoredFacts(row({ facts: { ...FACTS, kind: "spaceship" } })).facts).toBeNull();
    expect(parseStoredFacts(row({ facts: "not an object" })).facts).toBeNull();
  });

  it("drops certain fields that are unknown or whose stored value is invalid", () => {
    const s = parseStoredFacts(
      row({
        factsSource: "none",
        facts: { addressedTo: "everyone", kind: "notification" },
        certainFields: ["addressedTo", "kind", "colour"],
      }),
    );
    expect(s.pre?.certain).toEqual(["kind"]);
    expect(s.pre?.facts).toEqual({ kind: "notification" });
  });

  it("tolerates missing signals and relationship", () => {
    const s = parseStoredFacts(row({ signals: null, relationship: null }));
    expect(s.signals).toBeNull();
    expect(s.relationship).toBeNull();
  });
});
