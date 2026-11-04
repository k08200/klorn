/**
 * The P1 harness's evidence adapter over the P2 extractor's rules
 * (src/judge/v3/evidence.ts, #1587). Normalisation, quote weight, word edges
 * and TEMPORAL_RE are P2's and are tested in P2's suite; these tests pin only
 * what the harness adds: per-field haystacks and the counts the report uses.
 */
import { describe, expect, it } from "vitest";
import { applyEvidenceCheck, evidenceHaystack } from "../eval-v3/evidence.js";
import type { FactsV1 } from "../judge/v3/facts-schema.js";

const VALID: FactsV1 = {
  asks: [
    {
      kind: "reply",
      object: "the updated deck",
      due: "2026-06-01T23:59:00Z",
      evidence: "can you send the latest deck today?",
    },
  ],
  addressedTo: "me_direct",
  threadTurn: "mine_to_reply",
  event: null,
  transaction: null,
  risk: [],
  kind: "work_thread",
  ambiguous: false,
};

describe("evidenceHaystack", () => {
  it("keeps every field shown to the model as its own normalised part", () => {
    const h = evidenceHaystack(["Need the Deck", "", "Partner meeting moved up"]);
    expect(h.parts).toEqual(["need the deck", "partner meeting moved up"]);
  });
});

describe("applyEvidenceCheck (counts the report uses)", () => {
  const fields = [
    "Need the updated deck today",
    "Partner meeting moved up — can you send the latest deck today?",
  ];

  it("drops an ask whose evidence is not in any field and counts valid/total", () => {
    const facts: FactsV1 = {
      ...VALID,
      asks: [VALID.asks[0], { ...VALID.asks[0], evidence: "please wire the funds now" }],
    };
    const out = applyEvidenceCheck(facts, fields);
    expect(out.facts.asks).toHaveLength(1);
    expect(out).toMatchObject({ evidenceTotal: 2, evidenceValid: 1, dueUnbound: 0 });
  });

  it("keeps an ask but nulls a due whose quote states no time, and counts it separately", () => {
    const facts: FactsV1 = {
      ...VALID,
      asks: [
        { ...VALID.asks[0], evidence: "can you send the latest deck" },
        { ...VALID.asks[0], evidence: "send the latest deck today?" },
      ],
    };
    const out = applyEvidenceCheck(facts, fields);
    expect(out.facts.asks.map((a) => a.due)).toEqual([null, "2026-06-01T23:59:00Z"]);
    expect(out).toMatchObject({ evidenceTotal: 2, evidenceValid: 2, dueUnbound: 1 });
  });

  it("never lets a quote stitch two fields together", () => {
    const facts: FactsV1 = {
      ...VALID,
      asks: [{ ...VALID.asks[0], evidence: "send the file by tomorrow morning" }],
    };
    expect(
      applyEvidenceCheck(facts, ["please send the file", "by tomorrow morning"]).evidenceValid,
    ).toBe(0);
    expect(
      applyEvidenceCheck(facts, ["subject", "please send the file by tomorrow morning"])
        .evidenceValid,
    ).toBe(1);
  });

  it("returns new objects and leaves the input untouched", () => {
    const facts: FactsV1 = { ...VALID, asks: [{ ...VALID.asks[0] }] };
    const out = applyEvidenceCheck(facts, ["nothing relevant here at all"]);
    expect(out.facts).not.toBe(facts);
    expect(facts.asks).toHaveLength(1);
  });
});
