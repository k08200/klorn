/**
 * Playground redesign (2026-10-30): native Anthropic BYOK, model-id
 * validation, and the `decidedBy` field the result card reads so the "decided
 * the lane" marker comes from the server's real tier rule instead of a client
 * re-derivation that could drift.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const judgeEmail = vi.hoisted(() => vi.fn());

vi.mock("../judge/poc-judge.js", () => ({ judgeEmail }));

import { playgroundRoutes } from "../routes/playground.js";

const ANTHROPIC_KEY = "sk-ant-api03-visitorsecret-do-not-leak-ABCDEFGH1234";

async function buildApp() {
  const app = Fastify();
  await app.register(playgroundRoutes, { prefix: "/api/playground" });
  return app;
}

const okJudgement = {
  tier: "PUSH",
  reason: "Investor asks for a call today",
  features: { confidence: 0.9, senderTrust: 0.8, reversibility: 0.3, urgency: 0.9 },
  source: "llm",
  decidedBy: "urgent",
};

let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  judgeEmail.mockReset();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

describe("POST /api/playground/classify — anthropic + decidedBy", () => {
  it("routes an anthropic key into the anthropic slot only, fail-closed", async () => {
    judgeEmail.mockResolvedValue(okJudgement);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/playground/classify",
      payload: {
        from: "a@b.com",
        subject: "hi",
        apiKey: ANTHROPIC_KEY,
        provider: "anthropic",
        model: "claude-haiku-5-5",
      },
    });
    expect(res.statusCode).toBe(200);
    const credentials = judgeEmail.mock.calls[0][3];
    expect(credentials.anthropicApiKey).toBe(ANTHROPIC_KEY);
    expect(credentials.openRouterApiKey).toBeFalsy();
    expect(credentials.geminiApiKey).toBeFalsy();
    expect(credentials.openAiApiKey).toBeFalsy();
    expect(credentials.playgroundOnly).toBe(true);
    expect(judgeEmail.mock.calls[0][4]).toBe("claude-haiku-5-5");
    await app.close();
  });

  it("returns decidedBy from the judgement", async () => {
    judgeEmail.mockResolvedValue({ ...okJudgement, tier: "MEETING", decidedBy: "scheduling" });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/playground/classify",
      payload: { from: "a@b.com", subject: "hi", apiKey: ANTHROPIC_KEY, provider: "anthropic" },
    });
    expect(res.json().decidedBy).toBe("scheduling");
    await app.close();
  });

  it("never logs or echoes an sk-ant key when the provider fails", async () => {
    judgeEmail.mockImplementation(async (_e, _u, _c, _cr, _m, onLlmError) => {
      onLlmError?.(`401 invalid x-api-key ${ANTHROPIC_KEY}`);
      return { ...okJudgement, source: "keyword-fallback" };
    });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/playground/classify",
      payload: { from: "a@b.com", subject: "hi", apiKey: ANTHROPIC_KEY, provider: "anthropic" },
    });
    expect(res.statusCode).toBe(502);
    expect(JSON.stringify(res.json())).not.toContain("visitorsecret");
    const logged = [...warnSpy.mock.calls, ...logSpy.mock.calls].flat().join("\n");
    expect(logged).not.toContain("visitorsecret");
    await app.close();
  });

  it.each([
    "google/gemini-2.5-flash",
    "anthropic/claude-haiku-5.5",
    "claude-opus-5-5",
    "gpt-6.1-terra",
    "meta-llama/llama-3.3-70b-instruct:free",
  ])("accepts a well-formed model id %s", async (model) => {
    judgeEmail.mockResolvedValue(okJudgement);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/playground/classify",
      payload: { from: "a@b.com", subject: "hi", apiKey: ANTHROPIC_KEY, model },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it.each([
    "google/gemini 2.5",
    "../../etc/passwd?x=1",
    "model\nINJECTED",
    "-leading-dash",
    "google/..",
    "a..b",
    `a${"b".repeat(120)}`,
  ])("rejects a malformed model id %j with 400", async (model) => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/playground/classify",
      payload: { from: "a@b.com", subject: "hi", apiKey: ANTHROPIC_KEY, model },
    });
    expect(res.statusCode).toBe(400);
    expect(judgeEmail).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects an unknown provider", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/playground/classify",
      payload: { from: "a@b.com", subject: "hi", apiKey: ANTHROPIC_KEY, provider: "mistral" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it.each([
    ["anthropic", "google/gemini-2.5-flash"],
    ["anthropic", "gpt-6.1-terra"],
    ["gemini", "claude-haiku-5-5"],
    ["gemini", "openai/gpt-6-luna"],
  ])("rejects a %s request for another vendor's model %s (no silent substitution)", async (provider, model) => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/playground/classify",
      payload: { from: "a@b.com", subject: "hi", apiKey: ANTHROPIC_KEY, provider, model },
    });
    expect(res.statusCode).toBe(400);
    expect(judgeEmail).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ["anthropic", "anthropic/claude-opus-5.5"],
    ["gemini", "google/gemini-3.8-flash"],
    ["gemini", "gemini-2.5-flash"],
  ])("accepts %s with its own family %s", async (provider, model) => {
    judgeEmail.mockResolvedValue(okJudgement);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/playground/classify",
      payload: { from: "a@b.com", subject: "hi", apiKey: ANTHROPIC_KEY, provider, model },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
