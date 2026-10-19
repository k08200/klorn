import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The judge must not be starved by the rest of the product.
 *
 * 2026-10-15: an OpenRouter top-up brought the LLM back at 22:07. By 22:28 the
 * founder's account had spent 101¢ against a 100¢ daily cap — almost all of it
 * chat/agent traffic on claude-sonnet-5 ($2.00/M against gemini-2.5-flash's
 * $0.30/M). The cost guard then blocked every paid call for the rest of the
 * UTC day, and the judge degraded to the keyword fallback, which structurally
 * cannot emit PUSH. The one lane the product is sold on went dark because a
 * side surface spent the budget first.
 *
 * `priority: "background"` already existed and is documented as stopping
 * background work from starving chat. It is wired to the concurrency pacer
 * only — `cost-guard.ts` never reads it — so there was no budget protection in
 * either direction, let alone for the judge.
 *
 * A reserved slice fixes the direction that matters: ordinary calls stop at
 * `cap - reserve`; calls marked reserved may use the whole cap.
 */

let mockRow: { cents: number } | null = null;
let mockUser: { plan: string; role: string | null } | null = null;
let upsertTotal = 0;

vi.mock("../db.js", () => ({
  prisma: {
    user: { findUnique: vi.fn(async () => mockUser) },
    llmCostLedger: {
      findUnique: vi.fn(async () => mockRow),
      upsert: vi.fn(async () => ({ cents: upsertTotal })),
    },
    globalCostLedger: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({})) },
  },
}));

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
const alerts = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock("../billing/cost-trip-alert.js", () => ({ notifyCostCapTrip: alerts.notify }));

const ENV = [
  "DAILY_COST_CAP_CENTS",
  "FREE_DAILY_COST_CAP_CENTS",
  "JUDGE_BUDGET_RESERVE_CENTS",
  "PAYWALL_ENABLED",
] as const;
const ORIGINAL: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) ORIGINAL[k] = process.env[k];
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
  mockRow = null;
  mockUser = null;
  upsertTotal = 0;
  alerts.notify.mockClear();
  vi.restoreAllMocks();
});

async function gate(opts?: { reserved?: boolean }) {
  const { checkCostGate } = await import("../billing/cost-guard.js");
  return checkCostGate("user-1", opts);
}

describe("judge budget reserve", () => {
  beforeEach(() => {
    process.env.DAILY_COST_CAP_CENTS = "100";
    process.env.JUDGE_BUDGET_RESERVE_CENTS = "25";
    delete process.env.PAYWALL_ENABLED;
  });

  it("lets ordinary calls spend up to the cap minus the reserve", async () => {
    mockRow = { cents: 74 };
    const result = await gate();
    expect(result.allowed).toBe(true);
    expect(result.remainingCents).toBe(1);
  });

  // The exact 2026-10-15 shape: chat has eaten everything it is allowed to.
  it("blocks ordinary calls once the unreserved budget is gone", async () => {
    mockRow = { cents: 75 };
    const result = await gate();
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/75/);
  });

  it("still admits a reserved call at that point — this is the whole fix", async () => {
    mockRow = { cents: 75 };
    const result = await gate({ reserved: true });
    expect(result.allowed).toBe(true);
    expect(result.remainingCents).toBe(25);
  });

  it("blocks a reserved call only at the real cap", async () => {
    mockRow = { cents: 100 };
    await expect(gate({ reserved: true })).resolves.toMatchObject({ allowed: false });
  });

  it("reports the cap it actually enforced, so logs are not misleading", async () => {
    mockRow = { cents: 10 };
    await expect(gate()).resolves.toMatchObject({ capCents: 75 });
    await expect(gate({ reserved: true })).resolves.toMatchObject({ capCents: 100 });
  });
});

