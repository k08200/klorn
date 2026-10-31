import { describe, expect, it } from "vitest";
import {
  applyEvidenceCheck,
  hasTemporalToken,
  normaliseEvidence,
  verifyEvidence,
} from "../eval-v3/evidence.js";
import { type FactsV1, parseFactsV1 } from "../eval-v3/facts-schema.js";

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

describe("parseFactsV1", () => {
  it("accepts a schema v1 object unchanged", () => {
    const { facts, issues } = parseFactsV1(VALID);
    expect(facts).toEqual(VALID);
    expect(issues).toEqual([]);
  });

  it("ignores an extra factsVersion key (persistence column, not a field)", () => {
    const { facts, issues } = parseFactsV1({ ...VALID, factsVersion: 1 });
    expect(facts).toEqual(VALID);
    expect(issues).toEqual([]);
  });

  it("drops an ask with an unknown kind and records the issue", () => {
    const raw = { ...VALID, asks: [...VALID.asks, { ...VALID.asks[0], kind: "buy" }] };
    const { facts, issues } = parseFactsV1(raw);
    expect(facts?.asks).toHaveLength(1);
    expect(issues.join(" ")).toMatch(/ask\[1\].*kind/);
  });

  it("nulls an unparseable due date instead of guessing", () => {
    const raw = { ...VALID, asks: [{ ...VALID.asks[0], due: "end of day" }] };
    const { facts, issues } = parseFactsV1(raw);
    expect(facts?.asks[0].due).toBeNull();
    expect(issues.join(" ")).toMatch(/due/);
  });

  it("rejects the whole object when a required enum is missing", () => {
    const { kind: _drop, ...rest } = VALID;
    const { facts, issues } = parseFactsV1(rest);
    expect(facts).toBeNull();
    expect(issues.join(" ")).toMatch(/kind/);
  });

  it("filters unknown risk values and keeps the known ones", () => {
    const { facts } = parseFactsV1({ ...VALID, risk: ["security_alert", "spooky"] });
    expect(facts?.risk).toEqual(["security_alert"]);
  });

  it("nulls a malformed event and transaction", () => {
    const { facts, issues } = parseFactsV1({
      ...VALID,
      event: { proposedTimes: "tuesday", hasInvite: "yes" },
      transaction: { kind: "gift", actionRequired: false },
    });
    expect(facts?.event).toBeNull();
    expect(facts?.transaction).toBeNull();
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps a valid event with unparseable times dropped", () => {
    const { facts } = parseFactsV1({
      ...VALID,
      event: {
        proposedTimes: ["2026-06-02T14:00:00Z", "next week"],
        hasInvite: false,
        conflict: null,
      },
    });
    expect(facts?.event).toEqual({
      proposedTimes: ["2026-06-02T14:00:00Z"],
      hasInvite: false,
      conflict: null,
    });
  });

  it("rejects non-objects", () => {
    expect(parseFactsV1("nope").facts).toBeNull();
    expect(parseFactsV1(null).facts).toBeNull();
    expect(parseFactsV1([VALID]).facts).toBeNull();
  });
});

