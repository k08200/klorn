import { describe, expect, it } from "vitest";
import type { FactsV1 } from "../judge/v3/facts-schema.js";
import { comparePair, labelFromFacts } from "../judge/v3/label-pair.js";

const at = new Date("2026-10-30T00:00:00Z");
const f = (over: Partial<FactsV1> = {}): FactsV1 => ({
  asks: [],
  addressedTo: "me_direct",
  threadTurn: "none",
  event: null,
  transaction: null,
  risk: [],
  kind: "work_thread",
  ambiguous: false,
  ...over,
});
const ask = (due: string | null) => ({ kind: "reply" as const, object: "x", due, evidence: "reply today please" });

describe("comparePair", () => {
  it("agreement on a non-urgent item is reconciled without founder review", () => {
    const v = comparePair(f(), f({ ambiguous: true }), at);
    expect(v).toMatchObject({ agree: true, needsReview: false, reviewReasons: [] });
    expect(v.reconciled).toEqual(labelFromFacts(f(), at));
  });

  it("any disagreement goes to the founder, with the differing fields", () => {
    const v = comparePair(f({ kind: "personal" }), f(), at);
    expect(v.agree).toBe(false);
    expect(v.diffs).toEqual(["kind"]);
    expect(v.reviewReasons).toEqual(["disagree"]);
    expect(v.reconciled).toBeNull();
  });

  it("PUSH/MEETING-relevant items go to the founder even when both models agree", () => {
    for (const x of [
      f({ asks: [ask("2026-10-30T09:00:00Z")] }),
      f({ event: { proposedTimes: [], hasInvite: true, conflict: null } }),
      f({ risk: ["security_alert"] }),
    ]) {
      const v = comparePair(x, x, at);
      expect(v.agree).toBe(true);
      expect(v.reviewReasons).toEqual(["push_or_meeting"]);
      expect(v.draft).not.toBeNull();
      expect(v.reconciled).toBeNull();
    }
  });

  it("a model without usable facts sends the item to review", () => {
    expect(comparePair(null, f(), at)).toMatchObject({ needsReview: true, reviewReasons: ["no_facts"] });
  });

  it("compares ask kinds as a set and ignores the order of risks", () => {
    const a = f({ asks: [{ ...ask(null), kind: "review" }, ask(null)], risk: ["account_change", "phishing_suspect"] });
    const b = f({ asks: [ask(null), { ...ask(null), kind: "review" }, ask(null)], risk: ["phishing_suspect", "account_change"] });
    expect(comparePair(a, b, at).diffs).toEqual([]);
  });
});