describe("judge budget reserve — edges", () => {
  beforeEach(() => {
    delete process.env.PAYWALL_ENABLED;
  });

  it("is off by default, so nothing changes for anyone who does not set it", async () => {
    process.env.DAILY_COST_CAP_CENTS = "100";
    delete process.env.JUDGE_BUDGET_RESERVE_CENTS;
    mockRow = { cents: 99 };
    await expect(gate()).resolves.toMatchObject({ allowed: true });
  });

  // A reserve at or above the cap would leave ordinary calls nothing at all —
  // a misconfiguration that would read as "chat is broken", not "reserve is
  // too big". Clamp instead of handing someone a dead product.
  it("clamps a reserve that would starve everything else", async () => {
    process.env.DAILY_COST_CAP_CENTS = "100";
    process.env.JUDGE_BUDGET_RESERVE_CENTS = "500";
    mockRow = { cents: 0 };
    const result = await gate();
    expect(result.allowed).toBe(true);
    expect(result.capCents).toBeGreaterThan(0);
  });

  it("leaves the cap-disabled escape hatch alone", async () => {
    process.env.DAILY_COST_CAP_CENTS = "0";
    process.env.JUDGE_BUDGET_RESERVE_CENTS = "25";
    mockRow = { cents: 9999 };
    await expect(gate()).resolves.toMatchObject({ allowed: true });
    await expect(gate({ reserved: true })).resolves.toMatchObject({ allowed: true });
  });

  // The free tier's whole cap is 10¢; a 25¢ reserve must not invert it.
  it("does not invert the free-tier cap", async () => {
    process.env.PAYWALL_ENABLED = "true";
    process.env.DAILY_COST_CAP_CENTS = "100";
    process.env.FREE_DAILY_COST_CAP_CENTS = "10";
    process.env.JUDGE_BUDGET_RESERVE_CENTS = "25";
    mockUser = { plan: "FREE", role: null };
    mockRow = { cents: 0 };
    const result = await gate();
    expect(result.allowed).toBe(true);
    // Pinned, not just bounded: the clamp HALVES the free tier's ordinary
    // budget (min(25, floor(10/2)) = 5). That is a real cost of turning the
    // reserve on and it should break this test if it ever changes silently.
    expect(result.capCents).toBe(5);
  });
});

