/**
 * v3 read fields (docs/design/attention-engine-v3.md §3(5)): the per-mail
 * block with ranks on a ranked QUEUE page, undecided mail, and Today's fields.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const listV3RowsByEmail = vi.hoisted(() => vi.fn());
const pageEmailIdsInLane = vi.hoisted(() => vi.fn());
const interruptBudgetStatus = vi.hoisted(() => vi.fn());
const resolveInboxScope = vi.hoisted(() => vi.fn(async () => ({ kind: "primary" })));
vi.mock("../judge/email-lanes.js", () => ({
  listV3RowsByEmail,
  pageEmailIdsInLane,
  resolveInboxScope,
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../judge/v3/push-budget-gate.js", () => ({ interruptBudgetStatus }));

import { v3BlocksFor, v3TodayFields } from "../judge/v3/read-fields.js";

const NOW = new Date("2026-11-07T09:00:00.000Z");

beforeEach(() => {
  listV3RowsByEmail.mockReset();
  pageEmailIdsInLane.mockReset();
  interruptBudgetStatus.mockReset();
});

describe("v3BlocksFor", () => {
  it("ranks a ranked QUEUE page from the first mail's rank, in list order", async () => {
    listV3RowsByEmail.mockResolvedValue(
      new Map([
        [
          "m1",
          {
            tier: "QUEUE",
            status: "OPEN",
            heldAt: NOW,
            isManualOverride: false,
            agentTierSetAt: null,
            v3PolicyVersion: "v3.0",
            v3Decision: { basis: "llm", threadTurn: "none", reasons: [] },
            v3Due: null,
          },
        ],
      ]),
    );
    const blocks = await v3BlocksFor(
      "u1",
      [
        { id: "m1", subject: "a" },
        { id: "m2", subject: "b" },
      ],
      21,
      NOW,
    );
    expect(blocks.get("m1")).toMatchObject({ rank: 21, held: true, policyVersion: "v3.0" });
    // Mail the judge has not reached: no decision, nothing held, still ranked.
    expect(blocks.get("m2")).toEqual({
      policyVersion: null,
      rank: 22,
      held: false,
      due: null,
      threadTurn: null,
      reasons: [],
    });
  });

  it("gives no rank outside a ranked QUEUE page", async () => {
    listV3RowsByEmail.mockResolvedValue(new Map());
    const blocks = await v3BlocksFor("u1", [{ id: "m1", subject: "a" }], null, NOW);
    expect(blocks.get("m1")?.rank).toBeNull();
  });
});

describe("v3TodayFields", () => {
  it("returns the day's budget, the QUEUE lane count for the scope and the ranking time", async () => {
    interruptBudgetStatus.mockResolvedValue({ limit: 5, used: 2, day: "2026-11-07" });
    pageEmailIdsInLane.mockResolvedValue({ ids: [], total: 37 });
    const scope = { kind: "primary" as const };
    expect(await v3TodayFields("u1", "primary", NOW)).toEqual({
      interruptBudget: { limit: 5, used: 2, day: "2026-11-07" },
      queueTotal: 37,
      rankedAt: NOW.toISOString(),
    });
    expect(pageEmailIdsInLane).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", lane: "QUEUE", scope, take: 0 }),
    );
    expect(resolveInboxScope).toHaveBeenCalledWith("u1", "primary");
  });

  it("is fail-soft: a failed read leaves the fields out instead of failing the response", async () => {
    resolveInboxScope.mockRejectedValueOnce(new Error("database unavailable"));
    expect(await v3TodayFields("u1", "primary", NOW)).toEqual({});
  });
});
