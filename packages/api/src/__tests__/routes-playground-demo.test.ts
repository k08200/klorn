/**
 * POST /api/playground/classify — key-free demo mode (server-paid).
 *
 * The BYOK playground is a wall for ordinary visitors (no provider key = no
 * demo). Behind the OFF-by-default PLAYGROUND_NO_KEY_DEMO_ENABLED flag, a
 * request WITHOUT an apiKey runs on the server's own keys with triple defense:
 *   1. Per-client rate limit: 3/minute AND 10/day (in-memory), keyed on the
 *      demo bucket — an IPv6 client by its /64, so rotating addresses inside
 *      one allocation does not buy fresh slots.
 *   2. Global daily demo budget in fractional cents (DEMO_DAILY_BUDGET_CENTS,
 *      default 50 = $0.50/day), pre-charged per call at 0.04¢ (a Claude Haiku
 *      5.5 classification, rounded up — routes/playground.ts). Exhausted → 429 demo_budget_exhausted + a
 *      byokAvailable hint so the landing falls back to the key UI.
 *   3. Model pinned to the server default (JUDGE_MODEL), passed EXPLICITLY so
 *      poc-judge sees a caller-pinned model and the escalation dial
 *      (JUDGE_ESCALATION_MODEL) cannot add a second, unbudgeted call. A
 *      visitor-supplied model/provider is ignored on the no-key path.
 * Flag OFF (default) → key-free requests get 401 key_required and the LLM is
 * never called; the BYOK path is byte-for-byte unchanged either way.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const judgeEmail = vi.hoisted(() => vi.fn());
/*
 * The judge model the stubbed server runs.
 *
 * Load-bearing that this differs from the web page's own `KLORN_MODEL_ID`
 * ("claude-haiku-5-5", packages/web/src/app/playground/models.ts): the route
 * used to be free to report either, and the assertion that it reports the
 * model it actually pinned only bites while the two spellings differ. Match
 * them and a route that hardcodes the page's constant passes. Do not "tidy".
 */
const SERVER_JUDGE_MODEL = vi.hoisted(() => "anthropic/claude-haiku-5-5");
const configState = vi.hoisted(() => ({ demoEnabled: false, demoBudgetCents: 50 }));

vi.mock("../judge/poc-judge.js", () => ({ judgeEmail }));
// Stub the constant alone: importing the real module would drag the provider
// registry (and Prisma's .env autoload) into an offline unit test.
vi.mock("../llm/openai.js", () => ({ JUDGE_MODEL: SERVER_JUDGE_MODEL }));
vi.mock("../config.js", () => ({
  get PLAYGROUND_NO_KEY_DEMO_ENABLED() {
    return configState.demoEnabled;
  },
  get DEMO_DAILY_BUDGET_CENTS() {
    return configState.demoBudgetCents;
  },
}));

import { JUDGE_MODEL } from "../llm/openai.js";
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

function inject(
  app: Awaited<ReturnType<typeof buildApp>>,
  payload: object,
  headers?: Record<string, string>,
) {
  return app.inject({ method: "POST", url: "/api/playground/classify", payload, headers });
}

/** The address a demo request appears to come from, as prod reads it. */
function fromAddress(ip: string): Record<string, string> {
  return { "cf-connecting-ip": ip };
}

let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let previousIpSource: string | undefined;

beforeEach(() => {
  judgeEmail.mockReset();
  judgeEmail.mockResolvedValue(LLM_VERDICT);
  configState.demoEnabled = true;
  configState.demoBudgetCents = 50;
  _resetPlaygroundDemoState();
  // Mirror prod (render.yaml CLIENT_IP_SOURCE), so a test can say which client
  // a demo request comes from the same way Cloudflare's edge does.
  previousIpSource = process.env.CLIENT_IP_SOURCE;
  process.env.CLIENT_IP_SOURCE = "cf-connecting-ip";
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  if (previousIpSource === undefined) delete process.env.CLIENT_IP_SOURCE;
  else process.env.CLIENT_IP_SOURCE = previousIpSource;
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
    expect(res.json()).toEqual({ ...LLM_VERDICT, model: JUDGE_MODEL });
    await app.close();
  });

  /*
   * The result card names a model. Before this field the page printed its own
   * build-time constant, so the claim could only be checked by reading the
   * server's boot log by hand. Asserting the reported model IS the one handed
   * to the judge is what keeps the card honest across a dashboard override or
   * a gate substitution — neither of which changes this repo.
   */
  it("reports the model it actually ran, not a name the page guessed", async () => {
    const app = await buildApp();
    const res = await inject(app, { ...DEMO_PAYLOAD, provider: "openai", model: "gpt-5-pro" });
    expect(res.statusCode).toBe(200);
    const reported = res.json().model;
    expect(reported).toBe(JUDGE_MODEL);
    expect(reported).not.toBe("gpt-5-pro"); // a visitor cannot steer the claim
    await app.close();
  });
});

