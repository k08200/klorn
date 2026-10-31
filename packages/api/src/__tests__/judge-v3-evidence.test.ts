import { describe, expect, it } from "vitest";
import {
  buildEvidenceHaystack,
  normaliseForEvidence,
  verifyEvidence,
  verifyFactsEvidence,
} from "../judge/v3/evidence.js";
import type { FactsV1 } from "../judge/v3/facts-schema.js";

const base: FactsV1 = {
  asks: [],
  addressedTo: "me_direct",
  threadTurn: "mine_to_reply",
  event: null,
  transaction: null,
  risk: [],
  kind: "work_thread",
  ambiguous: false,
};

describe("normaliseForEvidence", () => {
  it("folds case, NFKC width, curly quotes, dashes, zero-width chars and whitespace runs", () => {
    expect(normaliseForEvidence("  Please  CONFIRM\n\t by “Tuesday” — ok​ ")).toBe(
      'please confirm by "tuesday" - ok',
    );
    expect(normaliseForEvidence("ＡＢＣ１２３")).toBe("abc123");
    expect(normaliseForEvidence("it’s")).toBe("it's");
    expect(normaliseForEvidence("re­view")).toBe("review");
  });
});

describe("verifyEvidence", () => {
  const hay = buildEvidenceHaystack(
    "Contract — next steps",
    "Hi,\n\nCould you please   confirm by Tuesday 6pm?\n오늘 6시까지 회신 부탁드립니다.",
  );

  it("accepts a verbatim quote, tolerant only of case/whitespace/punctuation folding", () => {
    expect(verifyEvidence("could you please confirm by Tuesday 6pm", hay)).toBe(true);
    expect(verifyEvidence("Contract - next steps", hay)).toBe(true);
    expect(verifyEvidence("오늘 6시까지 회신 부탁드립니다", hay)).toBe(true);
  });

  it("rejects paraphrase and invented text", () => {
    expect(verifyEvidence("please confirm before Tuesday", hay)).toBe(false);
    expect(verifyEvidence("wire the payment today", hay)).toBe(false);
  });

  it("rejects quotes that are too short to ground anything, and over-long ones", () => {
    expect(verifyEvidence("hi", hay)).toBe(false);
    expect(verifyEvidence("", hay)).toBe(false);
    expect(verifyEvidence("x".repeat(301), "x".repeat(400))).toBe(false);
  });

  it("does not let a quote span the subject/body boundary", () => {
    expect(verifyEvidence("next steps hi", hay)).toBe(false);
  });
});

describe("verifyFactsEvidence", () => {
  const hay = buildEvidenceHaystack(
    "Invoice 42",
    "Please pay invoice 42 by Friday. Also review the deck.",
  );

  it("keeps verified asks and drops the rest, reporting each drop", () => {
    const facts: FactsV1 = {
      ...base,
      asks: [
        { kind: "pay", object: "invoice 42", due: null, evidence: "pay invoice 42 by Friday" },
        { kind: "review", object: "deck", due: null, evidence: "review the slides" },
        { kind: "reply", object: "x", due: null, evidence: "Also review the deck." },
      ],
    };
    const r = verifyFactsEvidence(facts, hay);
    expect(r.facts.asks.map((a) => a.kind)).toEqual(["pay", "reply"]);
    expect(r.check).toEqual({
      checked: 3,
      dropped: [{ path: "asks[1]", evidence: "review the slides" }],
    });
  });

  it("returns a new object and never mutates the input", () => {
    const facts: FactsV1 = {
      ...base,
      asks: [{ kind: "review", object: "deck", due: null, evidence: "not in mail" }],
    };
    const snapshot = structuredClone(facts);
    const r = verifyFactsEvidence(facts, hay);
    expect(facts).toEqual(snapshot);
    expect(r.facts).not.toBe(facts);
    expect(r.facts.asks).toEqual([]);
  });
});
