/**
 * Follow-ups to the judge budget reserve (#1442), 2026-10-21.
 *
 * 1. BYOK past the cap (founder decision 2026-10-15, LOCKED): a call the user's
 *    own key serves never meets the per-user daily cost cap. Past the cap the
 *    call runs on the user's key ALONE — the env providers are dropped from the
 *    chain — so a broken key can never fall through to Klorn's money uncapped.
 * 2. The background call-count cap (in-process, LLM_USER_BACKGROUND_DAILY_CAP)
 *    must not starve the judge either: with the reserve on, a new-mail judge
 *    call is not refused by the count; everything else still is.
 * 3. A budget refusal in the scheduler's summarize/intake/notify steps ends
 *    only that step, not the user's whole cycle (linked inboxes, the judge
 *    backfill and auto-reply come after it).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ledger = vi.hoisted(() => ({ cents: 0 }));
const chain = vi.hoisted(() => [] as unknown[]);

vi.mock("../providers/index.js", () => ({
  getProvider: vi.fn(() => null),
  getProviderChain: vi.fn(() => chain),
}));
vi.mock("../billing/cost-trip-alert.js", () => ({ notifyCostCapTrip: vi.fn(async () => {}) }));
vi.mock("../billing/llm-usage.js", () => ({
  recordLlmUsage: vi.fn(async () => {}),
  estimatePrebillCents: vi.fn(() => 0),
  trueUpCostLedgers: vi.fn(async () => {}),
}));
vi.mock("../db.js", () => ({
  prisma: {
    user: { findUnique: vi.fn(async () => null) },
    llmCostLedger: {
      findUnique: vi.fn(async () => ({ cents: ledger.cents })),
      upsert: vi.fn(async () => ({ cents: ledger.cents })),
    },
    globalCostLedger: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({ microCents: 0 })),
    },
  },
  db: {},
}));

const COMPLETION = {
  id: "c1",
  choices: [{ message: { role: "assistant", content: "{}" } }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
};
const PARAMS = {
  model: "google/gemini-2.5-flash",
  messages: [{ role: "user" as const, content: "x" }],
};

function provider(name: string, ownedByUser: boolean, call: () => Promise<unknown>) {
  return {
    name,
    quotaKey: `${ownedByUser ? "user" : "env"}-${name}`,
    defaultModel: "m",
    supportsTools: true,
    client: null,
    resolveModel: (m: string) => m,
    call: vi.fn(call),
    ownedByUser,
  };
}

const ENV_NAMES = [
  "DAILY_COST_CAP_CENTS",
  "JUDGE_BUDGET_RESERVE_CENTS",
  "LLM_BACKGROUND_MIN_INTERVAL_MS",
  "LLM_USER_BACKGROUND_DAILY_CAP",
] as const;
const ORIGINAL = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));

beforeEach(() => {
  ledger.cents = 0;
  chain.length = 0;
  process.env.DAILY_COST_CAP_CENTS = "100";
  process.env.LLM_BACKGROUND_MIN_INTERVAL_MS = "0";
  delete process.env.JUDGE_BUDGET_RESERVE_CENTS;
  delete process.env.LLM_USER_BACKGROUND_DAILY_CAP;
  vi.resetModules();
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = ORIGINAL[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.useRealTimers();
});

describe("BYOK past the per-user cost cap", () => {
  it("runs on the user's own key alone; the env provider is never called", async () => {
    ledger.cents = 100;
    const own = provider("openrouter", true, async () => COMPLETION);
    const env = provider("openrouter", false, async () => COMPLETION);
    chain.push(own, env);
    const { createCompletion } = await import("../llm/openai.js");

    await expect(createCompletion(PARAMS, { userId: "u1" })).resolves.toMatchObject({ id: "c1" });
    expect(own.call).toHaveBeenCalledTimes(1);
    expect(env.call).not.toHaveBeenCalled();
  });

  it("a broken own key past the cap fails — it does not fall through to Klorn's money", async () => {
    ledger.cents = 100;
    const own = provider("openrouter", true, async () => {
      throw Object.assign(new Error("401 invalid key"), { status: 401 });
    });
    const env = provider("openrouter", false, async () => COMPLETION);
    chain.push(own, env);
    const { createCompletion } = await import("../llm/openai.js");

    await expect(createCompletion(PARAMS, { userId: "u1" })).rejects.toBeTruthy();
    expect(env.call).not.toHaveBeenCalled();
  });

  it("below the cap a BYOK user keeps the env fallback, exactly as before", async () => {
    ledger.cents = 10;
    const own = provider("openrouter", true, async () => {
      throw Object.assign(new Error("401 invalid key"), { status: 401 });
    });
    const env = provider("openrouter", false, async () => COMPLETION);
    chain.push(own, env);
    const { createCompletion } = await import("../llm/openai.js");

    await expect(createCompletion(PARAMS, { userId: "u1" })).resolves.toMatchObject({ id: "c1" });
    expect(env.call).toHaveBeenCalledTimes(1);
  });

  it("a user without a key is still refused at the cap", async () => {
    ledger.cents = 100;
    const env = provider("openrouter", false, async () => COMPLETION);
    chain.push(env);
    const { createCompletion } = await import("../llm/openai.js");

    await expect(createCompletion(PARAMS, { userId: "u1" })).rejects.toMatchObject({
      name: "DailyCostCapExceededError",
    });
    expect(env.call).not.toHaveBeenCalled();
  });
});

describe("background call-count cap and the judge reserve", () => {
  async function exhaustBackground(cap: number) {
    process.env.LLM_USER_BACKGROUND_DAILY_CAP = String(cap);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 21, 12, 0, 0)));
    const limiter = await import("../billing/quota-limiter.js");
    limiter._resetAllUserWindowsForTests();
    for (let i = 0; i < cap; i++) {
      vi.advanceTimersByTime(60_000); // never trip the per-minute window
      limiter.checkAndRecordUserCall("u1", { priority: "background" });
    }
    vi.advanceTimersByTime(60_000);
    return limiter;
  }

  it("with the reserve on, a new-mail judge call is not refused by the count; anything else is", async () => {
    process.env.JUDGE_BUDGET_RESERVE_CENTS = "25";
    const limiter = await exhaustBackground(5);
    expect(() => limiter.checkAndRecordUserCall("u1", { priority: "background" })).toThrow(
      /background limit/,
    );
    expect(() =>
      limiter.checkAndRecordUserCall("u1", { priority: "background", reserved: true }),
    ).not.toThrow();
  });

  it("the judge's headroom is bounded: twice the background count, then it stops too", async () => {
    process.env.JUDGE_BUDGET_RESERVE_CENTS = "25";
    const limiter = await exhaustBackground(5);
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(60_000);
      limiter.checkAndRecordUserCall("u1", { priority: "background", reserved: true });
    }
    vi.advanceTimersByTime(60_000);
    expect(() =>
      limiter.checkAndRecordUserCall("u1", { priority: "background", reserved: true }),
    ).toThrow(/background limit/);
  });

  it("with the reserve off (the default), the judge is counted like every other call", async () => {
    const limiter = await exhaustBackground(5);
    expect(() =>
      limiter.checkAndRecordUserCall("u1", { priority: "background", reserved: true }),
    ).toThrow(/background limit/);
  });

  it("createCompletion hands its reserved flag to the count", async () => {
    process.env.JUDGE_BUDGET_RESERVE_CENTS = "25";
    await exhaustBackground(5);
    const env = provider("openrouter", false, async () => COMPLETION);
    chain.push(env);
    const { createCompletion } = await import("../llm/openai.js");

    await expect(
      createCompletion(PARAMS, { userId: "u1", priority: "background", reserved: true }),
    ).resolves.toMatchObject({ id: "c1" });
    await expect(
      createCompletion(PARAMS, { userId: "u1", priority: "background" }),
    ).rejects.toThrow(/background limit/);
  });
});

describe("runBudgetedExtras", () => {
  it("a budget refusal ends only its own step; any other error still propagates", async () => {
    const { runBudgetedExtras } = await import("../automation-scheduler.js");
    const capped = Object.assign(new Error("cap"), { name: "DailyCostCapExceededError" });
    const ran: string[] = [];

    const result = await runBudgetedExtras([
      async () => {
        ran.push("summarize");
        throw capped;
      },
      async () => {
        ran.push("intakes");
      },
      async () => {
        ran.push("notify");
      },
    ]);

    expect(result).toBe(true);
    expect(ran).toEqual(["summarize", "intakes", "notify"]);
    expect(await runBudgetedExtras([async () => {}])).toBe(false);
    await expect(
      runBudgetedExtras([
        async () => {
          throw new Error("token revoked");
        },
      ]),
    ).rejects.toThrow("token revoked");
  });
});