describe("no-key demo — server-paid call shape", () => {
  it("calls the judge with no userId, no credentials, and the server-default model", async () => {
    const app = await buildApp();
    await inject(app, {
      ...DEMO_PAYLOAD,
      // A visitor-picked provider/model must NOT steer the server-paid call.
      provider: "openai",
      model: "gpt-5-pro",
    });
    expect(judgeEmail).toHaveBeenCalledTimes(1);
    const call = judgeEmail.mock.calls[0];
    expect(call[1]).toBeUndefined(); // userId — per-user ledger bypassed
    expect(call[3]).toBeUndefined(); // credentials — server env keys pay
    expect(call[4]).toBe(SERVER_JUDGE_MODEL); // never the visitor's "gpt-5-pro"
    await app.close();
  });

  it("pins the model explicitly so the escalation dial cannot add a second call", async () => {
    // poc-judge reads `callerPinnedModel: modelOverride !== undefined`, and
    // judge-dial suppresses escalation only for a pinned caller. Passing
    // undefined here would leave a low-confidence demo email free to escalate
    // to JUDGE_ESCALATION_MODEL — a second provider call that Defense 2's
    // fixed one-call pre-charge never accounted for.
    const app = await buildApp();
    await inject(app, DEMO_PAYLOAD);
    expect(judgeEmail.mock.calls[0][4]).not.toBeUndefined();
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

  it("a rotated X-Forwarded-For does not buy fresh slots (trustProxy as in index.ts)", async () => {
    const app = Fastify({ trustProxy: true });
    await app.register(playgroundRoutes, { prefix: "/api/playground" });
    const fromForged = (n: number) =>
      app.inject({
        method: "POST",
        url: "/api/playground/classify",
        payload: DEMO_PAYLOAD,
        headers: { "x-forwarded-for": `198.51.100.${n}` },
      });
    for (let i = 0; i < 3; i++) expect((await fromForged(i + 1)).statusCode).toBe(200);
    const blocked = await fromForged(99);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe("demo_rate_limited");
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

describe("no-key demo — defense 1: one IPv6 allocation is one client", () => {
  it("does not hand out fresh slots for other addresses in the same /64", async () => {
    // A /64 is the normal IPv6 allocation unit, so an attacker holding one has
    // ~1.8e19 addresses. Keyed per address, 125 of them would drain the whole
    // daily budget and shut the free door for everyone.
    const app = await buildApp();
    for (let i = 0; i < 3; i++) {
      const ok = await inject(app, DEMO_PAYLOAD, fromAddress(`2001:db8:1:2::${i + 1}`));
      expect(ok.statusCode).toBe(200);
    }
    const rotated = await inject(app, DEMO_PAYLOAD, fromAddress("2001:db8:1:2::ffff"));
    expect(rotated.statusCode).toBe(429);
    expect(rotated.json().error).toBe("demo_rate_limited");
    expect(judgeEmail).toHaveBeenCalledTimes(3);
    await app.close();
  });

  it("caps a /64 at 10 demo calls per UTC day across minutes and addresses", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-11T01:00:00Z"), toFake: ["Date"] });
    const app = await buildApp();
    let served = 0;
    for (let minute = 0; minute < 5; minute++) {
      for (let i = 0; i < 3; i++) {
        const res = await inject(
          app,
          DEMO_PAYLOAD,
          fromAddress(`2001:db8:1:2::${minute}:${i + 1}`),
        );
        if (res.statusCode === 200) served++;
      }
      vi.setSystemTime(new Date(Date.now() + 60_000));
    }
    expect(served).toBe(10);
    await app.close();
  });

  it("still gives a genuinely different /64 its own slots", async () => {
    const app = await buildApp();
    for (let i = 0; i < 3; i++) {
      expect((await inject(app, DEMO_PAYLOAD, fromAddress("2001:db8:1:2::1"))).statusCode).toBe(
        200,
      );
    }
    expect((await inject(app, DEMO_PAYLOAD, fromAddress("2001:db8:1:2::2"))).statusCode).toBe(429);
    // A neighbour in another allocation is unaffected by that exhaustion.
    expect((await inject(app, DEMO_PAYLOAD, fromAddress("2001:db8:1:3::1"))).statusCode).toBe(200);
    await app.close();
  });

  it("keeps IPv4 clients on their own address", async () => {
    const app = await buildApp();
    for (let i = 0; i < 3; i++) {
      expect((await inject(app, DEMO_PAYLOAD, fromAddress("203.0.113.7"))).statusCode).toBe(200);
    }
    expect((await inject(app, DEMO_PAYLOAD, fromAddress("203.0.113.7"))).statusCode).toBe(429);
    expect((await inject(app, DEMO_PAYLOAD, fromAddress("203.0.113.8"))).statusCode).toBe(200);
    await app.close();
  });
});

describe("no-key demo — defense 2: global daily budget", () => {
  it("accumulates 0.04¢ per call and 429s once the next call would exceed the budget", async () => {
    // Budget 0.1¢: call 1 → 0.04¢, call 2 → 0.08¢, call 3 would reach 0.12¢.
    configState.demoBudgetCents = 0.1;
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
    configState.demoBudgetCents = 0.04; // room for exactly one demo call
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
    provider: "anthropic",
    apiKey: "sk-ant-api03-visitor-key-1234567890",
    model: "claude-sonnet-5-5",
  };

  it("still threads visitor credentials (playgroundOnly) when a key is supplied, flag ON", async () => {
    const app = await buildApp();
    const res = await inject(app, BYOK_PAYLOAD);
    expect(res.statusCode).toBe(200);
    const credentials = judgeEmail.mock.calls[0][3];
    expect(credentials.anthropicApiKey).toBe(BYOK_PAYLOAD.apiKey);
    expect(credentials.playgroundOnly).toBe(true);
    expect(judgeEmail.mock.calls[0][4]).toBe(BYOK_PAYLOAD.model);
    await app.close();
  });

  it("does not spend the demo IP or budget counters on BYOK calls", async () => {
    configState.demoBudgetCents = 0.04; // room for exactly one demo call
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
