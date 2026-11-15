/**
 * Failover signals carry no provider message.
 *
 * signalKeyFailover and signalUserKeyUnusable (llm/openai.ts) fire when a key
 * hits its limit or a user's own key stops serving, which includes every BYOK
 * call from the mail judge, Slack and the KakaoTalk import. They used to hand
 * Sentry the raw provider error and put up to 200 characters of the provider's
 * message in Sentry extras and the console. A provider message can quote the
 * request, which on those paths is someone else's mail or chat text.
 *
 * Pinned here: a canary in the provider's message never reaches the Sentry
 * mock or any console line, while the operator still learns which provider,
 * which key kind, that a failover happened, and the error's class, status and
 * machine-readable type.
 */

import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CANARY = "CANARY-quoted-mail-9c41";

const captureError = vi.fn();

function fakeProvider(
  name: string,
  scope: string,
  call: (params: unknown, model: string) => Promise<unknown>,
  ownedByUser = false,
) {
  return {
    name,
    quotaKey: `${name}:${scope}`,
    client: null,
    defaultModel: `${name}-model`,
    supportsTools: true,
    supportsVision: true,
    resolveModel: () => `${name}-model`,
    call,
    ownedByUser,
  };
}

function mockChain(chain: unknown[]) {
  vi.doMock("../providers/index.js", () => ({
    getProvider: () => null,
    getProviderChain: () => chain,
  }));
  vi.doMock("../llm/model-fallback.js", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    isProviderUnavailable: () => false,
  }));
  vi.doMock("../sentry.js", () => ({ captureError }));
  vi.doMock("../db.js", () => ({
    prisma: {
      llmUsageLog: { create: async () => ({}) },
      globalCostLedger: { findUnique: async () => null, upsert: async () => ({ cents: 0 }) },
      llmCostLedger: {
        findUnique: async () => null,
        upsert: async () => ({ cents: 0 }),
        update: async () => ({ cents: 0 }),
      },
    },
    db: {},
  }));
}

/** An Anthropic SDK 429 whose message quotes the request. */
function rateLimited(): Error {
  return new Anthropic.RateLimitError(
    429,
    {
      type: "error",
      error: { type: "rate_limit_error", message: `rate limit exceeded near: ${CANARY}` },
    },
    `429 rate limit exceeded near: ${CANARY}`,
    new Headers(),
  );
}

const ok = () => vi.fn().mockResolvedValue({ choices: [{ message: { content: "ok" } }] });

const consoleSpies = () => [
  vi.spyOn(console, "warn").mockImplementation(() => {}),
  vi.spyOn(console, "error").mockImplementation(() => {}),
  vi.spyOn(console, "log").mockImplementation(() => {}),
  vi.spyOn(console, "info").mockImplementation(() => {}),
];

/** Everything handed to Sentry, including the error's message, string form and cause. */
function sentryText(): string {
  return JSON.stringify(
    captureError.mock.calls.map(([err, ctx]) => [
      String(err),
      (err as Error)?.message,
      String((err as Error)?.cause ?? ""),
      (err as Error)?.stack,
      ctx,
    ]),
  );
}

function consoleText(spies: ReturnType<typeof consoleSpies>): string {
  return spies
    .flatMap((spy) => spy.mock.calls.flat())
    .map((arg) =>
      arg instanceof Error ? `${String(arg)} ${arg.stack} ${String(arg.cause)}` : String(arg),
    )
    .join("\n");
}

function sentryCall(scope: string) {
  const call = captureError.mock.calls.find(([, ctx]) => ctx?.tags?.scope === scope);
  expect(call, `no Sentry event for ${scope}`).toBeDefined();
  return call as [Error, { tags: Record<string, string>; extra: Record<string, unknown> }];
}

