/**
 * POST /api/playground/classify — key-free demo mode (server-paid).
 *
 * The BYOK playground is a wall for ordinary visitors (no OpenRouter key = no
 * demo). Behind the OFF-by-default PLAYGROUND_NO_KEY_DEMO_ENABLED flag, a
 * request WITHOUT an apiKey runs on the server's own keys with triple defense:
 *   1. Per-IP rate limit: 3/minute AND 10/day (in-memory).
 *   2. Global daily demo budget in fractional cents (DEMO_DAILY_BUDGET_CENTS,
 *      default 50 = $0.50/day), pre-charged per call at the measured ~0.19¢
 *      flash-classify cost. Exhausted → 429 demo_budget_exhausted + a
 *      byokAvailable hint so the landing falls back to the key UI.
 *   3. Model pinned to the server default (JUDGE_MODEL): a visitor-supplied
 *      model/provider is ignored on the no-key path.
 * Flag OFF (default) → key-free requests get 401 key_required and the LLM is
 * never called; the BYOK path is byte-for-byte unchanged either way.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const judgeEmail = vi.hoisted(() => vi.fn());
const configState = vi.hoisted(() => ({ demoEnabled: false, demoBudgetCents: 50 }));

vi.mock("../judge/poc-judge.js", () => ({ judgeEmail }));
vi.mock("../config.js", () => ({
  get PLAYGROUND_NO_KEY_DEMO_ENABLED() {
    return configState.demoEnabled;
  },
  get DEMO_DAILY_BUDGET_CENTS() {
    return configState.demoBudgetCents;
  },
}));

import { _resetPlaygroundDemoState, playgroundRoutes } from "../routes/playground.js";

const LLM_VERDICT = {
  tier: "PUSH",
  reason: "Investor asking for a same-day reply",
  features: { confidence: 0.9, senderTrust: 0.8, reversibility: 0.2, urgency: 0.9 },
  source: "llm",
};

const DEMO_PAYLOAD = {
  from: "VC <partner@fund.com>",
  subject: "Can we talk today?",
  snippet: "Need a decision by EOD.",
};

async function buildApp() {
  const app = Fastify();
  await app.register(playgroundRoutes, { prefix: "/api/playground" });
  return app;
}

function inject(app: Awaited<ReturnType<typeof buildApp>>, payload: object) {
  return app.inject({ method: "POST", url: "/api/playground/classify", payload });
}

let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  judgeEmail.mockReset();
  judgeEmail.mockResolvedValue(LLM_VERDICT);
  configState.demoEnabled = true;
  configState.demoBudgetCents = 50;
  _resetPlaygroundDemoState();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  logSpy.mockRestore();
  vi.useRealTimers();
});

describe("no-key demo — flag gate", () => {
  it("returns 401 key_required and never calls the LLM when the flag is OFF", async () => {
    configState.demoEnabled = false;
    const app = await buildApp();
    const res = await inject(app, DEMO_PAYLOAD);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("key_required");
    expect(judgeEmail).not.toHaveBeenCalled();
    await app.close();
  });

  it("classifies without a key when the flag is ON", async () => {
    const app = await buildApp();
    const res = await inject(app, DEMO_PAYLOAD);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(LLM_VERDICT);
    await app.close();
  });
});

describe("no-key demo — server-paid call shape", () => {
  it("calls the judge with no userId, no credentials, and the server-default model", async () => {
    const app = await buildApp();
    await inject(app, {
      ...DEMO_PAYLOAD,
      // A visitor-picked provider/model must NOT steer the server-paid call.
      provider: "openrouter",
      model: "openai/gpt-5-pro",
    });
    expect(judgeEmail).toHaveBeenCalledTimes(1);
    const call = judgeEmail.mock.calls[0];
    expect(call[1]).toBeUndefined(); // userId — per-user ledger bypassed
    expect(call[3]).toBeUndefined(); // credentials — server env keys pay
    expect(call[4]).toBeUndefined(); // modelOverride — pinned to JUDGE_MODEL default
    await app.close();
  });

  it("surfaces keyword-fallback as a 502 demo failure with a BYOK hint", async () => {
    judgeEmail.mockResolvedValue({ ...LLM_VERDICT, tier: "QUEUE", source: "keyword-fallback" });
    const app = await buildApp();
    const res = await inject(app, DEMO_PAYLOAD);
    expect(res.statusCode).toBe(502);
    expect(res.json().byokAvailable).toBe(true);
    await app.close();
  });

  it("surfaces a thrown judge error as a 502 demo failure with a BYOK hint", async () => {
    judgeEmail.mockRejectedValue(new Error("provider exploded"));
    const app = await buildApp();
    const res = await inject(app, DEMO_PAYLOAD);
    expect(res.statusCode).toBe(502);
    expect(res.json().byokAvailable).toBe(true);
    await app.close();
  });
});

describe("no-key demo — defense 1: per-IP rate limit", () => {
  it("allows 3 demo calls per minute from one IP, then 429s the 4th", async () => {
    const app = await buildApp();
    for (let i = 0; i < 3; i++) {
      const ok = await inject(app, DEMO_PAYLOAD);
      expect(ok.statusCode).toBe(200);
    }
    const blocked = await inject(app, DEMO_PAYLOAD);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe("demo_rate_limited");
    expect(blocked.json().byokAvailable).toBe(true);
    expect(judgeEmail).toHaveBeenCalledTimes(3);
    await app.close();
  });

  it("caps one IP at 10 demo calls per UTC day even across minutes", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-23T01:00:00Z"), toFake: ["Date"] });
    const app = await buildApp();
    let served = 0;
    for (let minute = 0; minute < 4; minute++) {
      for (let i = 0; i < 3; i++) {
        const res = await inject(app, DEMO_PAYLOAD);
        if (res.statusCode === 200) served++;
      }
      vi.setSystemTime(new Date(Date.now() + 60_000));
    }
    expect(served).toBe(10);
    const blocked = await inject(app, DEMO_PAYLOAD);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe("demo_rate_limited");

    // Next UTC day: the day counter resets and the IP is served again.
    vi.setSystemTime(new Date("2026-07-24T01:00:00Z"));
    const nextDay = await inject(app, DEMO_PAYLOAD);
    expect(nextDay.statusCode).toBe(200);
    await app.close();
  });
});

describe("no-key demo — defense 2: global daily budget", () => {
  it("accumulates ~0.19¢ per call and 429s once the next call would exceed the budget", async () => {
    // Budget 0.5¢: call 1 → 0.19¢, call 2 → 0.38¢, call 3 would reach 0.57¢.
    configState.demoBudgetCents = 0.5;
    const app = await buildApp();
    expect((await inject(app, DEMO_PAYLOAD)).statusCode).toBe(200);
    expect((await inject(app, DEMO_PAYLOAD)).statusCode).toBe(200);
    const blocked = await inject(app, DEMO_PAYLOAD);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: "demo_budget_exhausted", byokAvailable: true });
    expect(judgeEmail).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("resets the budget on UTC day rollover", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-23T12:00:00Z"), toFake: ["Date"] });
    configState.demoBudgetCents = 0.19;
    const app = await buildApp();
    expect((await inject(app, DEMO_PAYLOAD)).statusCode).toBe(200);
    expect((await inject(app, DEMO_PAYLOAD)).statusCode).toBe(429);
    vi.setSystemTime(new Date("2026-07-24T12:00:00Z"));
    expect((await inject(app, DEMO_PAYLOAD)).statusCode).toBe(200);
    await app.close();
  });
});

describe("no-key demo — BYOK path is untouched", () => {
  const BYOK_PAYLOAD = {
    ...DEMO_PAYLOAD,
    provider: "openrouter",
    apiKey: "sk-or-v1-visitor-key-1234567890",
    model: "qwen/qwen3-next-80b-a3b-instruct:free",
  };

  it("still threads visitor credentials (playgroundOnly) when a key is supplied, flag ON", async () => {
    const app = await buildApp();
    const res = await inject(app, BYOK_PAYLOAD);
    expect(res.statusCode).toBe(200);
    const credentials = judgeEmail.mock.calls[0][3];
    expect(credentials.openRouterApiKey).toBe(BYOK_PAYLOAD.apiKey);
    expect(credentials.playgroundOnly).toBe(true);
    expect(judgeEmail.mock.calls[0][4]).toBe(BYOK_PAYLOAD.model);
    await app.close();
  });

  it("does not spend the demo IP or budget counters on BYOK calls", async () => {
    configState.demoBudgetCents = 0.19; // room for exactly one demo call
    const app = await buildApp();
    // Several BYOK calls burn neither the 3/min IP slots nor the budget…
    for (let i = 0; i < 3; i++) {
      expect((await inject(app, BYOK_PAYLOAD)).statusCode).toBe(200);
    }
    // …so a demo call still succeeds afterwards.
    expect((await inject(app, DEMO_PAYLOAD)).statusCode).toBe(200);
    await app.close();
  });

  it("still works with the flag OFF (BYOK never depends on the demo flag)", async () => {
    configState.demoEnabled = false;
    const app = await buildApp();
    const res = await inject(app, BYOK_PAYLOAD);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(LLM_VERDICT);
    await app.close();
  });
});