describe("evidence verification (P2 normalisation spec)", () => {
  it("normalises NFKC, zero-width, quotes, dashes, whitespace and case", () => {
    expect(normaliseEvidence("ＡＢＣ")).toBe("abc");
    expect(normaliseEvidence("de​ck﻿")).toBe("deck");
    expect(normaliseEvidence("“it’s”")).toBe('"it\'s"');
    expect(normaliseEvidence("a—b–c")).toBe("a-b-c");
    expect(normaliseEvidence("  a  \n b  ")).toBe("a b");
    expect(normaliseEvidence("Send IT")).toBe("send it");
  });

  it("accepts a verbatim quote that differs only in case and spacing", () => {
    const haystack =
      "Need the updated deck today\nPartner meeting moved up — can you send the latest deck today?";
    expect(verifyEvidence("Can you  send the latest deck today?", haystack)).toBe(true);
  });

  it("rejects paraphrase, too-short and too-long quotes", () => {
    const haystack = "Please confirm your interview time within 24 hours.";
    expect(verifyEvidence("confirm the interview within a day", haystack)).toBe(false);
    expect(verifyEvidence("in", haystack)).toBe(false);
    expect(verifyEvidence("x".repeat(301), "x".repeat(400))).toBe(false);
  });

  it("checks each field separately, so a quote cannot be stitched across fields", () => {
    const facts: FactsV1 = {
      ...VALID,
      asks: [{ ...VALID.asks[0], evidence: "send the file by tomorrow morning" }],
    };
    const stitched = applyEvidenceCheck(facts, ["please send the file", "by tomorrow morning"]);
    expect(stitched.evidenceValid).toBe(0);
    const whole = applyEvidenceCheck(facts, [
      "subject",
      "please send the file by tomorrow morning",
    ]);
    expect(whole.evidenceValid).toBe(1);
  });

  it("drops asks whose evidence fails and counts valid/total", () => {
    const facts: FactsV1 = {
      ...VALID,
      asks: [VALID.asks[0], { ...VALID.asks[0], evidence: "made-up words not in mail" }],
    };
    const checked = applyEvidenceCheck(facts, [
      "Partner meeting moved up — can you send the latest deck today?",
    ]);
    expect(checked.facts.asks).toHaveLength(1);
    expect(checked.evidenceTotal).toBe(2);
    expect(checked.evidenceValid).toBe(1);
  });

  it("strips every Unicode format char (\\p{Cf}), including bidi overrides", () => {
    expect(normaliseEvidence("pay‮now⁦")).toBe("paynow");
  });

  it("requires ≥2 tokens or ≥8 chars, so a stray word cannot verify", () => {
    const haystack = "the attachment is the contract";
    expect(verifyEvidence("the", haystack)).toBe(false);
    expect(verifyEvidence("att", haystack)).toBe(false);
    expect(verifyEvidence("the contract", haystack)).toBe(true);
    expect(verifyEvidence("contract", haystack)).toBe(true);
  });
});

describe("due binding (P2 security review)", () => {
  it("recognises English and Korean deadline words", () => {
    for (const quote of [
      "by tomorrow morning",
      "before EOD",
      "due this Friday",
      "within 24 hours",
      "respond ASAP",
      "send it right now",
      "내일 오전까지",
      "금요일 마감",
      "긴급 확인 부탁",
    ]) {
      expect(hasTemporalToken(quote), quote).toBe(true);
    }
    expect(hasTemporalToken("before end of day")).toBe(true);
    expect(hasTemporalToken("by close of business")).toBe(true);
    expect(hasTemporalToken("can you send the latest deck")).toBe(false);
    expect(hasTemporalToken("검토 부탁드립니다")).toBe(false);
    // bare 시 is not a token (시스템, 다시, 주시기 …); "6시" still matches via the digit
    expect(hasTemporalToken("자료 보내주시기 바랍니다")).toBe(false);
    expect(hasTemporalToken("오늘 6시까지")).toBe(true);
  });

  it("keeps the ask but nulls a due whose evidence states no deadline", () => {
    const haystack = "Partner meeting moved up — can you send the latest deck today?";
    const facts: FactsV1 = {
      ...VALID,
      asks: [
        { ...VALID.asks[0], evidence: "can you send the latest deck" },
        { ...VALID.asks[0], evidence: "send the latest deck today?" },
      ],
    };
    const checked = applyEvidenceCheck(facts, [haystack]);
    expect(checked.facts.asks.map((a) => a.due)).toEqual([null, "2026-06-01T23:59:00Z"]);
    expect(checked.dueUnbound).toBe(1);
  });
});

describe("due parsing is machine-independent", () => {
  it("reads a naive datetime as UTC and a date-only due as the end of that day", () => {
    const { facts, issues } = parseFactsV1({
      ...VALID,
      asks: [
        { ...VALID.asks[0], due: "2026-06-02T08:00:00" },
        { ...VALID.asks[0], due: "2026-06-05" },
        { ...VALID.asks[0], due: "2026-06-02T08:00:00+09:00" },
      ],
    });
    expect(facts?.asks.map((a) => a.due)).toEqual([
      "2026-06-02T08:00:00Z",
      "2026-06-05T23:59:00Z",
      "2026-06-02T08:00:00+09:00",
    ]);
    expect(issues.join(" ")).toMatch(/no offset/);
  });
});
