/**
 * createCompletion's noWait: optional background work skips instead of waiting
 * for a pacer slot or an RPM slot, so it never sits in front of the judge.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const tryRun = vi.hoisted(() => vi.fn());
const run = vi.hoisted(() => vi.fn(<T>(fn: () => Promise<T>) => fn()));
const awaitSlot = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../llm/background-pacer.js", () => ({ backgroundLlmPacer: { run, tryRun } }));
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
      call: async () => ({
        id: "x",
        object: "chat.completion",
        created: 0,
        model: "m",
        choices: [
          { index: 0, message: { role: "assistant", content: "{}" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    },
  ],
}));
vi.mock("../db.js", () => ({
  prisma: {
    globalCostLedger: { findUnique: async () => null, upsert: async () => ({ cents: 0 }) },
    llmCostLedger: {
      findUnique: async () => null,
      upsert: async () => ({ cents: 0 }),
      update: async () => ({ cents: 0 }),
    },
    llmUsageLog: { create: async () => ({}) },
  },
  db: {},
}));

import { createCompletion, PacerBusyError } from "../llm/openai.js";

beforeEach(() => vi.clearAllMocks());

describe("createCompletion noWait", () => {
  it("throws PacerBusyError when no pacer slot is free, and never queues", async () => {
    tryRun.mockReturnValueOnce(null);
    await expect(
      createCompletion({ model: "m", messages: [] }, { priority: "background", noWait: true }),
    ).rejects.toBeInstanceOf(PacerBusyError);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs through tryRun when a slot is free, and does not park on RPM", async () => {
    tryRun.mockImplementationOnce(<T>(fn: () => Promise<T>) => fn());
    const res = await createCompletion(
      { model: "m", messages: [] },
      { priority: "background", noWait: true, userId: "u1" },
    );
    expect(res.choices[0].message.content).toBe("{}");
    expect(awaitSlot).toHaveBeenCalledWith("u1", expect.objectContaining({ maxWaitMs: 0 }));
  });

  it("ordinary background calls still queue (unchanged)", async () => {
    await createCompletion({ model: "m", messages: [] }, { priority: "background" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(tryRun).not.toHaveBeenCalled();
  });
});
