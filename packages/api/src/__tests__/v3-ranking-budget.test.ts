/**
 * Policy v3 attention layer: importance prior (until P5), QUEUE ranking
 * (the Today list) and the daily PUSH interrupt budget.
 * docs/design/attention-engine-v3.md §3(4), §8 (budget default 5/day).
 */

import { describe, expect, it } from "vitest";
import { IMPORTANCE_PRIOR, importancePrior } from "../judge/v3/importance.js";
import {
  allocateInterruptBudget,
  claimInterruptSlot,
  DEFAULT_INTERRUPT_BUDGET,
  interruptSlotKey,
  localDayKey,
  resolveInterruptBudget,
} from "../judge/v3/interrupt-budget.js";
import type { FactsV1, RelationshipSnapshot } from "../judge/v3/policy-types.js";
import {
  deadlineProximity,
  earliestDue,
  type RankableItem,
  rankDue,
  rankQueue,
  rankScore,
} from "../judge/v3/ranking.js";
import { genRelationship, mulberry32, pick } from "./helpers/v3-facts-gen.js";

const NOW = new Date("2026-10-31T09:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const inHours = (h: number) => new Date(NOW.getTime() + h * HOUR).toISOString();

const unknown: RelationshipSnapshot = {
  sentCount: null,
  lastSentAt: null,
  medianReplyLatencyMs: null,
  sameOrgDomain: null,
  coAttendanceNext14d: null,
  pinned: null,
  vip: null,
  dismissCount: null,
};

describe("importancePrior", () => {
  it("is the unknown-sender base with no relationship data", () => {
    expect(importancePrior(null, NOW)).toBe(IMPORTANCE_PRIOR.unknown);
    expect(importancePrior(unknown, NOW)).toBe(IMPORTANCE_PRIOR.unknown);
  });

  it("is 1 for a VIP sender; a pin alone adds nothing (a pin sets the lane, not importance)", () => {
    expect(importancePrior({ ...unknown, vip: true, dismissCount: 50 }, NOW)).toBe(1);
    expect(importancePrior({ ...unknown, pinned: true }, NOW)).toBe(IMPORTANCE_PRIOR.unknown);
  });

  it("a frequent, recent correspondent outranks a stranger; dismissals pull down", () => {
    const close = { ...unknown, sentCount: 20, lastSentAt: inHours(-24), sameOrgDomain: true };
    const stranger = { ...unknown, sentCount: 0 };
    expect(importancePrior(close, NOW)).toBeGreaterThan(importancePrior(stranger, NOW));
    expect(importancePrior({ ...stranger, dismissCount: 5 }, NOW)).toBeLessThan(
      importancePrior(stranger, NOW),
    );
  });

  it("stays in [0, 1] and is monotone in sent count (property)", () => {
    const rng = mulberry32(11);
    for (let i = 0; i < 3000; i++) {
      const rel = genRelationship(rng, NOW);
      const v = importancePrior(rel, NOW);
      expect(v, `case ${i}`).toBeGreaterThanOrEqual(0);
      expect(v, `case ${i}`).toBeLessThanOrEqual(1);
      if (rel && rel.sentCount !== null) {
        const more = importancePrior({ ...rel, sentCount: rel.sentCount + 5 }, NOW);
        expect(more, `case ${i}`).toBeGreaterThanOrEqual(v);
      }
    }
  });
});

describe("deadline proximity and earliestDue", () => {
  it("is 1 with no due date or a due date a week or more away, 2 when due now or overdue", () => {
    expect(deadlineProximity(null, NOW)).toBe(1);
    expect(deadlineProximity(inHours(7 * 24), NOW)).toBe(1);
    expect(deadlineProximity(inHours(0), NOW)).toBe(2);
    expect(deadlineProximity(inHours(-50), NOW)).toBe(2);
    expect(deadlineProximity(inHours(84), NOW)).toBeCloseTo(1.5, 5);
    expect(deadlineProximity("garbage", NOW)).toBe(1);
  });

  it("earliestDue picks the earliest valid ask deadline", () => {
    expect(earliestDue([])).toBeNull();
    expect(
      earliestDue([
        { kind: "reply", object: "", due: inHours(30), evidence: "a" },
        { kind: "pay", object: "", due: "nope", evidence: "b" },
        { kind: "review", object: "", due: inHours(3), evidence: "c" },
        { kind: "decide", object: "", due: null, evidence: "d" },
      ]),
    ).toBe(inHours(3));
  });
});

const item = (over: Partial<RankableItem> & { id: string }): RankableItem => ({
  receivedAt: NOW,
  importance: IMPORTANCE_PRIOR.unknown,
  due: null,
  heldAt: null,
  ...over,
});

describe("rankDue", () => {
  const facts = (over: Partial<FactsV1>): FactsV1 => ({
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

  it("is the earliest ask deadline, else 'now' for a payment/security risk, else null", () => {
    const ask = { kind: "pay" as const, object: "", due: inHours(10), evidence: "by Friday" };
    expect(rankDue(facts({ asks: [ask], risk: ["payment_failed"] }), NOW)).toBe(inHours(10));
    expect(rankDue(facts({ risk: ["payment_failed"] }), NOW)).toBe(NOW.toISOString());
    expect(rankDue(facts({ risk: ["security_alert", "phishing_suspect"] }), NOW)).toBeNull();
    expect(rankDue(facts({ risk: ["account_change"] }), NOW)).toBeNull();
    expect(rankDue(facts({}), NOW)).toBeNull();
  });
});

describe("rankQueue", () => {
  it("puts held items first (equal importance: in the order held), then importance × deadline", () => {
    const ranked = rankQueue(
      [
        item({ id: "stranger" }),
        item({ id: "boss", importance: 0.9 }),
        item({ id: "held-2", heldAt: new Date(NOW.getTime() - HOUR) }),
        item({ id: "due-soon", importance: 0.5, due: inHours(2) }),
        item({ id: "held-1", heldAt: new Date(NOW.getTime() - 2 * HOUR) }),
      ],
      NOW,
    );
    expect(ranked.map((r) => r.id)).toEqual(["held-1", "held-2", "due-soon", "boss", "stranger"]);
  });

  it("orders held items by importance before the order they were held", () => {
    const ranked = rankQueue(
      [
        item({ id: "stranger-held-first", heldAt: new Date(NOW.getTime() - 3 * HOUR) }),
        item({ id: "known-held-later", importance: 0.8, heldAt: new Date(NOW.getTime() - HOUR) }),
      ],
      NOW,
    );
    expect(ranked.map((r) => r.id)).toEqual(["known-held-later", "stranger-held-first"]);
  });

  it("breaks ties by newer mail first, then id", () => {
    const ranked = rankQueue(
      [
        item({ id: "b", receivedAt: new Date(NOW.getTime() - DAY) }),
        item({ id: "a", receivedAt: NOW }),
        item({ id: "c", receivedAt: NOW }),
      ],
      NOW,
    );
    expect(ranked.map((r) => r.id)).toEqual(["a", "c", "b"]);
  });

  it("is a stable total order: a permutation, input-order independent, sorted by score (property)", () => {
    const rng = mulberry32(21);
    for (let run = 0; run < 200; run++) {
      const items = Array.from({ length: 12 }, (_, i) =>
        item({
          id: `i${i}`,
          importance: Math.round(rng() * 10) / 10,
          due: pick(rng, [null, inHours(-5), inHours(10), inHours(100), inHours(500)]),
          receivedAt: new Date(NOW.getTime() - Math.floor(rng() * 5) * DAY),
          heldAt: rng() < 0.2 ? new Date(NOW.getTime() - Math.floor(rng() * 10) * HOUR) : null,
        }),
      );
      const shuffled = [...items].sort(() => rng() - 0.5);
      const a = rankQueue(items, NOW);
      const b = rankQueue(shuffled, NOW);
      expect(
        b.map((x) => x.id),
        `run ${run}`,
      ).toEqual(a.map((x) => x.id));
      expect(new Set(a.map((x) => x.id)).size).toBe(items.length);
      const firstUnheld = a.findIndex((x) => x.heldAt === null);
      if (firstUnheld >= 0)
        expect(
          a.slice(firstUnheld).every((x) => x.heldAt === null),
          `run ${run}`,
        ).toBe(true);
      const unheld = a.filter((x) => x.heldAt === null);
      for (let k = 1; k < unheld.length; k++) {
        expect(rankScore(unheld[k - 1], NOW), `run ${run}`).toBeGreaterThanOrEqual(
          rankScore(unheld[k], NOW),
        );
      }
    }
  });

  it("does not mutate its input", () => {
    const input = [item({ id: "x", importance: 0.1 }), item({ id: "y", importance: 0.9 })];
    const before = input.map((i) => i.id);
    rankQueue(input, NOW);
    expect(input.map((i) => i.id)).toEqual(before);
  });
});

describe("interrupt budget configuration", () => {
  it("defaults to the founder's 5 per day", () => {
    expect(DEFAULT_INTERRUPT_BUDGET).toBe(5);
    expect(resolveInterruptBudget({})).toBe(5);
  });

  it("reads JUDGE_V3_PUSH_BUDGET: a positive integer, or 'unlimited'; anything else is the default", () => {
    expect(resolveInterruptBudget({ JUDGE_V3_PUSH_BUDGET: "3" })).toBe(3);
    expect(resolveInterruptBudget({ JUDGE_V3_PUSH_BUDGET: "unlimited" })).toBeNull();
    for (const bad of ["0", "-2", "2.5", "lots", ""]) {
      expect(resolveInterruptBudget({ JUDGE_V3_PUSH_BUDGET: bad })).toBe(5);
    }
  });

  it("keys the day in the user's own zone", () => {
    const lateUtc = new Date("2026-10-31T20:00:00.000Z");
    expect(localDayKey(lateUtc, "Asia/Seoul")).toEqual({
      dayKey: "2026-11-01",
      zone: "Asia/Seoul",
    });
    expect(localDayKey(lateUtc, "America/Los_Angeles")).toEqual({
      dayKey: "2026-10-31",
      zone: "America/Los_Angeles",
    });
  });

  it("falls back to UTC for an invalid zone and says so", () => {
    expect(localDayKey(NOW, "Mars/Olympus")).toEqual({ dayKey: "2026-10-31", zone: "UTC" });
  });
});

describe("allocateInterruptBudget (batch / replay)", () => {
  const cand = (id: string, importance: number, minutes = 0) => ({
    id,
    importance,
    receivedAt: new Date(NOW.getTime() + minutes * 60_000),
  });

  it("admits by importance, then arrival, until the day's budget is spent", () => {
    const r = allocateInterruptBudget(
      [cand("low", 0.1), cand("high", 0.9), cand("mid", 0.5, 1), cand("mid0", 0.5)],
      {
        used: 3,
        limit: 5,
      },
    );
    expect(r.admitted).toEqual(["high", "mid0"]);
    expect(r.held).toEqual(["mid", "low"]);
  });

  it("admits everything with no limit", () => {
    const r = allocateInterruptBudget([cand("a", 0.1), cand("b", 0.2)], { used: 99, limit: null });
    expect(r.held).toEqual([]);
  });

  it("never exceeds the budget and admits the most important (property)", () => {
    const rng = mulberry32(31);
    for (let run = 0; run < 2000; run++) {
      const limit = Math.floor(rng() * 8) + 1;
      const used = Math.floor(rng() * 10);
      const cands = Array.from({ length: Math.floor(rng() * 10) }, (_, i) =>
        cand(`c${i}`, rng(), i),
      );
      const r = allocateInterruptBudget(cands, { used, limit });
      expect(used + r.admitted.length <= Math.max(limit, used), `run ${run}`).toBe(true);
      expect([...r.admitted, ...r.held].sort(), `run ${run}`).toEqual(
        cands.map((c) => c.id).sort(),
      );
      const imp = new Map(cands.map((c) => [c.id, c.importance]));
      const minAdmitted = Math.min(...r.admitted.map((id) => imp.get(id) ?? 0));
      for (const id of r.held)
        expect(imp.get(id) ?? 0, `run ${run}`).toBeLessThanOrEqual(minAdmitted);
    }
  });
});

describe("claimInterruptSlot (live, atomic)", () => {
  /** An in-memory stand-in for Notification's (userId, dedupeKey) unique index. */
  function store() {
    const keys = new Set<string>();
    return {
      keys,
      countUsed: async (prefix: string) => [...keys].filter((k) => k.startsWith(prefix)).length,
      tryCreate: async (key: string) => {
        await Promise.resolve();
        if (keys.has(key)) return "taken" as const;
        keys.add(key);
        return "created" as const;
      },
    };
  }

  it("claims the next free slot and reports held once the budget is spent", async () => {
    const s = store();
    const claims = [];
    for (let i = 0; i < 7; i++)
      claims.push(await claimInterruptSlot({ dayKey: "2026-10-31", limit: 5, ...s }));
    expect(claims.map((c) => c.status)).toEqual([
      "admitted",
      "admitted",
      "admitted",
      "admitted",
      "admitted",
      "held",
      "held",
    ]);
    expect(claims[0]).toEqual({
      status: "admitted",
      dedupeKey: interruptSlotKey("2026-10-31", 1),
      used: 1,
    });
    expect(claims[6]).toEqual({ status: "held", used: 5 });
  });

  it("concurrent claims never exceed the budget (property)", async () => {
    const rng = mulberry32(41);
    for (let run = 0; run < 100; run++) {
      const s = store();
      const limit = Math.floor(rng() * 6) + 1;
      const n = Math.floor(rng() * 15) + 1;
      const results = await Promise.all(
        Array.from({ length: n }, () => claimInterruptSlot({ dayKey: "2026-10-31", limit, ...s })),
      );
      const admitted = results.filter((r) => r.status === "admitted").length;
      expect(admitted, `run ${run}`).toBe(Math.min(n, limit));
      expect(s.keys.size, `run ${run}`).toBe(Math.min(n, limit));
    }
  });

  it("with no limit, still records a slot so the day's count stays exact", async () => {
    const s = store();
    for (let i = 0; i < 9; i++)
      await claimInterruptSlot({ dayKey: "2026-10-31", limit: null, ...s });
    expect(s.keys.size).toBe(9);
  });
});
