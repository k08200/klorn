/**
 * The `v3` block clients read (docs/design/attention-engine-v3.md §3(5)
 * "Reasons and API contract"): stored decision columns re-validated on read,
 * "held" only while the item still shows the hold, and reasons that follow a
 * human or agent lane.
 */

import { describe, expect, it } from "vitest";
import { type V3ItemRow, v3ItemWire } from "../judge/v3/item-wire.js";

const DUE = new Date("2026-11-07T09:00:00.000Z");
const HELD_AT = new Date("2026-11-07T01:00:00.000Z");

function row(over: Partial<V3ItemRow> = {}): V3ItemRow {
  return {
    tier: "QUEUE",
    heldAt: null,
    isManualOverride: false,
    agentTierSetAt: null,
    v3PolicyVersion: "v3.0",
    v3Decision: {
      basis: "llm",
      threadTurn: "mine_to_reply",
      reasons: [
        {
          code: "ask",
          fact: "asks",
          evidence: "Can you send the deck",
          params: { askKind: "provide", due: null },
        },
      ],
    },
    v3Due: DUE,
    ...over,
  };
}

const wire = (r: V3ItemRow, opts: { rank?: number | null; subject?: string } = {}) =>
  v3ItemWire(r, { rank: opts.rank ?? null, subject: opts.subject ?? "" });

describe("v3ItemWire", () => {
  it("maps the stored decision, with the reason located against the subject", () => {
    const w = wire(row(), { rank: 3, subject: "Can you send the deck by Friday?" });
    expect(w).toEqual({
      policyVersion: "v3.0",
      rank: 3,
      held: false,
      due: DUE.toISOString(),
      threadTurn: "mine_to_reply",
      reasons: [
        {
          code: "ask",
          fact: "asks",
          evidence: "Can you send the deck",
          evidenceIn: "subject",
          params: { askKind: "provide", due: null },
        },
      ],
    });
    expect(wire(row(), { subject: "Re: hello" }).reasons[0]?.evidenceIn).toBe("body");
  });

  it("is held only while the item still shows the hold", () => {
    expect(wire(row({ heldAt: HELD_AT })).held).toBe(true);
    expect(wire(row({ heldAt: HELD_AT, tier: "PUSH" })).held).toBe(false);
    expect(wire(row({ heldAt: HELD_AT, isManualOverride: true })).held).toBe(false);
    expect(wire(row({ heldAt: HELD_AT, agentTierSetAt: HELD_AT })).held).toBe(false);
  });

  it("a human override shows manual_override; an agent lane shows no reasons", () => {
    expect(wire(row({ tier: "PUSH", isManualOverride: true })).reasons).toEqual([
      {
        code: "manual_override",
        fact: null,
        evidence: null,
        evidenceIn: null,
        params: { tier: "PUSH" },
      },
    ]);
    expect(wire(row({ agentTierSetAt: HELD_AT })).reasons).toEqual([]);
  });

  it("an item v3 never decided has a null policyVersion and no reasons", () => {
    const w = wire(row({ v3PolicyVersion: null, v3Decision: null, v3Due: null }));
    expect(w).toMatchObject({ policyVersion: null, reasons: [], due: null, threadTurn: null });
  });

  it("re-validates stored JSON: unknown codes, bad params and long evidence", () => {
    const w = wire(
      row({
        v3PolicyVersion: "v9.9",
        v3Decision: {
          basis: "llm",
          threadTurn: "sideways",
          reasons: [
            { code: "made_up", fact: null, evidence: null, params: {} },
            {
              code: "kind",
              fact: "kind",
              evidence: "x".repeat(400),
              params: { kind: "newsletter", nested: { a: 1 }, list: [1], ok: 2 },
            },
            "not an object",
          ],
        },
      }),
    );
    expect(w.policyVersion).toBeNull();
    expect(w.threadTurn).toBeNull();
    expect(w.reasons).toHaveLength(1);
    expect(w.reasons[0]?.code).toBe("kind");
    expect(w.reasons[0]?.evidence).toHaveLength(300);
    expect(w.reasons[0]?.params).toEqual({ kind: "newsletter", ok: 2 });
  });

  it("tolerates a malformed decision column", () => {
    for (const v3Decision of ["text", 7, [], { reasons: "nope" }]) {
      expect(wire(row({ v3Decision })).reasons).toEqual([]);
    }
  });
});
