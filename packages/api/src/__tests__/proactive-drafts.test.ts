/**
 * Proactive reply drafts (2026-09-28). Every draft is an LLM call the user
 * did not ask for, so the bounds ARE the feature: off by default, an OPEN
 * PUSH item + needs-reply only, a hard daily cap, a per-sweep limit, one
 * attempt per mail, the paywall's entitlement, and never a throw into the
 * scheduler tick.
 *
 * The prisma mock is stateful on purpose: the slot counter and the per-mail
 * stamp behave like the conditional updates they are, so deleting a guard
 * from the implementation fails a test instead of passing by default.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Where = Record<string, unknown>;
type Data = Record<string, unknown>;

const state = vi.hoisted(() => ({
  paywall: false,
  plan: "FREE",
  counter: { day: null as string | null, count: 0 },
  stamps: new Map<string, Date | null>(),
  drafts: new Map<string, string>(),
  emails: [] as { id: string }[],
  pushIds: [] as string[],
  attentionQueries: [] as unknown[],
  emailQueries: [] as unknown[],
  emailWrites: [] as { where: Where; data: Data }[],
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

/** The user row's slot counter, as the three conditional updates see it. */
function userUpdateMany({ where, data }: { where: Where; data: Data }) {
  const counter = state.counter;
  if (Array.isArray(where.OR)) {
    // Day rollover: applies only while the stored day is stale.
    if (counter.day === data.proactiveDraftDay) return { count: 0 };
    counter.day = data.proactiveDraftDay as string;
    counter.count = data.proactiveDraftCount as number;
    return { count: 1 };
  }
  if (where.proactiveDraftDay !== counter.day) return { count: 0 };
  const bound = where.proactiveDraftCount as { lt?: number; gt?: number };
  if (bound.lt !== undefined) {
    if (counter.count >= bound.lt) return { count: 0 };
    counter.count += 1;
    return { count: 1 };
  }
  if (counter.count <= (bound.gt ?? 0)) return { count: 0 };
  counter.count -= 1;
  return { count: 1 };
}

/** EmailMessage writes: the guarded claim, its release, and the stored draft. */
function emailUpdateMany(args: { where: Where; data: Data }) {
  state.emailWrites.push(args);
  const id = args.where.id as string;
  if ("proactiveDraft" in args.data) {
    state.drafts.set(id, args.data.proactiveDraft as string);
    return { count: 1 };
  }
  const current = state.stamps.get(id) ?? null;
  const expected = args.where.proactiveDraftAt;
  // An unguarded write (no proactiveDraftAt in `where`) always applies —
  // which is exactly the bug the guard exists to prevent.
  const guardHolds =
    expected === undefined ||
    (expected === null ? current === null : current?.getTime() === (expected as Date).getTime());
  if (!guardHolds) return { count: 0 };
  state.stamps.set(id, args.data.proactiveDraftAt as Date | null);
  return { count: 1 };
}

vi.mock("../db.js", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => ({ plan: state.plan, role: "USER" })),
      updateMany: vi.fn(async (args: { where: Where; data: Data }) => userUpdateMany(args)),
    },
    emailMessage: {
      findMany: vi.fn(async (args: unknown) => {
        state.emailQueries.push(args);
        return state.emails;
      }),
      updateMany: vi.fn(async (args: { where: Where; data: Data }) => emailUpdateMany(args)),
    },
    attentionItem: {
      findMany: vi.fn(async (args: unknown) => {
        state.attentionQueries.push(args);
        return state.pushIds.map((sourceId) => ({ sourceId }));
      }),
    },
  },
}));

import {
  draftDayKey,
  proactiveDraftDailyCap,
  resetProactiveDraftStateForTests,
  runProactiveDrafts,
} from "../mail/proactive-drafts.js";

const NOW = new Date("2026-09-29T09:00:00Z");
const TODAY = "2026-09-29";
const minutesLater = (n: number) => new Date(NOW.getTime() + n * 60_000);
const named = (name: string) => Object.assign(new Error(name), { name });

beforeEach(() => {
  process.env.PROACTIVE_DRAFT_ENABLED = "true";
  delete process.env.PROACTIVE_DRAFT_DAILY_CAP;
  resetProactiveDraftStateForTests();
  state.paywall = false;
  state.plan = "FREE";
  state.counter = { day: null, count: 0 };
  state.stamps.clear();
  state.drafts.clear();
  // What the database returns: already filtered, newest first, two per sweep.
  state.emails = [{ id: "e2" }, { id: "e3" }];
  state.pushIds = ["e1", "e2", "e3"];
  state.attentionQueries.length = 0;
  state.emailQueries.length = 0;
  state.emailWrites.length = 0;
  state.captured.length = 0;
});

afterEach(() => {
  delete process.env.PROACTIVE_DRAFT_ENABLED;
  delete process.env.PROACTIVE_DRAFT_DAILY_CAP;
});