describe("failover signals — no provider message reaches Sentry or the console", () => {
  let spies: ReturnType<typeof consoleSpies>;

  beforeEach(() => {
    vi.resetModules();
    captureError.mockReset();
    spies = consoleSpies();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a user key hitting its limit (BYOK failover) reports facts, not the message", async () => {
    const envCall = ok();
    mockChain([
      fakeProvider("anthropic", "user:u1", vi.fn().mockRejectedValue(rateLimited()), true),
      fakeProvider("anthropic", "env", envCall),
    ]);

    const { createCompletion } = await import("../llm/openai.js");
    await createCompletion(
      { model: "claude-haiku-5-5", messages: [{ role: "user", content: "hi" }] },
      { userId: "u1" },
    );

    expect(envCall).toHaveBeenCalledTimes(1);
    const [err, ctx] = sentryCall("byok.user_key_failover");
    expect(err).toBeInstanceOf(Error);
    expect(ctx.extra).toMatchObject({
      provider: "anthropic",
      keyKind: "byok",
      errorName: "RateLimitError",
      status: 429,
      providerErrorType: "rate_limit_error",
    });
    expect(ctx.extra).not.toHaveProperty("upstream");
    expect(sentryText()).not.toContain(CANARY);
    expect(consoleText(spies)).not.toContain(CANARY);
    expect(consoleText(spies)).toContain("[BYOK]");
  });

  it("the shared key hitting its limit reports facts, not the message", async () => {
    mockChain([
      fakeProvider("anthropic", "env", vi.fn().mockRejectedValue(rateLimited())),
      fakeProvider("gemini", "env", ok()),
    ]);

    const { createCompletion } = await import("../llm/openai.js");
    await createCompletion({
      model: "claude-haiku-5-5",
      messages: [{ role: "user", content: "hi" }],
    });

    const [, ctx] = sentryCall("llm.env_key_limited");
    expect(ctx.extra).toMatchObject({
      provider: "anthropic",
      keyKind: "platform",
      errorName: "RateLimitError",
      status: 429,
    });
    expect(sentryText()).not.toContain(CANARY);
    // markKeyLimited's own cooldown line included.
    expect(consoleText(spies)).toContain("[MODEL-FALLBACK]");
    expect(consoleText(spies)).not.toContain(CANARY);
  });

  it("an exhausted shared-key balance (402) reports facts, not the message", async () => {
    const credit = Object.assign(new Error(`402 credit balance too low: ${CANARY}`), {
      name: "AnthropicCreditExhaustedError",
      status: 402,
    });
    mockChain([
      fakeProvider("anthropic", "env", vi.fn().mockRejectedValue(credit)),
      fakeProvider("gemini", "env", ok()),
    ]);

    const { createCompletion } = await import("../llm/openai.js");
    await createCompletion({
      model: "claude-haiku-5-5",
      messages: [{ role: "user", content: "hi" }],
    });

    const [, ctx] = sentryCall("llm.env_key_limited");
    expect(ctx.extra).toMatchObject({ errorName: "AnthropicCreditExhaustedError", status: 402 });
    expect(sentryText()).not.toContain(CANARY);
    expect(consoleText(spies)).not.toContain(CANARY);
  });

  it("a rejected user key (401) reports facts, not the message", async () => {
    const rejected = Object.assign(new Error(`invalid x-api-key; request: ${CANARY}`), {
      status: 401,
    });
    mockChain([
      fakeProvider("anthropic", "user:u1", vi.fn().mockRejectedValue(rejected), true),
      fakeProvider("anthropic", "env", ok()),
    ]);

    const { createCompletion } = await import("../llm/openai.js");
    await createCompletion(
      { model: "claude-haiku-5-5", messages: [{ role: "user", content: "hi" }] },
      { userId: "u1" },
    );

    const [err, ctx] = sentryCall("byok.user_key_unusable");
    expect(err.message).not.toContain("invalid x-api-key");
    expect(ctx.extra).toMatchObject({
      provider: "anthropic",
      keyKind: "byok",
      status: 401,
      messageLength: rejected.message.length,
    });
    expect(sentryText()).not.toContain(CANARY);
    expect(consoleText(spies)).not.toContain(CANARY);
  });

  it("the vision path's key-limit failover is covered too", async () => {
    mockChain([
      fakeProvider("anthropic", "user:u1", vi.fn().mockRejectedValue(rateLimited()), true),
      fakeProvider("anthropic", "env", ok()),
    ]);

    const { createVisionCompletion } = await import("../llm/openai.js");
    await createVisionCompletion(
      { model: "claude-haiku-5-5", messages: [{ role: "user", content: "read this" }] },
      { userId: "u1" },
    );

    sentryCall("byok.user_key_failover");
    expect(sentryText()).not.toContain(CANARY);
    expect(consoleText(spies)).not.toContain(CANARY);
  });
});
