/**
 * Issue #1686 — the playground's key-free demo wire rules.
 *
 * `PLAYGROUND_NO_KEY_DEMO_ENABLED` has been on in production while no client
 * could reach the path: `apiKey` was a required `string` on the hook's input
 * and was always sent, so the server never saw a key-free request from the
 * product. These are the pure rules behind the fix — what the request body
 * carries per mode, and which of the server's refusals mean "your own key is
 * the only way through".
 *
 * The refusal fixtures are not hand-written guesses: the last describe block
 * drives the REAL route and feeds its real replies into the mapper, so renaming
 * a code server-side fails here rather than silently degrading the page.
 *
 * The matching UI wiring is pinned by packages/web/e2e/playground-key-free.spec.ts.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_KEY_MIN_LENGTH,
  type ClassifyRequest,
  classifyErrorFor,
  classifyRequestBody,
} from "../../../web/src/app/playground/classify-wire";
import en from "../../../web/src/lib/locales/en";

const judgeEmail = vi.hoisted(() => vi.fn());
const configState = vi.hoisted(() => ({ demoEnabled: false, demoBudgetCents: 50 }));

vi.mock("../judge/poc-judge.js", () => ({ judgeEmail }));
// The route pins the demo to the server's judge model, so it imports this
// module; stub the constant alone rather than loading the provider registry
// (and Prisma's .env autoload) into an offline unit test.
//
// This literal is the one copy of the judge model id that can drift silently:
// web-playground-models.test.ts asserts KLORN_MODEL_ID
// (packages/web/src/app/playground/models.ts) equals RECOMMENDED_JUDGE_MODEL,
// so those two fail loudly, but nothing checks this stub against them. Only the
// request shape below depends on it, never the value, so a drifted stub weakens
// the test rather than breaking it — keep it in step with models.ts by hand.
vi.mock("../llm/openai.js", () => ({ JUDGE_MODEL: "claude-haiku-5-5" }));
vi.mock("../config.js", () => ({
  get PLAYGROUND_NO_KEY_DEMO_ENABLED() {
    return configState.demoEnabled;
  },
  get DEMO_DAILY_BUDGET_CENTS() {
    return configState.demoBudgetCents;
  },
}));

import {
  _resetPlaygroundDemoState,
  classifyBodySchema,
  playgroundRoutes,
} from "../routes/playground.js";

const DRAFT = {
  from: " sarah@example.com ",
  subject: " Contract review — needs your sign-off today ",
  body: " The contract needs your signature before 5pm today. ",
};

describe("classifyRequestBody — key-free demo", () => {
  it("omits apiKey entirely rather than sending an empty one", () => {
    const body = classifyRequestBody({ mode: "demo", ...DRAFT });
    // The server routes on `!body.apiKey`, and the schema sets minLength 8, so
    // an empty string would be a 400 instead of a demo run.
    expect("apiKey" in body).toBe(false);
  });

  it("omits provider and model, which the demo path ignores anyway", () => {
    const body = classifyRequestBody({ mode: "demo", ...DRAFT });
    // Defense 3 in routes/playground.ts pins the demo to the server's
    // JUDGE_MODEL. Sending a provider/model would claim a choice the visitor
    // does not have on this path.
    expect("provider" in body).toBe(false);
    expect("model" in body).toBe(false);
  });

  it("drops a key even when one reaches it at runtime", () => {
    // The union makes this unrepresentable in TypeScript; this is the runtime
    // floor under it, because a key leaking onto the free path would bill the
    // visitor for a sort Klorn paid for.
    const smuggled = {
      mode: "demo",
      ...DRAFT,
      apiKey: "sk-ant-shouldnotbesent",
      provider: "anthropic",
      model: "claude-haiku-5-5",
    } as unknown as ClassifyRequest;
    expect(classifyRequestBody(smuggled)).not.toHaveProperty("apiKey");
  });

  it("still trims and forwards the email itself", () => {
    const body = classifyRequestBody({ mode: "demo", ...DRAFT });
    expect(body.from).toBe("sarah@example.com");
    expect(body.subject).toBe("Contract review — needs your sign-off today");
    expect(body.snippet).toBe("The contract needs your signature before 5pm today.");
  });

  it("drops an empty body instead of sending a blank snippet", () => {
    const body = classifyRequestBody({ mode: "demo", ...DRAFT, body: "   " });
    expect(body.snippet).toBeUndefined();
  });
});

describe("classifyRequestBody — BYOK", () => {
  it("carries the visitor's key, provider and model", () => {
    const body = classifyRequestBody({
      mode: "byok",
      ...DRAFT,
      provider: "anthropic",
      apiKey: "  sk-ant-visitorkey  ",
      model: " claude-haiku-5-5 ",
    });
    expect(body.apiKey).toBe("sk-ant-visitorkey");
    expect(body.provider).toBe("anthropic");
    expect(body.model).toBe("claude-haiku-5-5");
  });

  it("omits an empty model so the provider's own default applies", () => {
    const body = classifyRequestBody({
      mode: "byok",
      ...DRAFT,
      provider: "openai",
      apiKey: "sk-visitorkey",
      model: "  ",
    });
    expect(body.model).toBeUndefined();
    expect(body.apiKey).toBe("sk-visitorkey");
  });
});

describe("API_KEY_MIN_LENGTH", () => {
  it("is the route schema's own minLength, so the client refuses what the server would", () => {
    // Drift here is how a visitor gets a bare 400 ("Bad Request") for a key the
    // client thought was fine.
    expect(API_KEY_MIN_LENGTH).toBe(classifyBodySchema.properties.apiKey.minLength);
  });
});

describe("classifyErrorFor — refusals that only a key gets past", () => {
  it("reveals the key fields when the day's demo budget is spent", () => {
    const err = classifyErrorFor(
      429,
      { error: "demo_budget_exhausted", byokAvailable: true },
      "demo",
    );
    expect(err.key).toBe("playground.error.demoBudget");
    expect(err.revealByok).toBe(true);
  });

  it("reveals the key fields when the demo is dark", () => {
    const err = classifyErrorFor(401, { error: "key_required" }, "demo");
    expect(err.key).toBe("playground.error.demoOff");
    expect(err.revealByok).toBe(true);
  });
});

describe("classifyErrorFor — refusals a retry can still answer", () => {
  it("does NOT switch the form to BYOK on a per-IP demo limit", () => {
    // Its copy says to try again in a minute. Switching the form to BYOK would
    // answer that retry by demanding a key instead of re-running the free sort.
    const err = classifyErrorFor(429, { error: "demo_rate_limited", byokAvailable: true }, "demo");
    expect(err.key).toBe("playground.error.demoRateLimited");
    expect(err.revealByok).toBeUndefined();
  });

  it("does NOT switch the form to BYOK on a demo-side outage", () => {
    const err = classifyErrorFor(
      502,
      {
        error: "Demo classification failed — try again shortly, or use your own API key.",
        byokAvailable: true,
      },
      "demo",
    );
    expect(err.key).toBe("playground.error.demoFailed");
    expect(err.revealByok).toBeUndefined();
  });
});

describe("classifyErrorFor — a demo failure is never blamed on a key", () => {
  // In demo mode the visitor has given no key, so the BYOK copy ("usually the
  // key is wrong, the model isn't available, or the account has no credit")
  // would blame them for a server-side fault.
  it.each([
    ["a Fastify 500", 500, { error: "Internal server error" }],
    ["a gateway 502 with no JSON body", 502, null],
    ["a gateway 504", 504, { error: "Gateway Timeout" }],
    ["a 200 whose body was not a verdict", 200, null],
  ])("maps %s to the demo failure copy", (_label, status, body) => {
    const err = classifyErrorFor(status, body, "demo");
    expect(err.key).toBe("playground.error.demoFailed");
    expect(err.detail).toBeUndefined();
  });

  it("still blames the key in BYOK, where there is one to blame", () => {
    const err = classifyErrorFor(502, { error: "…", detail: "401 invalid x-api-key" }, "byok");
    expect(err.key).toBe("playground.error.failed");
    expect(err.detail).toBe("401 invalid x-api-key");
    expect(err.revealByok).toBeUndefined();
  });
});

describe("classifyErrorFor — the shapes that are not ours", () => {
  it("reads the route limiter's real body as too many requests, in both modes", () => {
    // @fastify/rate-limit throws an Error and error-handler.ts re-sends it as
    // `{ error: "Rate limit exceeded, retry in …" }` — none of our codes.
    const body = { error: "Rate limit exceeded, retry in 1 minute" };
    for (const mode of ["demo", "byok"] as const) {
      const err = classifyErrorFor(429, body, mode);
      expect(err.key).toBe("playground.error.rateLimited");
      // A wait is not answered by a key, so the form must not switch.
      expect(err.revealByok).toBeUndefined();
    }
  });

  it("maps a schema rejection to the invalid-request copy", () => {
    expect(classifyErrorFor(400, { error: "model_provider_mismatch" }, "byok").key).toBe(
      "playground.error.invalid",
    );
  });

  it("does not read an inherited property as a refusal code", () => {
    // `error` is a server-supplied string: a plain-object lookup answers
    // "constructor" with a function, which would render as the message.
    for (const code of ["constructor", "__proto__", "toString"]) {
      const err = classifyErrorFor(502, { error: code }, "byok");
      expect(err.key).toBe("playground.error.failed");
    }
  });

  it("caps the upstream detail and ignores a non-string one", () => {
    expect(classifyErrorFor(502, { detail: "x".repeat(500) }, "byok").detail).toHaveLength(300);
    expect(classifyErrorFor(502, { detail: { nested: true } }, "byok").detail).toBeUndefined();
  });

  it("survives a body that is not an object at all", () => {
    expect(classifyErrorFor(502, null, "byok").key).toBe("playground.error.failed");
    expect(classifyErrorFor(429, "nope", "demo").key).toBe("playground.error.rateLimited");
  });
});

describe("every message the playground can show exists in the locale table", () => {
  // A missing key renders as the raw key string. Parity across locales is CI's
  // job (check-i18n-parity.mjs); this checks the keys this code can emit.
  const emitted = [
    "playground.error.demoBudget",
    "playground.error.demoOff",
    "playground.error.demoRateLimited",
    "playground.error.demoFailed",
    "playground.error.demoTimeout",
    "playground.error.rateLimited",
    "playground.error.invalid",
    "playground.error.failed",
    "playground.error.timeout",
    "playground.error.network",
    "playground.error.noKey",
    "playground.error.noEmail",
    "playground.error.keyTooShort",
    "playground.demo.note",
    "playground.byok.toggle",
  ];

  it.each(emitted)("%s", (key) => {
    expect(typeof en[key]).toBe("string");
    expect(en[key].length).toBeGreaterThan(0);
  });

  it("never offers an upgrade where the limit is a daily budget", () => {
    // The demo budget is capacity, not a price. Copy that reads as a paywall
    // would misrepresent a free product surface.
    expect(en["playground.error.demoBudget"]).not.toMatch(/upgrade|subscribe|plan|\$/i);
  });
});

/**
 * The fixtures above are hand-written. This block is the anti-drift floor: it
 * runs the real route and maps whatever it actually answers.
 */