describe("proactiveDraftDailyCap / draftDayKey", () => {
  it("defaults to 5; garbage and < 1 fall back; huge values clamp to 20", () => {
    expect(proactiveDraftDailyCap()).toBe(5);
    for (const [raw, cap] of [
      ["abc", 5],
      ["0", 5],
      ["-3", 5],
      ["Infinity", 5],
      ["3", 3],
      ["7.9", 7],
      ["500", 20],
    ] as const) {
      process.env.PROACTIVE_DRAFT_DAILY_CAP = raw;
      expect(proactiveDraftDailyCap()).toBe(cap);
    }
  });

  it("the cap's window is the UTC calendar day", () => {
    expect(draftDayKey(new Date("2026-09-29T23:59:59Z"))).toBe("2026-09-29");
    expect(draftDayKey(new Date("2026-09-30T00:00:00Z"))).toBe("2026-09-30");
  });
});

describe("runProactiveDrafts — scope", () => {
  it("is a no-op while the flag is off — no query, no LLM call", async () => {
    delete process.env.PROACTIVE_DRAFT_ENABLED;
    const draftFor = vi.fn(async () => "draft");
    expect(await runProactiveDrafts("u1", draftFor, NOW)).toBe(0);
    expect(draftFor).not.toHaveBeenCalled();
    expect(state.attentionQueries).toEqual([]);
  });

  it("looks only at the user's OPEN PUSH email items (legacy CALL folds in)", async () => {
    await runProactiveDrafts("u1", async () => "x", NOW);
    expect(state.attentionQueries[0]).toMatchObject({
      where: { userId: "u1", source: "EMAIL", status: "OPEN", tier: { in: ["PUSH", "CALL"] } },
      select: { sourceId: true },
    });
  });

  it("then only fresh, unanswered, never-attempted mail that needs a reply — two, newest first", async () => {
    await runProactiveDrafts("u1", async () => "x", NOW);
    expect(state.emailQueries[0]).toMatchObject({
      where: {
        userId: "u1",
        id: { in: ["e1", "e2", "e3"] },
        needsReply: true,
        repliedAt: null,
        proactiveDraftAt: null,
        receivedAt: { gte: new Date(NOW.getTime() - 6 * 60 * 60 * 1000) },
      },
      orderBy: { receivedAt: "desc" },
      take: 2,
    });
  });

  it("no PUSH item means no email query and no LLM call", async () => {
    state.pushIds = [];
    const draftFor = vi.fn(async () => "draft");
    expect(await runProactiveDrafts("u1", draftFor, NOW)).toBe(0);
    expect(state.emailQueries).toEqual([]);
    expect(draftFor).not.toHaveBeenCalled();
  });

  it("paywall on: a non-entitled user gets no drafts and spends no slot; an entitled one does", async () => {
    state.paywall = true;
    const draftFor = vi.fn(async () => "draft");
    expect(await runProactiveDrafts("u1", draftFor, NOW)).toBe(0);
    expect(draftFor).not.toHaveBeenCalled();
    expect(state.counter.count).toBe(0);
    state.plan = "PRO";
    expect(await runProactiveDrafts("u1", draftFor, NOW)).toBe(2);
  });
});

describe("runProactiveDrafts — drafting", () => {
  it("claims each mail before the LLM call, stores the trimmed draft, scopes every write to the user", async () => {
    const seen: string[] = [];
    const draftFor = vi.fn(async (_userId: string, emailId: string) => {
      seen.push(`${emailId}:${state.stamps.get(emailId) ? "claimed" : "unclaimed"}`);
      return `  reply to ${emailId}  `;
    });
    expect(await runProactiveDrafts("u1", draftFor, NOW)).toBe(2);
    expect(seen).toEqual(["e2:claimed", "e3:claimed"]);
    expect([...state.drafts]).toEqual([
      ["e2", "reply to e2"],
      ["e3", "reply to e3"],
    ]);
    expect(state.emailWrites.every((write) => write.where.userId === "u1")).toBe(true);
    expect(state.counter).toEqual({ day: TODAY, count: 2 });
  });

  it("a mail another sweep already claimed is skipped and its slot handed back", async () => {
    state.stamps.set("e2", minutesLater(-1));
    const draftFor = vi.fn(async () => "draft");
    expect(await runProactiveDrafts("u1", draftFor, NOW)).toBe(1);
    expect(draftFor).toHaveBeenCalledTimes(1);
    expect(draftFor).toHaveBeenCalledWith("u1", "e3");
    expect(state.counter.count).toBe(1);
  });

  it("an empty draft stores nothing; the attempt and the slot stay spent (no retry loop)", async () => {
    expect(await runProactiveDrafts("u1", async () => "   ", NOW)).toBe(0);
    expect(state.drafts.size).toBe(0);
    expect(state.stamps.get("e2")).toEqual(NOW);
    expect(state.counter.count).toBe(2);
  });

  it("a real fault is captured, keeps its attempt spent, and the next mail still runs", async () => {
    let calls = 0;
    const flaky = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("provider 500");
      return "second works";
    });
    expect(await runProactiveDrafts("u1", flaky, NOW)).toBe(1);
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(state.captured).toHaveLength(1);
    expect(state.stamps.get("e2")).toEqual(NOW);
    expect(state.counter.count).toBe(2);
  });
});

