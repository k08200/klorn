/**
 * Proactive reply drafts (2026-09-28). Every draft is an LLM call the user
 * did not ask for, so the bounds ARE the feature: off by default, PUSH +
 * needs-reply only, daily cap, per-tick limit, one attempt per mail, the
 * paywall's entitlement, and never a throw into the scheduler tick.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  paywall: false,
  plan: "FREE",
  usedToday: 0,
  candidates: [] as { id: string; receivedAt: Date }[],
  pushIds: [] as string[],
  claimCount: 1,
  updates: [] as { where: Record<string, unknown>; data: Record<string, unknown> }[],
  candidateQueries: [] as unknown[],
  captured: [] as unknown[],
}));

vi.mock("../config.js", () => ({
  get PAYWALL_ENABLED() {
    return state.paywall;
  },
}));

vi.mock("../billing/stripe.js", () => ({
  isEntitled: (plan: string) => plan !== "FREE",
}));

vi.mock("../sentry.js", () => ({
  captureError: vi.fn((err: unknown) => {
    state.captured.push(err);
  }),
}));

vi.mock("../db.js", () => ({
  prisma: {
    user: { findUnique: vi.fn(async () => ({ plan: state.plan, role: "USER" })) },
    emailMessage: {
      count: vi.fn(async () => state.usedToday),
      findMany: vi.fn(async (args: unknown) => {
        state.candidateQueries.push(args);
        return state.candidates;
      }),
      updateMany: vi.fn(
        async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          state.updates.push(args);
          return { count: "proactiveDraftAt" in args.data ? state.claimCount : 1 };
        },
      ),
    },
    attentionItem: {
      findMany: vi.fn(async () => state.pushIds.map((sourceId) => ({ sourceId }))),
    },
  },
}));

import {
  proactiveDraftDailyCap,
  runProactiveDrafts,
  selectDraftTargets,
} from "../mail/proactive-drafts.js";

const NOW = new Date("2026-09-29T09:00:00Z");
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

beforeEach(() => {
  process.env.PROACTIVE_DRAFT_ENABLED = "true";
  delete process.env.PROACTIVE_DRAFT_DAILY_CAP;
  state.paywall = false;
  state.plan = "FREE";
  state.usedToday = 0;
  state.candidates = [
    { id: "e1", receivedAt: minutesAgo(30) },
    { id: "e2", receivedAt: minutesAgo(10) },
    { id: "e3", receivedAt: minutesAgo(20) },
  ];
  state.pushIds = ["e1", "e2", "e3"];
  state.claimCount = 1;
  state.updates.length = 0;
  state.candidateQueries.length = 0;
  state.captured.length = 0;
});

afterEach(() => {
  delete process.env.PROACTIVE_DRAFT_ENABLED;
  delete process.env.PROACTIVE_DRAFT_DAILY_CAP;
});

describe("selectDraftTargets", () => {
  const base = {
    candidates: [
      { id: "old", receivedAt: minutesAgo(60) },
      { id: "new", receivedAt: minutesAgo(5) },
      { id: "queue", receivedAt: minutesAgo(1) },
    ],
    pushIds: new Set(["old", "new"]),
    usedToday: 0,
    dailyCap: 5,
    perTick: 2,
  };

  it("PUSH lane only, newest first", () => {
    expect(selectDraftTargets(base)).toEqual(["new", "old"]);
  });

  it("is bounded by what is left of the daily cap, then by the per-tick limit", () => {
    expect(selectDraftTargets({ ...base, usedToday: 4 })).toEqual(["new"]);
    expect(selectDraftTargets({ ...base, usedToday: 5 })).toEqual([]);
    expect(selectDraftTargets({ ...base, usedToday: 9 })).toEqual([]);
    expect(selectDraftTargets({ ...base, perTick: 1 })).toEqual(["new"]);
  });
});

describe("proactiveDraftDailyCap", () => {
  it("defaults to 5; garbage and < 1 fall back; huge values clamp to 20", () => {
    expect(proactiveDraftDailyCap()).toBe(5);
    process.env.PROACTIVE_DRAFT_DAILY_CAP = "abc";
    expect(proactiveDraftDailyCap()).toBe(5);
    process.env.PROACTIVE_DRAFT_DAILY_CAP = "0";
    expect(proactiveDraftDailyCap()).toBe(5);
    process.env.PROACTIVE_DRAFT_DAILY_CAP = "3";
    expect(proactiveDraftDailyCap()).toBe(3);
    process.env.PROACTIVE_DRAFT_DAILY_CAP = "500";
    expect(proactiveDraftDailyCap()).toBe(20);
  });
});

describe("runProactiveDrafts", () => {
  it("is a no-op while the flag is off — no query, no LLM call", async () => {
    delete process.env.PROACTIVE_DRAFT_ENABLED;
    const draftFor = vi.fn(async () => "draft");
    expect(await runProactiveDrafts("u1", draftFor, NOW)).toBe(0);
    expect(draftFor).not.toHaveBeenCalled();
    expect(state.candidateQueries).toEqual([]);
  });

  it("drafts the two newest PUSH mails that need a reply, claiming each before the LLM call", async () => {
    const order: string[] = [];
    const draftFor = vi.fn(async (_userId: string, emailId: string) => {
      // The claim for this mail must already be written when the LLM runs.
      const claimed = state.updates.some(
        (u) => u.where.id === emailId && "proactiveDraftAt" in u.data,
      );
      order.push(`${emailId}:${claimed ? "claimed" : "unclaimed"}`);
      return `  reply to ${emailId}  `;
    });
    expect(await runProactiveDrafts("u1", draftFor, NOW)).toBe(2);
    expect(order).toEqual(["e2:claimed", "e3:claimed"]);
    const stored = state.updates.filter((u) => "proactiveDraft" in u.data);
    expect(stored.map((u) => [u.where.id, u.data.proactiveDraft])).toEqual([
      ["e2", "reply to e2"],
      ["e3", "reply to e3"],
    ]);
    // Every write is scoped to the user.
    expect(state.updates.every((u) => u.where.userId === "u1")).toBe(true);
  });

  it("only asks for fresh, unanswered, never-attempted mail that needs a reply", async () => {
    await runProactiveDrafts("u1", async () => "x", NOW);
    expect(state.candidateQueries[0]).toMatchObject({
      where: {
        userId: "u1",
        needsReply: true,
        repliedAt: null,
        proactiveDraftAt: null,
        receivedAt: { gte: new Date(NOW.getTime() - 6 * 60 * 60 * 1000) },
      },
    });
  });

  it("stops at the daily cap without touching the LLM", async () => {
    state.usedToday = 5;
    const draftFor = vi.fn(async () => "draft");
    expect(await runProactiveDrafts("u1", draftFor, NOW)).toBe(0);
    expect(draftFor).not.toHaveBeenCalled();
  });

  it("a mail another tick already claimed is skipped", async () => {
    state.claimCount = 0;
    const draftFor = vi.fn(async () => "draft");
    expect(await runProactiveDrafts("u1", draftFor, NOW)).toBe(0);
    expect(draftFor).not.toHaveBeenCalled();
  });

  it("paywall on: a non-entitled user gets no drafts; an entitled one does", async () => {
    state.paywall = true;
    const draftFor = vi.fn(async () => "draft");
    expect(await runProactiveDrafts("u1", draftFor, NOW)).toBe(0);
    expect(draftFor).not.toHaveBeenCalled();
    state.plan = "PRO";
    expect(await runProactiveDrafts("u1", draftFor, NOW)).toBe(2);
  });

  it("a budget error ends the sweep quietly; any other failure is captured and the next mail still runs", async () => {
    const capped = Object.assign(new Error("cap"), { name: "DailyCostCapExceededError" });
    const onBudget = vi.fn(async () => {
      throw capped;
    });
    expect(await runProactiveDrafts("u1", onBudget, NOW)).toBe(0);
    expect(onBudget).toHaveBeenCalledTimes(1);
    expect(state.captured).toEqual([]);

    state.updates.length = 0;
    let calls = 0;
    const flaky = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("provider 500");
      return "second works";
    });
    expect(await runProactiveDrafts("u1", flaky, NOW)).toBe(1);
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(state.captured).toHaveLength(1);
  });

  it("an empty draft stores nothing but the attempt still counts (no retry loop)", async () => {
    expect(await runProactiveDrafts("u1", async () => "   ", NOW)).toBe(0);
    expect(state.updates.filter((u) => "proactiveDraft" in u.data)).toEqual([]);
    expect(state.updates.filter((u) => "proactiveDraftAt" in u.data)).toHaveLength(2);
  });

  it("never throws into the scheduler tick", async () => {
    const { prisma } = await import("../db.js");
    vi.mocked(prisma.emailMessage.count).mockRejectedValueOnce(new Error("db down"));
    await expect(runProactiveDrafts("u1", async () => "x", NOW)).resolves.toBe(0);
    expect(state.captured).toHaveLength(1);
  });
});
