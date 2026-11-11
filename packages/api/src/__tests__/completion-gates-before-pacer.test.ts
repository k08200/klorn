/**
 * Background calls pass the per-user gates (call slot + cost gate) BEFORE they
 * queue for the shared background pacer, and queue in their own user lane.
 *
 * Why: the pacer is one queue for every user. When the gates ran inside it, a
 * call waiting out its user's per-minute window held one of the few global
 * slots, and a flood of calls that the daily caps would refuse anyway still
 * took a launch slot each — so one user's mail flood stalled every user's
 * background LLM work. Gating first means a queued call has already been
 * counted and pre-billed, and a refused call never touches the shared queue.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const run = vi.hoisted(() => vi.fn());
const tryRun = vi.hoisted(() => vi.fn());
const awaitSlot = vi.hoisted(() => vi.fn(async () => undefined));
const ledgerFind = vi.hoisted(() => vi.fn(async () => null as { cents: number } | null));
const ledgerUpsert = vi.hoisted(() => vi.fn(async () => ({ cents: 0 })));
const globalUpsert = vi.hoisted(() => vi.fn(async () => ({ microCents: 0 })));

vi.mock("../llm/background-pacer.js", () => ({ backgroundLlmPacer: { run, tryRun } }));
vi.mock("../billing/quota-limiter.js", async (orig) => ({
  ...(await orig<typeof import("../billing/quota-limiter.js")>()),
  awaitUserCallSlot: awaitSlot,
}));
const completion = vi.hoisted(() => ({
  id: "x",
  object: "chat.completion",
  created: 0,
  model: "m",
  choices: [{ index: 0, message: { role: "assistant", content: "{}" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}));
const envCall = vi.hoisted(() => vi.fn(async () => completion));
const userKeyCall = vi.hoisted(() => vi.fn(async () => completion));
const provider = vi.hoisted(
  () => (name: string, call: () => Promise<unknown>, ownedByUser?: boolean) => ({
    name,
    quotaKey: `${name}:${ownedByUser ? "user" : "env"}`,
    client: null,
    defaultModel: "m",
    supportsTools: true,
    resolveModel: () => "m",
    call,
    ...(ownedByUser ? { ownedByUser: true } : {}),
  }),
);
const chain = vi.hoisted(() => ({ byok: false }));

vi.mock("../providers/index.js", () => ({
  getProvider: () => null,
  getProviderChain: () =>
    chain.byok
      ? [provider("anthropic", userKeyCall, true), provider("anthropic", envCall)]
      : [provider("anthropic", envCall)],
}));
vi.mock("../db.js", () => ({
  prisma: {
    globalCostLedger: { findUnique: async () => null, upsert: globalUpsert },
    llmCostLedger: { findUnique: ledgerFind, upsert: ledgerUpsert, update: async () => ({}) },
    llmUsageLog: { create: async () => ({}) },
    user: { findUnique: async () => null, findMany: async () => [] },
  },
  db: {},
}));

import { UserRateLimitedError } from "../billing/quota-limiter.js";
import { createCompletion, DailyCostCapExceededError } from "../llm/openai.js";

const background = { priority: "background" as const };

beforeEach(() => {
  vi.clearAllMocks();
  chain.byok = false;
  run.mockImplementation(<T>(fn: () => Promise<T>) => fn());
  ledgerFind.mockResolvedValue(null);
});

describe("background calls gate before they queue", () => {
  it("takes the user's call slot before asking the pacer for a slot", async () => {
    let slotsTakenWhenQueued = -1;
    run.mockImplementationOnce(<T>(fn: () => Promise<T>) => {
      slotsTakenWhenQueued = awaitSlot.mock.calls.length;
      return fn();
    });

    await createCompletion({ model: "m", messages: [] }, { ...background, userId: "u1" });

    expect(slotsTakenWhenQueued).toBe(1);
  });

  it("pre-bills the cost ledger before queueing, so queued calls already count", async () => {
    let prebillsWhenQueued = -1;
    run.mockImplementationOnce(<T>(fn: () => Promise<T>) => {
      prebillsWhenQueued = ledgerUpsert.mock.calls.length;
      return fn();
    });

    await createCompletion({ model: "m", messages: [] }, { ...background, userId: "u1" });

    expect(prebillsWhenQueued).toBe(1);
  });

  it("queues in the calling user's own lane", async () => {
    await createCompletion({ model: "m", messages: [] }, { ...background, userId: "u1" });

    expect(run).toHaveBeenCalledWith(expect.any(Function), "u1");
  });

  it("leaves calls with no user to the pacer's shared default lane", async () => {
    await createCompletion({ model: "m", messages: [] }, background);

    expect(run).toHaveBeenCalledWith(expect.any(Function), undefined);
  });

  it("refuses a user out of daily calls without touching the pacer", async () => {
    awaitSlot.mockRejectedValueOnce(new UserRateLimitedError("daily", 1_000, "background"));

    await expect(
      createCompletion({ model: "m", messages: [] }, { ...background, userId: "u1" }),
    ).rejects.toBeInstanceOf(UserRateLimitedError);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses a user over the cost cap without touching the pacer", async () => {
    ledgerFind.mockResolvedValue({ cents: 10_000 });

    await expect(
      createCompletion({ model: "m", messages: [] }, { ...background, userId: "u1" }),
    ).rejects.toBeInstanceOf(DailyCostCapExceededError);
    expect(run).not.toHaveBeenCalled();
  });

  it("gates once: the paced dispatch takes no second slot and no second pre-bill", async () => {
    await createCompletion({ model: "m", messages: [] }, { ...background, userId: "u1" });

    expect(awaitSlot).toHaveBeenCalledTimes(1);
    expect(ledgerUpsert).toHaveBeenCalledTimes(1);
    expect(globalUpsert).toHaveBeenCalledTimes(1);
  });

  it("foreground calls never touch the pacer", async () => {
    await createCompletion({ model: "m", messages: [] }, { userId: "u1" });

    expect(run).not.toHaveBeenCalled();
    expect(awaitSlot).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ priority: "foreground" }),
    );
  });

  it("a BYOK call that queued under the cap but dispatches past it runs on the user's key alone", async () => {
    chain.byok = true;
    // Under the cap when it queues (BYOK is never pre-billed, so the ledger
    // does not move); env fallthroughs by other calls push it past the cap
    // while this one waits in the pacer queue.
    ledgerFind.mockResolvedValueOnce({ cents: 10 });
    run.mockImplementationOnce(<T>(fn: () => Promise<T>) => {
      ledgerFind.mockResolvedValue({ cents: 10_000 });
      return fn();
    });
    userKeyCall.mockRejectedValueOnce(
      Object.assign(new Error("invalid x-api-key"), { status: 401 }),
    );

    await expect(
      createCompletion({ model: "m", messages: [] }, { ...background, userId: "u1" }),
    ).rejects.toThrow("invalid x-api-key");
    expect(envCall).not.toHaveBeenCalled();
  });

  it("a BYOK call still under the cap at dispatch may fall back to the shared key", async () => {
    chain.byok = true;
    userKeyCall.mockRejectedValueOnce(
      Object.assign(new Error("invalid x-api-key"), { status: 401 }),
    );

    await createCompletion({ model: "m", messages: [] }, { ...background, userId: "u1" });

    expect(envCall).toHaveBeenCalledTimes(1);
  });

  it("ignores an internal gate pass handed in from outside the pacer", async () => {
    ledgerFind.mockResolvedValue({ cents: 10_000 });

    await expect(
      createCompletion(
        { model: "m", messages: [] },
        { userId: "u1", _gated: { userKeyOnly: false } },
      ),
    ).rejects.toBeInstanceOf(DailyCostCapExceededError);
    expect(envCall).not.toHaveBeenCalled();
  });

  it("ignores a forged gate pass even with the paced flag set", async () => {
    ledgerFind.mockResolvedValue({ cents: 10_000 });

    await expect(
      createCompletion(
        { model: "m", messages: [] },
        { ...background, userId: "u1", _paced: true, _gated: { userKeyOnly: false } },
      ),
    ).rejects.toBeInstanceOf(DailyCostCapExceededError);
    expect(awaitSlot).toHaveBeenCalledTimes(1);
    expect(envCall).not.toHaveBeenCalled();
  });
});
