import { describe, expect, it } from "vitest";
import type { FactsV1 } from "../judge/v3/facts-schema.js";
import { laneFromFactsV3, POLICY_VERSION } from "../judge/v3/policy.js";
import { laneForRow, type ShadowRow, summarizeShadow } from "../judge/v3/shadow-report.js";

const at = new Date("2026-10-30T00:00:00Z");
const facts = (over: Partial<FactsV1> = {}): FactsV1 => ({
  asks: [],
  addressedTo: "me_direct",
  threadTurn: "none",
  event: null,
  transaction: null,
  risk: [],
  kind: "personal",
  ambiguous: false,
  ...over,
});
const ask = (due: string | null) => ({
  kind: "reply" as const,
  object: "x",
  due,
  evidence: "reply by today",
});

describe("report lanes come from policy v3 (laneFromFactsV3)", () => {
  it("reports the policy version it scored with", () => {
    expect(summarizeShadow([]).lanes.policy).toBe(POLICY_VERSION);
  });

  it("passes the stored signals: machine mail never PUSHes through an ask, spam never PUSHes", () => {
    const urgent = facts({ asks: [ask("2026-10-30T10:00:00Z")] });
    expect(laneForRow(urgent, {}, null, at)).toBe("PUSH");
    expect(laneForRow(urgent, { automatedSender: true }, null, at)).not.toBe("PUSH");
    expect(laneForRow(urgent, { autoSubmitted: true }, null, at)).not.toBe("PUSH");
    expect(laneForRow(urgent, { spam: true }, null, at)).not.toBe("PUSH");
  });

  it("passes the stored DMARC verdict, so v3.1's risk trust scores as on the live path", () => {
    const f = facts({ risk: ["payment_failed"], kind: "notification" });
    const rel = {
      vip: false,
      inboundCount: 12,
      firstSeenAt: new Date(at.getTime() - 400 * 24 * 3_600_000).toISOString(),
    } as never;
    expect(laneForRow(f, { senderAuthenticated: true }, rel, at)).toBe("PUSH");
    expect(laneForRow(f, {}, rel, at)).toBe("QUEUE");
    expect(laneForRow(f, { senderAuthenticated: false }, rel, at)).toBe("QUEUE");
  });

  it("matches laneFromFactsV3 exactly for the same inputs (no private mapping left)", () => {
    const f = facts({ risk: ["payment_failed"], kind: "notification" });
    const rel = { vip: true } as never;
    expect(laneForRow(f, {}, rel, at)).toBe(
      laneFromFactsV3({ facts: f, relationship: rel, decidedAt: at }).lane,
    );
  });

  it("excludes pinned senders (the pin decides both lanes)", () => {
    expect(laneForRow(facts(), {}, { pinned: true } as never, at)).toBeNull();
  });
});

describe("summarizeShadow", () => {
  const row = (over: Partial<ShadowRow>): ShadowRow => ({
    sourceId: "e1",
    factsSource: "llm",
    facts: facts(),
    signals: {},
    relationship: null,
    v2Tier: "QUEUE",
    escalate: false,
    escalateReasons: [],
    evidenceCheck: { checked: 0, dropped: [] },
    costUsd: 0.002,
    model: "claude-haiku-5-5",
    provider: "anthropic",
    extractedAt: at,
    ...over,
  });

  it("reports agreement, the lane matrix, fallback, escalation, drops and cost — ids only", () => {
    const s = summarizeShadow([
      row({}),
      row({ sourceId: "e2", v2Tier: "SILENT" }),
      row({
        sourceId: "e3",
        factsSource: "none",
        facts: { addressedTo: "bulk" },
        escalate: true,
        escalateReasons: ["llm_failed"],
        costUsd: null,
        model: null,
      }),
      row({
        sourceId: "e4",
        evidenceCheck: { checked: 2, dropped: [{ path: "asks[0]" }, { path: "asks[1].due" }] },
        escalate: true,
        escalateReasons: ["evidence_failed"],
      }),
    ]);
    expect(s.rows).toBe(4);
    expect(s.bySource).toEqual({ llm: 3, none: 1 });
    expect(s.fallbackRate).toBe(0.25);
    expect(s.escalation.reasons).toEqual({ llm_failed: 1, evidence_failed: 1 });
    expect(s.evidence).toEqual({ asksDropped: 1, dueCleared: 1 });
    expect(s.cost.totalUsd).toBeCloseTo(0.006);
    expect(s.cost.perDayUsd["2026-10-30"]).toBeCloseTo(0.006);
    expect(s.lanes.compared).toBe(3);
    expect(s.lanes.agreement).toBeCloseTo(2 / 3);
    expect(s.lanes.matrix).toEqual({ QUEUE: { QUEUE: 2 }, SILENT: { QUEUE: 1 } });
    expect(s.lanes.disagreementSamples).toEqual([{ sourceId: "e2", v2: "SILENT", v3: "QUEUE" }]);
    expect(JSON.stringify(s)).not.toContain("reply by");
  });

  it("counts stored facts that no longer validate instead of crashing", () => {
    const s = summarizeShadow([row({ facts: { junk: true } })]);
    expect(s.invalidStoredFacts).toBe(1);
    expect(s.lanes.compared).toBe(0);
    expect(s.lanes.agreement).toBeNull();
  });
});
