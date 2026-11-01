import { describe, expect, it } from "vitest";
import {
  ADDRESSED_TO,
  ASK_KINDS,
  FACTS_VERSION,
  MAIL_KINDS,
  parseFactsV1,
  RISKS,
  THREAD_TURNS,
  TRANSACTION_KINDS,
} from "../judge/v3/facts-schema.js";

const valid = () => ({
  asks: [
    {
      kind: "reply",
      object: "confirm the contract date",
      due: "2026-11-03T18:00:00+09:00",
      evidence: "please confirm by Tuesday 6pm",
    },
  ],
  addressedTo: "me_direct",
  threadTurn: "mine_to_reply",
  event: null,
  transaction: null,
  risk: [],
  kind: "work_thread",
  ambiguous: false,
});

describe("facts schema v1 enums", () => {
  it("matches the contract table in docs/design/attention-engine-v3.md §3(1) exactly", () => {
    expect(FACTS_VERSION).toBe(1);
    expect([...ASK_KINDS]).toEqual(["reply", "decide", "pay", "attend", "review", "provide"]);
    expect([...ADDRESSED_TO]).toEqual(["me_direct", "me_cc", "group", "bulk"]);
    expect([...THREAD_TURNS]).toEqual(["mine_to_reply", "theirs", "none"]);
    expect([...TRANSACTION_KINDS]).toEqual(["receipt", "invoice", "shipping", "code", "statement"]);
    expect([...RISKS]).toEqual([
      "payment_failed",
      "security_alert",
      "account_change",
      "phishing_suspect",
    ]);
    expect([...MAIL_KINDS]).toEqual([
      "personal",
      "work_thread",
      "notification",
      "newsletter",
      "promotion",
      "receipt",
      "meeting",
    ]);
  });
});

describe("parseFactsV1", () => {
  it("accepts a well-formed fact set unchanged", () => {
    const { facts, issues } = parseFactsV1(valid());
    expect(issues).toEqual([]);
    expect(facts).toEqual(valid());
  });

  it("returns null with an issue for non-objects", () => {
    for (const raw of [null, undefined, "x", 3, []]) {
      const r = parseFactsV1(raw);
      expect(r.facts).toBeNull();
      expect(r.issues.length).toBeGreaterThan(0);
    }
  });

  it("returns null when a required scalar enum is invalid", () => {
    const r = parseFactsV1({ ...valid(), addressedTo: "everyone" });
    expect(r.facts).toBeNull();
    expect(r.issues).toContain("addressedTo: invalid");
    expect(parseFactsV1({ ...valid(), kind: "spam" }).facts).toBeNull();
    expect(parseFactsV1({ ...valid(), threadTurn: undefined }).facts).toBeNull();
    expect(parseFactsV1({ ...valid(), ambiguous: "no" }).facts).toBeNull();
  });

  it("drops an invalid ask but keeps the rest, recording why", () => {
    const raw = valid();
    raw.asks.push({ kind: "dance", object: "x", due: null, evidence: "y" });
    raw.asks.push({
      kind: "pay",
      object: "invoice 42",
      due: "tomorrow",
      evidence: "pay invoice 42",
    });
    const { facts, issues } = parseFactsV1(raw);
    expect(facts?.asks).toHaveLength(2);
    expect(facts?.asks[1]).toEqual({
      kind: "pay",
      object: "invoice 42",
      due: null,
      evidence: "pay invoice 42",
    });
    expect(issues).toContain("asks[1]: invalid kind");
    expect(issues).toContain("asks[2].due: not an absolute ISO-8601 date-time");
  });

  it("requires due/proposedTimes to carry an explicit offset (absolute, not floating)", () => {
    const raw = { ...valid(), asks: [{ ...valid().asks[0], due: "2026-11-03T18:00:00" }] };
    const { facts, issues } = parseFactsV1(raw);
    expect(facts?.asks[0]?.due).toBeNull();
    expect(issues).toContain("asks[0].due: not an absolute ISO-8601 date-time");
    const zulu = parseFactsV1({
      ...valid(),
      asks: [{ ...valid().asks[0], due: "2026-11-03T09:00:00Z" }],
    });
    expect(zulu.facts?.asks[0]?.due).toBe("2026-11-03T09:00:00Z");
  });

  it("rejects calendar-impossible dates", () => {
    const r = parseFactsV1({
      ...valid(),
      asks: [{ ...valid().asks[0], due: "2026-02-30T10:00:00Z" }],
    });
    expect(r.facts?.asks[0]?.due).toBeNull();
  });

  it("validates event and transaction shapes", () => {
    const ok = parseFactsV1({
      ...valid(),
      event: {
        proposedTimes: ["2026-11-04T10:00:00+09:00", "bad"],
        hasInvite: true,
        conflict: null,
      },
      transaction: { kind: "invoice", actionRequired: true },
    });
    expect(ok.facts?.event).toEqual({
      proposedTimes: ["2026-11-04T10:00:00+09:00"],
      hasInvite: true,
      conflict: null,
    });
    expect(ok.facts?.transaction).toEqual({ kind: "invoice", actionRequired: true });
    expect(ok.issues).toContain("event.proposedTimes[1]: not an absolute ISO-8601 date-time");

    const badTx = parseFactsV1({
      ...valid(),
      transaction: { kind: "refund", actionRequired: true },
    });
    expect(badTx.facts?.transaction).toBeNull();
    expect(badTx.issues).toContain("transaction: invalid");
  });

  it("dedupes risk and drops unknown risk values", () => {
    const r = parseFactsV1({ ...valid(), risk: ["security_alert", "security_alert", "fraud"] });
    expect(r.facts?.risk).toEqual(["security_alert"]);
    expect(r.issues).toContain("risk[2]: invalid");
  });

  it("bounds free text from the model: trims, strips control chars, caps length", () => {
    const long = "a".repeat(500);
    const r = parseFactsV1({
      ...valid(),
      asks: [
        {
          kind: "review",
          object: ` deck\u0000\u001b[31m v2 ${long}`,
          due: null,
          evidence: `q ${long}`,
        },
      ],
    });
    const ask = r.facts?.asks[0];
    expect(ask?.object.startsWith("deck")).toBe(true);
    expect([...(ask?.object ?? "")].some((c) => c.charCodeAt(0) < 0x20)).toBe(false);
    expect(ask?.object.length).toBeLessThanOrEqual(160);
    expect(ask?.evidence.length).toBeLessThanOrEqual(300);
  });

  it("drops an ask whose evidence or object is empty", () => {
    const r = parseFactsV1({
      ...valid(),
      asks: [
        { kind: "reply", object: "x", due: null, evidence: "   " },
        { kind: "reply", object: "", due: null, evidence: "please reply" },
      ],
    });
    expect(r.facts?.asks).toEqual([]);
    expect(r.issues).toEqual(["asks[0]: empty evidence", "asks[1]: empty object"]);
  });

  it("caps the number of asks and proposed times", () => {
    const asks = Array.from({ length: 20 }, (_, i) => ({
      kind: "reply",
      object: `item ${i}`,
      due: null,
      evidence: `item ${i}`,
    }));
    const r = parseFactsV1({ ...valid(), asks });
    expect(r.facts?.asks.length).toBe(8);
    expect(r.issues).toContain("asks: truncated to 8");
  });
});
