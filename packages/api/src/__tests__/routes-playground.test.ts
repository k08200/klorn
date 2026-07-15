/**
 * POST /api/playground/classify — login-free, bring-your-own-key demo of the
 * 4-tier firewall. Security-critical invariants this suite locks down:
 *   1. The visitor's API key is threaded to the classifier as credentials and
 *      NEVER written to any log line (public endpoint on a public repo).
 *   2. Strict schema: unknown body fields are rejected, no auth is required.
 *   3. An LLM/provider failure surfaces as a clean 502, not a silent 500.
 * POST /api/playground/feedback records the tier-disagreement signal without
 * persisting email content (length only).
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const judgeEmail = vi.hoisted(() => vi.fn());

vi.mock("../judge/poc-judge.js", () => ({ judgeEmail }));

import { playgroundRoutes } from "../routes/playground.js";

const SECRET_KEY = "sk-or-v1-supersecret-do-not-leak-1234567890";

async function buildApp() {
  const app = Fastify();
  await app.register(playgroundRoutes, { prefix: "/api/playground" });
  return app;
}

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  judgeEmail.mockReset();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

function allLoggedText(): string {
  return [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
    .flat()
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join("\n");
}

describe("POST /api/playground/classify", () => {
  it("classifies an email and returns tier, reason, features, source", async () => {
    judgeEmail.mockResolvedValue({
      tier: "PUSH",
      reason: "Investor asking for a same-day reply",
      features: { confidence: 0.9, senderTrust: 0.8, reversibility: 0.2, urgency: 0.9 },
      source: "llm",
    });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/playground/classify",
      payload: {
        from: "VC <partner@fund.com>",
        subject: "Can we talk today?",
        snippet: "Need a decision by EOD.",
        provider: "openrouter",
        apiKey: SECRET_KEY,
        model: "meta-llama/llama-3.3-70b-instruct:free",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      tier: "PUSH",
      reason: "Investor asking for a same-day reply",
      features: { confidence: 0.9, senderTrust: 0.8, reversibility: 0.2, urgency: 0.9 },
      source: "llm",
    });
    await app.close();
  });

  it("threads the visitor's key into the classifier as openrouter credentials", async () => {
    judgeEmail.mockResolvedValue({
      tier: "QUEUE",
      reason: "x",
      features: { confidence: 0.5, senderTrust: 0.5, reversibility: 0.5, urgency: 0.2 },
      source: "llm",
    });
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/playground/classify",
      payload: {
        from: "a@b.com",
        subject: "hi",
        apiKey: SECRET_KEY,
        provider: "openrouter",
        model: "qwen/qwen3-next-80b-a3b-instruct:free",
      },
    });
    const credentials = judgeEmail.mock.calls[0][3];
    expect(credentials.openRouterApiKey).toBe(SECRET_KEY);
    expect(credentials.geminiApiKey).toBeFalsy();
    // No userId — playground calls must bypass the per-user cost ledger.
    expect(judgeEmail.mock.calls[0][1]).toBeUndefined();
    // The visitor's model choice is forwarded so a :free key isn't forced
    // onto the paid default JUDGE_MODEL.
    expect(judgeEmail.mock.calls[0][4]).toBe("qwen/qwen3-next-80b-a3b-instruct:free");
    await app.close();
  });

  it("routes an openai key into the openai credential slot", async () => {
    judgeEmail.mockResolvedValue({
      tier: "PUSH",
      reason: "x",
      features: { confidence: 0.9, senderTrust: 0.8, reversibility: 0.2, urgency: 0.9 },
      source: "llm",
    });
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/playground/classify",
      payload: { from: "a@b.com", subject: "hi", apiKey: SECRET_KEY, provider: "openai" },
    });
    const credentials = judgeEmail.mock.calls[0][3];
    expect(credentials.openAiApiKey).toBe(SECRET_KEY);
    expect(credentials.openRouterApiKey).toBeFalsy();
    expect(credentials.geminiApiKey).toBeFalsy();
    await app.close();
  });

  it("routes a gemini key into the gemini credential slot", async () => {
    judgeEmail.mockResolvedValue({
      tier: "SILENT",
      reason: "x",
      features: { confidence: 0.5, senderTrust: 0.1, reversibility: 1, urgency: 0 },
      source: "llm",
    });
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/playground/classify",
      payload: { from: "a@b.com", subject: "hi", apiKey: SECRET_KEY, provider: "gemini" },
    });
    const credentials = judgeEmail.mock.calls[0][3];
    expect(credentials.geminiApiKey).toBe(SECRET_KEY);
    expect(credentials.openRouterApiKey).toBeFalsy();
    await app.close();
  });

  it("NEVER writes the API key to any log line, even on failure", async () => {
    judgeEmail.mockRejectedValue(new Error("401 Unauthorized from provider"));
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/playground/classify",
      payload: { from: "a@b.com", subject: "hi", apiKey: SECRET_KEY, provider: "openrouter" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/key|model|retry/i);
    // The key must not appear in logs, nor in the error response body.
    expect(allLoggedText()).not.toContain(SECRET_KEY);
    expect(JSON.stringify(res.json())).not.toContain(SECRET_KEY);
    await app.close();
  });

  it("returns 502 when the LLM didn't run (keyword-fallback is not a real verdict)", async () => {
    judgeEmail.mockResolvedValue({
      tier: "QUEUE",
      reason: "Visible in queue for manual review",
      features: { confidence: 0.55, senderTrust: 0.45, reversibility: 0.3, urgency: 0.85 },
      source: "keyword-fallback",
    });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/playground/classify",
      payload: { from: "a@b.com", subject: "hi", apiKey: SECRET_KEY, provider: "openrouter" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/model didn't run|invalid|key/i);
    await app.close();
  });

  it("returns 200 for a deterministic fast-path verdict (not treated as failure)", async () => {
    judgeEmail.mockResolvedValue({
      tier: "SILENT",
      reason: "Promotional / marketing — no human attention needed",
      features: { confidence: 0.95, senderTrust: 0.05, reversibility: 1, urgency: 0 },
      source: "fast-path",
    });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/playground/classify",
      payload: { from: "promo@x.com", subject: "SALE", apiKey: SECRET_KEY, provider: "openrouter" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tier).toBe("SILENT");
    expect(res.json().source).toBe("fast-path");
    await app.close();
  });

  it("uses a constant quotaScope that never embeds the key (cooldowns are bypassed)", async () => {
    judgeEmail.mockResolvedValue({
      tier: "QUEUE",
      reason: "x",
      features: { confidence: 0.5, senderTrust: 0.5, reversibility: 0.5, urgency: 0.2 },
      source: "llm",
    });
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/playground/classify",
      payload: { from: "a@b.com", subject: "hi", apiKey: SECRET_KEY, provider: "openrouter" },
    });
    const credentials = judgeEmail.mock.calls[0][3];
    expect(credentials.quotaScope).toBe("playground");
    expect(credentials.quotaScope).not.toContain(SECRET_KEY);
    await app.close();
  });

  it("strips unknown body fields (additionalProperties: false) before the handler", async () => {
    judgeEmail.mockResolvedValue({
      tier: "QUEUE",
      reason: "x",
      features: { confidence: 0.5, senderTrust: 0.5, reversibility: 0.5, urgency: 0.2 },
      source: "llm",
    });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/playground/classify",
      payload: { from: "a@b.com", subject: "hi", apiKey: SECRET_KEY, evil: "haxor" },
    });
    // Fastify's ajv strips the unknown field; the request still validates and
    // the rogue value never reaches the classifier or the credentials.
    expect(res.statusCode).toBe(200);
    const email = judgeEmail.mock.calls[0][0];
    expect(JSON.stringify(judgeEmail.mock.calls[0])).not.toContain("haxor");
    expect(email).not.toHaveProperty("evil");
    await app.close();
  });

  it("requires from, subject, and apiKey", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/playground/classify",
      payload: { subject: "hi", apiKey: SECRET_KEY },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("POST /api/playground/feedback", () => {
  it("records a tier disagreement without persisting email content", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/playground/feedback",
      payload: {
        subject: "Sensitive subject line that must not be logged verbatim",
        predictedTier: "SILENT",
        correctTier: "PUSH",
        model: "meta-llama/llama-3.3-70b-instruct:free",
        source: "llm",
      },
    });
    expect(res.statusCode).toBe(200);
    const logged = allLoggedText();
    expect(logged).toContain("PLAYGROUND_FEEDBACK");
    expect(logged).toContain("predicted=SILENT");
    expect(logged).toContain("correct=PUSH");
    // The raw subject text must not be echoed into logs.
    expect(logged).not.toContain("Sensitive subject line");
    await app.close();
  });

  it("strips control chars from model/source so a crafted value can't forge a log line", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/playground/feedback",
      payload: {
        predictedTier: "QUEUE",
        correctTier: "PUSH",
        model: "evil\n[PLAYGROUND_FEEDBACK] predicted=FORGED correct=FORGED",
        source: "x\r\ninjected",
      },
    });
    expect(res.statusCode).toBe(200);
    const logged = allLoggedText();
    // The injected CR/LF must be neutralized: exactly one feedback line, and the
    // logged value carries no raw control characters that could split a record.
    const lines = logged.split("\n").filter((l) => l.includes("[PLAYGROUND_FEEDBACK]"));
    expect(lines).toHaveLength(1);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control chars are gone
    expect(lines[0]).not.toMatch(/[\x00-\x1F\x7F]/);
    await app.close();
  });

  it("rejects an invalid tier value", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/playground/feedback",
      payload: { predictedTier: "MAYBE", correctTier: "PUSH" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
