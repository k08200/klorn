/**
 * Policy replay core (docs/design/attention-engine-v3.md §5): lane
 * distribution and per-item diff vs v2, precedence kept, each row decided by
 * the live rule (stored LLM facts, else the v2 lane, else keyword facts when
 * v2 itself fell back to keywords), and the interrupt budget simulated per
 * user per local day.
 */

import { describe, expect, it } from "vitest";
import type { StoredFacts } from "../judge/v3/facts-store.js";
import type { FactsV1, RelationshipSnapshot } from "../judge/v3/policy-types.js";
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

const llmRow = (facts: FactsV1, relationship: RelationshipSnapshot | null = null): StoredFacts => ({
  factsSource: "llm",
  facts,
  pre: null,
  signals: null,
  relationship,
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
  it("decides each row by the live rule: stored LLM facts, else the v2 lane or keyword facts", () => {
    const meeting = {
      from: "Jane <jane@acme.com>",
      subject: "Can we reschedule?",
      snippet: "",
      labels: [],
    };
    const report = replayPolicy(
      [
        row("a", { stored: llmRow(urgentFacts(at(2))) }),
        // No stored facts and a model v2 lane: the v2 lane stands.
        row("b", { v2Tier: "INFO" }),
        // v2 itself fell back to keywords: keyword facts decide.
        row("c", { v2Tier: "QUEUE", v2Source: "keyword-fallback", email: meeting }),
        // A "none" row (the extractor failed) is no LLM facts either.
        row("d", {
          v2Tier: "SILENT",
          stored: {
            factsSource: "none",
            facts: null,
            pre: null,
            signals: null,
            relationship: null,
          },
        }),
      ],
      { budget: 5 },
    );
    expect(report.factsMode).toBe("stored");
    expect(report.storedFacts).toEqual({ rows: 2, llm: 1 });
    expect(report.basis).toEqual({ llm: 1, keyword: 1, v2: 2 });
    expect(report.lanes.v3.PUSH).toBe(1);
    expect(report.changes).toEqual([
      expect.objectContaining({ id: "a", v2: "QUEUE", v3: "PUSH", basis: "llm" }),
      expect.objectContaining({ id: "c", v2: "QUEUE", v3: "MEETING", basis: "keyword" }),
    ]);
  });

  it("re-runs a named policy version, the parity block included", () => {
    const newsletter = {
      from: "Digest <digest@news.example>",
      subject: "Our newsletter is here",
      snippet: "",
      labels: [],
    };
    const stored: StoredFacts = {
      factsSource: "llm",
      facts: { ...urgentFacts(at(2)), asks: [], kind: "newsletter", addressedTo: "bulk" },
      pre: null,
      signals: null,
      relationship: null,
    };
    const rows = [row("n", { v2Tier: "SILENT", email: newsletter, stored })];
    const v30 = replayPolicy(rows, { budget: 5, policyVersion: "v3.0" });
    expect(v30.policyVersion).toBe("v3.0");
    expect(v30.lanes.v3PreBudget.SILENT).toBe(1);
    expect(v30.parity.divergences).not.toHaveProperty(["narrowSilent: SILENT→INFO"]);
    const v31 = replayPolicy(rows, { budget: 5 });
    expect(v31.policyVersion).toBe("v3.1");
    expect(v31.lanes.v3PreBudget.INFO).toBe(1);
  });

  it("keyword mode gives every row keyword facts (the model-down estimate)", () => {
    const report = replayPolicy([row("a", { stored: llmRow(urgentFacts(at(2))) }), row("b")], {
      budget: 5,
      facts: "keyword",
    });
    expect(report.factsMode).toBe("keyword");
    expect(report.basis).toEqual({ llm: 0, keyword: 2, v2: 0 });
  });

  it("keeps strangers to their share of the budget (trusted reserve)", () => {
    const stranger = (id: string, h: number) =>
      row(id, { receivedAt: at(h), stored: llmRow(urgentFacts(at(h + 1))) });
    const report = replayPolicy(
      [
        ...[0, 1, 2, 3, 4].map((h) => stranger(`s${h}`, h)),
        row("known", {
          receivedAt: at(5),
          stored: llmRow(urgentFacts(at(6)), { ...UNKNOWN_RELATIONSHIP, sentCount: 2 }),
        }),
      ],
      { budget: 5 },
    );
    // 2 of 5 reserved: three strangers get in, and so does the known sender.
    expect(report.budget).toMatchObject({ candidates: 6, admitted: 4, held: 2 });
    expect(report.budget.heldIds).not.toContain("known");
  });

  it("keeps the v2 lane for overrides, pins, the fast-path, sender priors and learned rules", () => {
    const stored = llmRow(urgentFacts(at(1)));
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
        stored: llmRow(urgentFacts(at(h + 1)), rel(sentCount)),
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
    const stored = llmRow(urgentFacts(at(1)));
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
      [1, 2, 3].map((i) => row(`p${i}`, { stored: llmRow(urgentFacts(at(1)), null) })),
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
