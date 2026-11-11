/**
 * Policy variants eval (src/eval-v3/variants.ts): the pieces the v3.2 numbers
 * in docs/design/attention-engine-v3.md §3(5) stand on.
 */
import { describe, expect, it } from "vitest";
import type { BenchRow } from "../eval-v3/metrics.js";
import {
  businessWeekEnd,
  demotedCorrect,
  laneMetrics,
  POLICY_VARIANTS,
  senderScenarios,
  variantDecider,
} from "../eval-v3/variants.js";
import type { FactsV1 } from "../judge/v3/facts-schema.js";
import { isFirstContact, policyRules } from "../judge/v3/policy.js";
import type { RelationshipSnapshot } from "../judge/v3/relationship.js";

const row = (id: string, truth: BenchRow["truth"], predicted: BenchRow["predicted"]): BenchRow => ({
  id,
  truth,
  predicted,
  source: "v3",
});

describe("businessWeekEnd", () => {
  it("ends the week at Friday 24:00 UTC; a weekend takes the next week", () => {
    const monday = new Date("2026-11-02T14:10:00Z");
    expect(businessWeekEnd(monday).toISOString()).toBe("2026-11-07T00:00:00.000Z");
    expect(businessWeekEnd(new Date("2026-11-06T23:00:00Z")).toISOString()).toBe(
      "2026-11-07T00:00:00.000Z",
    );
    expect(businessWeekEnd(new Date("2026-11-07T10:00:00Z")).toISOString()).toBe(
      "2026-11-14T00:00:00.000Z",
    );
    expect(businessWeekEnd(new Date("2026-11-08T10:00:00Z")).toISOString()).toBe(
      "2026-11-14T00:00:00.000Z",
    );
    expect(businessWeekEnd(monday, 1).toISOString()).toBe("2026-11-14T00:00:00.000Z");
  });
});

describe("senderScenarios", () => {
  const at = new Date("2026-11-02T00:00:00Z");
  const [cold, coldTrusted, known, knownTrusted] = senderScenarios(["eval-046"]);

  it("cold start is a first contact; a known sender is not", () => {
    const c = cold.sender("x", at).relationship;
    expect(c).not.toBeNull();
    expect(isFirstContact(c as RelationshipSnapshot, null, at)).toBe(true);
    const k = known.sender("x", at);
    expect(k.senderAuthenticated).toBeNull();
    expect(isFirstContact(k.relationship as RelationshipSnapshot, k.senderAuthenticated, at)).toBe(
      false,
    );
  });

  it("only the trusted ids get a DMARC pass; the rest keep their scenario", () => {
    expect(coldTrusted.sender("eval-046", at).senderAuthenticated).toBe(true);
    expect(coldTrusted.sender("eval-001", at)).toEqual(cold.sender("eval-001", at));
    expect(knownTrusted.sender("eval-001", at)).toEqual(known.sender("eval-001", at));
  });
});

describe("variantDecider", () => {
  const facts: FactsV1 = {
    asks: [],
    addressedTo: "me_direct",
    threadTurn: "none",
    event: { proposedTimes: [], hasInvite: false, conflict: null },
    transaction: null,
    risk: [],
    kind: "meeting",
    ambiguous: false,
  };
  const email = { from: "a@b.example", subject: "s", receivedAt: "2026-11-02T00:00:00Z" };
  const [cold, , known] = senderScenarios([]);
  const byName = (n: string) => POLICY_VARIANTS.find((v) => v.name === n);

  it("decides with the variant's rules and the scenario's sender", () => {
    const v31 = byName("v3.1");
    const v32 = byName("v3.2");
    if (!v31 || !v32) throw new Error("variants missing");
    expect(variantDecider(v31, cold)(facts, email, "x")).toEqual({
      lane: "MEETING",
      rule: "v3.1:event",
    });
    expect(variantDecider(v32, cold)(facts, email, "x").lane).toBe("QUEUE");
    expect(variantDecider(v32, known)(facts, email, "x").lane).toBe("MEETING");
  });

  it("ships v3.1 and v3.2 unchanged as the first two variants", () => {
    const at = new Date(email.receivedAt);
    expect(POLICY_VARIANTS[0].rules(at)).toEqual(policyRules("v3.1"));
    expect(POLICY_VARIANTS[1].rules(at)).toEqual(policyRules("v3.2"));
  });
});

describe("laneMetrics and demotedCorrect", () => {
  it("counts precision over predictions and recall over labels", () => {
    const m = laneMetrics([
      row("a", "PUSH", "PUSH"),
      row("b", "PUSH", "QUEUE"),
      row("c", "QUEUE", "SILENT"),
      row("d", "MEETING", "MEETING"),
    ]);
    expect(m.overall).toEqual({ hit: 2, n: 4 });
    expect(m.pushRecall).toEqual({ hit: 1, n: 2 });
    expect(m.pushPrecision).toEqual({ hit: 1, n: 1 });
    expect(m.silentPrecision).toEqual({ hit: 0, n: 1 });
    expect(m.meetingRecall).toEqual({ hit: 1, n: 1 });
    expect(m.meetingPrecision).toEqual({ hit: 1, n: 1 });
  });

  it("counts only correct PUSH/MEETING rows the variant got wrong, per id", () => {
    const base = [
      row("a", "PUSH", "PUSH"),
      row("b", "MEETING", "MEETING"),
      row("c", "QUEUE", "QUEUE"),
    ];
    const variant = [
      row("a", "PUSH", "QUEUE"),
      row("b", "MEETING", "MEETING"),
      row("c", "QUEUE", "INFO"),
    ];
    expect([...demotedCorrect(base, variant)]).toEqual([["a", 1]]);
  });

  it("refuses runs that are not aligned", () => {
    expect(() => demotedCorrect([row("a", "PUSH", "PUSH")], [row("b", "PUSH", "QUEUE")])).toThrow(
      /not aligned/,
    );
  });
});
