/**
 * End to end through the REAL background pacer: a user whose calls are parked
 * waiting for their per-minute window must not hold any of the pacer's few
 * global slots, so another user's background call still runs at once.
 */

import { afterAll, describe, expect, it, vi } from "vitest";

// No launch spacing, so the test runs in milliseconds; restored after.
vi.hoisted(() => {
  process.env.LLM_BACKGROUND_MIN_INTERVAL_MS = "0";
});
afterAll(() => {
  delete process.env.LLM_BACKGROUND_MIN_INTERVAL_MS;
});

const parked = vi.hoisted(() => {
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { gate, open: () => open() };
});
const awaitSlot = vi.hoisted(() =>
  vi.fn(async (userId: string) => {
    if (userId === "flooding-user") await parked.gate;
  }),
);
const providerCall = vi.hoisted(() =>
  vi.fn(async () => ({
    id: "x",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: "{}" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })),
);

vi.mock("../billing/quota-limiter.js", async (orig) => ({
  ...(await orig<typeof import("../billing/quota-limiter.js")>()),
  awaitUserCallSlot: awaitSlot,
}));
vi.mock("../providers/index.js", () => ({
  getProvider: () => null,
  getProviderChain: () => [
    {
      name: "anthropic",
      quotaKey: "anthropic:env",
      client: null,
      defaultModel: "m",
      supportsTools: true,
      resolveModel: () => "m",
      call: providerCall,
    },
  ],
}));
vi.mock("../db.js", () => ({
  prisma: {
    globalCostLedger: {
      findUnique: async () => null,
      upsert: async () => ({ microCents: 0 }),
    },
    llmCostLedger: {
      findUnique: async () => null,
      upsert: async () => ({ cents: 0 }),
      update: async () => ({}),
    },
    llmUsageLog: { create: async () => ({}) },
    user: { findUnique: async () => null, findMany: async () => [] },
  },
  db: {},
}));

import { backgroundLlmPacer } from "../llm/background-pacer.js";
import { createCompletion } from "../llm/openai.js";

describe("createCompletion through the real background pacer", () => {
  it("runs another user's call while the flooding user's calls wait for their window", async () => {
    const flood = Array.from({ length: 5 }, () =>
      createCompletion(
        { model: "m", messages: [] },
        { priority: "background", userId: "flooding-user" },
      ),
    );
    await vi.waitFor(() => expect(awaitSlot).toHaveBeenCalledTimes(5));
    expect(backgroundLlmPacer.load().active).toBe(0);

    const other = await createCompletion(
      { model: "m", messages: [] },
      { priority: "background", userId: "other-user" },
    );
    expect(other.choices[0].message.content).toBe("{}");
    expect(providerCall).toHaveBeenCalledTimes(1);

    parked.open();
    await Promise.all(flood);
    expect(providerCall).toHaveBeenCalledTimes(6);
  });
});