describe("runProactiveDrafts — the daily cap is hard", () => {
  it("stops at the cap without touching the LLM", async () => {
    state.counter = { day: TODAY, count: 5 };
    const draftFor = vi.fn(async () => "draft");
    expect(await runProactiveDrafts("u1", draftFor, NOW)).toBe(0);
    expect(draftFor).not.toHaveBeenCalled();
    expect(state.stamps.size).toBe(0);
    expect(state.counter.count).toBe(5);
  });

  it("one slot left means one draft, even with two targets", async () => {
    state.counter = { day: TODAY, count: 4 };
    const draftFor = vi.fn(async () => "draft");
    expect(await runProactiveDrafts("u1", draftFor, NOW)).toBe(1);
    expect(draftFor).toHaveBeenCalledTimes(1);
    expect(state.counter.count).toBe(5);
  });

  it("deleting the drafted mail does not refill the cap — the count lives on the user row", async () => {
    state.counter = { day: TODAY, count: 5 };
    // The five drafted mails are gone; fresh PUSH mail arrives the same day.
    state.stamps.clear();
    state.emails = [{ id: "e8" }, { id: "e9" }];
    state.pushIds = ["e8", "e9"];
    const draftFor = vi.fn(async () => "draft");
    expect(await runProactiveDrafts("u1", draftFor, NOW)).toBe(0);
    expect(draftFor).not.toHaveBeenCalled();
  });

  it("a new UTC day starts a fresh count", async () => {
    state.counter = { day: "2026-09-28", count: 5 };
    expect(await runProactiveDrafts("u1", async () => "draft", NOW)).toBe(2);
    expect(state.counter).toEqual({ day: TODAY, count: 2 });
  });
});

describe("runProactiveDrafts — back-pressure", () => {
  it.each([
    "DailyCostCapExceededError",
    "UserRateLimitedError",
    "AllProvidersExhaustedError",
  ])("%s ends the sweep quietly and hands back the mail and the slot", async (name) => {
    const refused = vi.fn(async () => {
      throw named(name);
    });
    expect(await runProactiveDrafts("u1", refused, NOW)).toBe(0);
    expect(refused).toHaveBeenCalledTimes(1);
    expect(state.captured).toEqual([]);
    expect(state.stamps.get("e2")).toBeNull();
    expect(state.counter.count).toBe(0);
  });

  it("then pauses this user's sweeps for 15 minutes, and tries the same mail again after", async () => {
    const refused = vi.fn(async () => {
      throw named("DailyCostCapExceededError");
    });
    await runProactiveDrafts("u1", refused, NOW);
    const draftFor = vi.fn(async () => "draft");
    expect(await runProactiveDrafts("u1", draftFor, minutesLater(14))).toBe(0);
    expect(draftFor).not.toHaveBeenCalled();
    // Another user is not paused.
    expect(await runProactiveDrafts("u2", draftFor, minutesLater(1))).toBeGreaterThan(0);
    draftFor.mockClear();
    state.stamps.clear();
    expect(await runProactiveDrafts("u1", draftFor, minutesLater(16))).toBeGreaterThan(0);
    expect(draftFor).toHaveBeenCalledWith("u1", "e2");
  });
});

describe("runProactiveDrafts — robustness", () => {
  it("refuses a second sweep for a user while one is still running", async () => {
    let release: (value: string) => void = () => {};
    // Only the first mail's draft hangs; the rest answer at once.
    const slow = vi
      .fn(async () => "done")
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            release = resolve;
          }),
      );
    const first = runProactiveDrafts("u1", slow, NOW);
    await vi.waitFor(() => expect(slow).toHaveBeenCalledTimes(1));
    const overlapping = vi.fn(async () => "draft");
    expect(await runProactiveDrafts("u1", overlapping, NOW)).toBe(0);
    expect(overlapping).not.toHaveBeenCalled();
    release("done");
    await first;
  });

  it("never throws into the scheduler tick", async () => {
    const { prisma } = await import("../db.js");
    vi.mocked(prisma.attentionItem.findMany).mockRejectedValueOnce(new Error("db down"));
    await expect(runProactiveDrafts("u1", async () => "x", NOW)).resolves.toBe(0);
    expect(state.captured).toHaveLength(1);
    // The failed sweep did not leave the user locked out.
    expect(await runProactiveDrafts("u1", async () => "x", NOW)).toBe(2);
  });
});