describe("the judge is actually wired to the reserve", () => {
  // A reserve nothing opts into protects nothing. This asserts the wiring,
  // not the arithmetic: the judge's own call site must mark itself reserved,
  // and CompletionOptions must carry it.
  it("poc-judge reserves new-mail judgements and not backlog repair", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../judge/poc-judge.ts", import.meta.url), "utf8");
    // The contract, not a literal: `reserved` follows the caller's backlog
    // flag, so a sweep over old rows can never reach the judge's slice.
    expect(src).toMatch(/reserved:\s*!backlog/);
  });

  it("repair and eval loops over old mail opt out of the reserve", async () => {
    // judgeEmail reserves by default (backlog=false), so every loop that
    // re-judges stored rows must say so — same risk class as the fallback sweep.
    const { readFileSync } = await import("node:fs");
    for (const file of [
      "../judge/fallback-rejudge.ts",
      "../judge/rejudge-open-items.ts",
      "../learning/correction-eval.ts",
    ]) {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      expect({ file, optsOut: /backlog:\s*true/.test(src) }).toEqual({ file, optsOut: true });
    }
  });

  it("no other surface claims the reserve", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = new URL("..", import.meta.url).pathname;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          if (entry === "__tests__" || entry === "node_modules") continue;
          walk(path);
          continue;
        }
        if (!entry.endsWith(".ts")) continue;
        // The judge may claim it; openai.ts and cost-guard.ts define it.
        if (path.includes("judge/poc-judge.ts")) continue;
        if (path.includes("llm/openai.ts") || path.includes("billing/cost-guard.ts")) continue;
        if (/reserved:\s*true/.test(readFileSync(path, "utf8"))) offenders.push(path);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

describe("cap-trip alerting with a reserve active", () => {
  beforeEach(() => {
    process.env.DAILY_COST_CAP_CENTS = "100";
    process.env.JUDGE_BUDGET_RESERVE_CENTS = "25";
    delete process.env.PAYWALL_ENABLED;
  });

  // The alert dedupes once per user per UTC day. If the ordinary trip at 75¢
  // spends that budget, the real ceiling alert at 100¢ — the one that means
  // the judge has gone dark — is swallowed for the rest of the day. That is
  // this PR's own failure mode ("nothing looked broken") reappearing in the
  // alerting layer. It is also false at 75¢: the judge still has 25¢, so the
  // alert's "judge degrades to keyword fallback" wording would be a lie.
  it("does not alert when an ordinary call stops at the reserve boundary", async () => {
    mockRow = { cents: 80 };
    const result = await gate();
    expect(result.allowed).toBe(false);
    expect(alerts.notify).not.toHaveBeenCalled();
  });

  it("alerts when the real ceiling is reached", async () => {
    mockRow = { cents: 100 };
    const result = await gate({ reserved: true });
    expect(result.allowed).toBe(false);
    expect(alerts.notify).toHaveBeenCalledTimes(1);
    expect(alerts.notify.mock.calls[0][0]).toMatchObject({ capCents: 100 });
  });

  it("still alerts at the cap when no reserve is configured", async () => {
    process.env.JUDGE_BUDGET_RESERVE_CENTS = "0";
    mockRow = { cents: 100 };
    await gate();
    expect(alerts.notify).toHaveBeenCalledTimes(1);
  });
});

describe("the post-increment re-check honours the reserve", () => {
  beforeEach(() => {
    process.env.DAILY_COST_CAP_CENTS = "100";
    process.env.JUDGE_BUDGET_RESERVE_CENTS = "25";
    delete process.env.PAYWALL_ENABLED;
  });

  // Without this, the reserve lived only on the read side: several ordinary
  // calls that all passed checkCostGate at 74¢ could each pre-bill and settle
  // past 75¢, eating the judge's slice before the judge ever asked for it.
  it("reports overCap for an ordinary call that lands past the reserve line", async () => {
    upsertTotal = 80;
    const { recordCostUsage } = await import("../billing/cost-guard.js");
    const usage = await recordCostUsage("user-1", 1, "google/gemini-2.5-flash");
    expect(usage?.overCap).toBe(true);
  });

  it("does not report overCap for a reserved call at the same total", async () => {
    upsertTotal = 80;
    const { recordCostUsage } = await import("../billing/cost-guard.js");
    const usage = await recordCostUsage("user-1", 1, "google/gemini-2.5-flash", {
      reserved: true,
    });
    expect(usage?.overCap).toBe(false);
  });

  it("does not alert when an ordinary call crosses only the reserve line", async () => {
    upsertTotal = 80;
    const { recordCostUsage } = await import("../billing/cost-guard.js");
    await recordCostUsage("user-1", 1, "google/gemini-2.5-flash");
    expect(alerts.notify).not.toHaveBeenCalled();
  });

  it("alerts when a reserved call crosses the real ceiling", async () => {
    upsertTotal = 101;
    const { recordCostUsage } = await import("../billing/cost-guard.js");
    await recordCostUsage("user-1", 1, "google/gemini-2.5-flash", { reserved: true });
    expect(alerts.notify).toHaveBeenCalledTimes(1);
  });
});

describe("backlog repair cannot spend the judge's slice", () => {
  // 2026-10-16: sweepFallbackRejudge drained both users' entire daily cap
  // before 05:00 UTC re-judging 40 days of keyword-fallback rows (~3.5 LLM
  // calls per row through the dial). Every message that arrived afterwards was
  // classified by keywords — the outage this reserve exists to prevent, caused
  // by the repair for that same outage. The sweep calls judgeEmail, so without
  // an opt-out it inherits the judge's reserved marker and eats the slice.
  it("the sweep marks its judgeEmail call as backlog", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../judge/fallback-rejudge.ts", import.meta.url), "utf8");
    expect(src).toMatch(/backlog:\s*true/);
  });

  it("a backlog call is refused at the reserve line where new mail still passes", async () => {
    process.env.DAILY_COST_CAP_CENTS = "100";
    process.env.JUDGE_BUDGET_RESERVE_CENTS = "25";
    delete process.env.PAYWALL_ENABLED;
    mockRow = { cents: 80 };

    // judgeEmail passes reserved: !backlog, so backlog repair arrives here as
    // an ordinary call and new-mail classification as a reserved one.
    const backlogCall = await gate();
    const newMailCall = await gate({ reserved: true });

    expect(backlogCall.allowed).toBe(false);
    expect(newMailCall.allowed).toBe(true);
    expect(newMailCall.remainingCents).toBe(20);
  });
});
