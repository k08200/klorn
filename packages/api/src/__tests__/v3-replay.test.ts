/**
 * Policy replay core (docs/design/attention-engine-v3.md §5): lane
 * distribution and per-item diff vs v2, precedence kept, stored facts
 * preferred over keyword facts, and the interrupt budget simulated per user
 * per local day.
 */

import { describe, expect, it } from "vitest";
import type { FactsV1 } from "../judge/v3/policy-types.js";
import { UNKNOWN_RELATIONSHIP } from "../judge/v3/relationship.js";
import { type ReplayRow, replayPolicy } from "../judge/v3/replay.js";

const T0 = new Date("2026-10-30T01:00:00.000Z"); // 10:00 in Seoul
const HOUR = 3_600_000;
const at = (h: number) => new Date(T0.getTime() + h * HOUR);

const urgentFacts = (due: Date): FactsV1 => ({
  asks: [{ kind: "reply", object: "confirm", due: due.toISOString(), evidence: "by noon" }],
  addressedTo: "me_direct",
  threadTurn: "none",
  event: null,
  transaction: null,
  risk: [],
  kind: "work_thread",
  ambiguous: false,
});

function row(id: string, over: Partial<ReplayRow> = {}): ReplayRow {
  return {
    id,
    userId: "u1",
    receivedAt: T0,
    timeZone: "Asia/Seoul",
    v2Tier: "QUEUE",
    v2Source: "llm",
    manualOverride: false,
    email: { from: "Jane <jane@acme.com>", subject: "Project update", snippet: "", labels: [] },
    stored: null,
    ...over,
  };
}

describe("replayPolicy", () => {
  it("uses stored facts when present and keyword facts otherwise", () => {
    const report = replayPolicy(
      [row("a", { stored: { facts: urgentFacts(at(2)), relationship: null } }), row("b")],
      { budget: 5 },
    );
    expect(report.factsSource).toEqual({ stored: 1, keyword: 1 });
    expect(report.lanes.v3.PUSH).toBe(1);
    expect(report.changes).toEqual([
      expect.objectContaining({ id: "a", v2: "QUEUE", v3: "PUSH", factsSource: "stored" }),
    ]);
  });

  it("keeps the v2 lane for overrides, pins, the fast-path, sender priors and learned rules", () => {
    const stored = { facts: urgentFacts(at(1)), relationship: null };
    const report = replayPolicy(
      [
        row("override", { v2Tier: "SILENT", manualOverride: true, stored }),
        row("pin", { v2Tier: "INFO", v2Source: "pinned-rule", stored }),
        row("fast", { v2Tier: "SILENT", v2Source: "fast-path", stored }),
        row("prior", { v2Tier: "SILENT", v2Source: "sender-prior", stored }),
        row("rule", { v2Tier: "INFO", v2Source: "learned-rule", stored }),
      ],
      { budget: 5 },
    );
    expect(report.precedenceKept).toBe(5);
    expect(report.changes).toEqual([]);
  });

  it("holds PUSH past the budget per user per local day, most important first", () => {
    const rel = (sentCount: number) => ({ ...UNKNOWN_RELATIONSHIP, sentCount });
    const push = (id: string, h: number, sentCount: number, userId = "u1") =>
      row(id, {
        userId,
        receivedAt: at(h),
        stored: { facts: urgentFacts(at(h + 1)), relationship: rel(sentCount) },
      });
    const report = replayPolicy(
      [
        { ...push("d1-low", 0, 0), v2Tier: "PUSH" as const },
        push("d1-high", 1, 20),
        push("d1-mid", 2, 5),
        // 16:00 UTC = 01:00 next day in Seoul: a new budget day.
        push("d2", 15, 0),
        push("other-user", 0, 0, "u2"),
      ],
      { budget: 2 },
    );
    expect(report.budget).toMatchObject({
      limit: 2,
      candidates: 5,
      admitted: 4,
      held: 1,
      userDaysWithCandidates: 3,
      maxCandidatesPerUserDay: 3,
      userDaysOverBudget: 1,
    });
    expect(report.budget.heldIds).toEqual(["d1-low"]);
    expect(report.lanes.v3PreBudget.PUSH).toBe(5);
    expect(report.lanes.v3.PUSH).toBe(4);
    const heldChange = report.changes.find((c) => c.id === "d1-low");
    expect(heldChange).toMatchObject({ v2: "PUSH", v3: "QUEUE", held: true });
    expect(heldChange?.reasonCodes.slice(0, 2)).toEqual(["held_budget", "ask_due_soon"]);
  });

  it("does not budget pinned senders or manual overrides, as on the live push path", () => {
    const stored = { facts: urgentFacts(at(1)), relationship: null };
    const report = replayPolicy(
      [
        row("pin", { v2Tier: "PUSH", v2Source: "pinned-rule", stored }),
        row("override", { v2Tier: "PUSH", manualOverride: true, stored }),
        row("facts", { stored }),
      ],
      { budget: 1 },
    );
    expect(report.lanes.v3.PUSH).toBe(3);
    expect(report.budget).toMatchObject({ candidates: 1, held: 0 });
  });

  it("budgets nothing with no limit", () => {
    const report = replayPolicy(
      [1, 2, 3].map((i) =>
        row(`p${i}`, { stored: { facts: urgentFacts(at(1)), relationship: null } }),
      ),
      { budget: null },
    );
    expect(report.budget).toMatchObject({ held: 0, userDaysOverBudget: 0 });
  });

  it("re-checks keyword parity on every row and counts transitions", () => {
    const report = replayPolicy(
      [
        row("promo", {
          v2Tier: "SILENT",
          email: {
            from: "Shop <deals@shop.com>",
            subject: "Sale",
            labels: ["CATEGORY_PROMOTIONS"],
          },
        }),
        row("person", { email: { from: "Jane <jane@acme.com>", subject: "Lunch?", labels: [] } }),
      ],
      { budget: 5 },
    );
    expect(report.parity.compared).toBe(2);
    expect(report.parity.violations).toEqual({
      hidden: 0,
      lostPush: 0,
      machinePush: 0,
      newPush: 0,
    });
    expect(report.parity.v3Keyword.SILENT).toBe(1);
    expect(report.transitions).toEqual({ "SILENT→SILENT": 1, "QUEUE→QUEUE": 1 });
  });
});
