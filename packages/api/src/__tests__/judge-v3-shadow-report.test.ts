import { describe, expect, it } from "vitest";
import type { FactsV1 } from "../judge/v3/facts-schema.js";
import {
  laneFromFactsForReport,
  type ShadowRow,
  summarizeShadow,
} from "../judge/v3/shadow-report.js";

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

describe("laneFromFactsForReport (doc §3(4), pre-budget)", () => {
  it("PUSH: a verified ask due within 24h, written to the user by a person", () => {
    expect(
      laneFromFactsForReport(facts({ asks: [ask("2026-10-30T10:00:00Z")] }), {}, null, at),
    ).toBe("PUSH");
  });

  it("machine mail never PUSHes through an ask; spam and phishing never PUSH", () => {
    const f = facts({ asks: [ask("2026-10-30T10:00:00Z")] });
    expect(laneFromFactsForReport(f, { automatedSender: true }, null, at)).toBe("QUEUE");
    expect(laneFromFactsForReport(f, { spam: true }, null, at)).toBe("QUEUE");
    expect(laneFromFactsForReport({ ...f, risk: ["phishing_suspect"] }, {}, null, at)).toBe(
      "QUEUE",
    );
  });

  it("risk-only PUSH needs vip; untrusted risk lands QUEUE, never INFO/SILENT", () => {
    const f = facts({ risk: ["payment_failed"], kind: "notification" });
    const vip = { vip: true } as never;
    expect(laneFromFactsForReport(f, {}, vip, at)).toBe("PUSH");
    expect(laneFromFactsForReport(f, {}, null, at)).toBe("QUEUE");
  });

  it("PUSH needs the mail addressed to the user on both branches; long-overdue is not due soon", () => {
    const vip = { vip: true } as never;
    expect(
      laneFromFactsForReport(
        facts({ risk: ["payment_failed"], addressedTo: "group" }),
        {},
        vip,
        at,
      ),
    ).toBe("QUEUE");
    expect(
      laneFromFactsForReport(facts({ asks: [ask("2026-10-20T00:00:00Z")] }), {}, null, at),
    ).toBe("QUEUE");
  });

  it("MEETING for a non-bulk event; INFO for records; SILENT for bulk", () => {
    expect(
      laneFromFactsForReport(
        facts({ event: { proposedTimes: [], hasInvite: true, conflict: null }, kind: "meeting" }),
        {},
        null,
        at,
      ),
    ).toBe("MEETING");
    expect(
      laneFromFactsForReport(facts({ kind: "receipt", addressedTo: "me_direct" }), {}, null, at),
    ).toBe("INFO");
    expect(
      laneFromFactsForReport(facts({ kind: "newsletter", addressedTo: "bulk" }), {}, null, at),
    ).toBe("SILENT");
  });

  it("excludes pinned senders (the pin decides both lanes)", () => {
    expect(laneFromFactsForReport(facts(), {}, { pinned: true } as never, at)).toBeNull();
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