const PAYLOAD = { from: "VC <partner@fund.com>", subject: "Can we talk today?" };

async function refusalFromRealRoute(setup: () => void) {
  const app = Fastify();
  await app.register(playgroundRoutes, { prefix: "/api/playground" });
  setup();
  let last = await app.inject({
    method: "POST",
    url: "/api/playground/classify",
    payload: PAYLOAD,
  });
  // Walk past the calls that succeed until the route refuses.
  for (let i = 0; i < 12 && last.statusCode < 400; i++) {
    last = await app.inject({ method: "POST", url: "/api/playground/classify", payload: PAYLOAD });
  }
  await app.close();
  return { status: last.statusCode, body: last.json() };
}

describe("the mapper against the route's real replies", () => {
  beforeEach(() => {
    _resetPlaygroundDemoState();
    judgeEmail.mockReset();
    configState.demoEnabled = false;
    configState.demoBudgetCents = 50;
  });

  it("maps the real 401 the dark flag produces", async () => {
    const { status, body } = await refusalFromRealRoute(() => {
      configState.demoEnabled = false;
    });
    expect(status).toBe(401);
    const err = classifyErrorFor(status, body, "demo");
    expect(err.key).toBe("playground.error.demoOff");
    expect(err.revealByok).toBe(true);
  });

  it("maps the real 429 the per-IP cap produces", async () => {
    judgeEmail.mockResolvedValue({
      tier: "PUSH",
      reason: "r",
      features: { confidence: 0.9, senderTrust: 0.8, reversibility: 0.2, urgency: 0.9 },
      source: "llm",
    });
    const { status, body } = await refusalFromRealRoute(() => {
      configState.demoEnabled = true;
    });
    expect(status).toBe(429);
    expect(classifyErrorFor(status, body, "demo").key).toBe("playground.error.demoRateLimited");
  });

  it("maps the real 429 an exhausted budget produces", async () => {
    judgeEmail.mockResolvedValue({
      tier: "PUSH",
      reason: "r",
      features: { confidence: 0.9, senderTrust: 0.8, reversibility: 0.2, urgency: 0.9 },
      source: "llm",
    });
    const { status, body } = await refusalFromRealRoute(() => {
      configState.demoEnabled = true;
      configState.demoBudgetCents = 0;
    });
    expect(status).toBe(429);
    const err = classifyErrorFor(status, body, "demo");
    expect(err.key).toBe("playground.error.demoBudget");
    expect(err.revealByok).toBe(true);
  });

  it("maps the real 502 a judge outage produces", async () => {
    judgeEmail.mockRejectedValue(new Error("upstream exploded"));
    const { status, body } = await refusalFromRealRoute(() => {
      configState.demoEnabled = true;
    });
    expect(status).toBe(502);
    const err = classifyErrorFor(status, body, "demo");
    expect(err.key).toBe("playground.error.demoFailed");
    expect(err.revealByok).toBeUndefined();
  });

  it("sends a body the route's own schema accepts", async () => {
    judgeEmail.mockResolvedValue({
      tier: "QUEUE",
      reason: "r",
      features: { confidence: 0.6, senderTrust: 0.9, reversibility: 0.4, urgency: 0.9 },
      source: "llm",
    });
    const app = Fastify();
    await app.register(playgroundRoutes, { prefix: "/api/playground" });
    configState.demoEnabled = true;
    // `additionalProperties: false` means an extra or mistyped field is a 400.
    const res = await app.inject({
      method: "POST",
      url: "/api/playground/classify",
      payload: classifyRequestBody({ mode: "demo", ...DRAFT }),
    });
    await app.close();
    expect(res.statusCode).toBe(200);
  });
});
