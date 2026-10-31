import { describe, expect, it } from "vitest";
import {
  buildEvidenceHaystack,
  evidenceStatesTime,
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
    expect(normaliseForEvidence("  Please\u00a0 CONFIRM\n\t by “Tuesday” — ok\u200b ")).toBe(
      'please confirm by "tuesday" - ok',
    );
    expect(normaliseForEvidence("ＡＢＣ１２３")).toBe("abc123");
    expect(normaliseForEvidence("it’s")).toBe("it's");
    expect(normaliseForEvidence("re\u00adview")).toBe("review");
    // Bidi overrides and isolates (\p{Cf}) are dropped, not kept invisibly.
    expect(normaliseForEvidence("pay \u202enow\u202c \u2066x\u2069")).toBe("pay now x");
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
    expect(verifyEvidence("x ".repeat(160), buildEvidenceHaystack("", "x ".repeat(400)))).toBe(
      false,
    );
    // A stray function word cannot ground a fabricated fact.
    expect(verifyEvidence("the", hay)).toBe(false);
    expect(verifyEvidence("please", hay)).toBe(false);
    // Two tokens, or one long token (Korean often has no spaces), do.
    expect(verifyEvidence("please confirm", hay)).toBe(true);
    expect(verifyEvidence("회신 부탁드립니다", hay)).toBe(true);
  });

  it("does not verify a Latin word fragment, but tolerates Korean particles", () => {
    const h = buildEvidenceHaystack("", "Pending disapproval of the plan. 회신을 부탁드립니다");
    expect(verifyEvidence("approval of the plan", h)).toBe(false);
    expect(verifyEvidence("disapproval of the plan", h)).toBe(true);
    expect(
      verifyEvidence("회신 부탁드립니다", buildEvidenceHaystack("", "회신 부탁드립니다요")),
    ).toBe(true);
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

describe("evidenceStatesTime (due binding)", () => {
  it("accepts quotes that state a time, in English and Korean", () => {
    for (const q of [
      "confirm receipt of the wire before end of day",
      "by close of business",
      "send it by COB",
      "reply by Fri",
      "due 3/5",
      "needed tomorrow morning",
      "ASAP please",
      "오늘 6시까지 회신 필요",
      "다음주 월요일 마감",
      "이번 주 안에 부탁드립니다",
      "by may 5",
      "on 3 nov",
      "within 3 hours",
      "at 18:00",
      "11월 3일까지",
    ]) {
      expect(evidenceStatesTime(q), q).toBe(true);
    }
  });

  it("rejects quotes with no time in them", () => {
    for (const q of [
      "please review the deck",
      "could you send the contract",
      "검토 부탁드립니다",
      "this sunset photo",
      "you may approve it",
      "see invoice #4821",
      "we wed in spring",
      "suite 4 reception",
    ]) {
      expect(evidenceStatesTime(q), q).toBe(false);
    }
  });
});
