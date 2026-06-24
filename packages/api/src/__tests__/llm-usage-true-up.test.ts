/**
 * Cost-gate true-up tests.
 *
 * Regression for the 0¢ pre-bill bug: enforceCostGates used to charge
 * estimateModelCostUsd(model, 0, 0), which is token-linear and therefore
 * always 0 — the daily cost caps never accumulated for paid models. The
 * fix is a nominal-token pre-bill floor (estimatePrebillCents) plus a
 * post-call settlement against actual usage (trueUpCostLedgers).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const recordCostUsage = vi.hoisted(() => vi.fn());
const recordGlobalCostUsage = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({ prisma: {}, db: {} }));

vi.mock("../cost-guard.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordCostUsage,
  recordGlobalCostUsage,
}));

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { estimatePrebillCents, trueUpCostLedgers } from "../llm-usage.js";

const PAID_MODEL = "anthropic/claude-sonnet-4-6";
const FREE_MODEL = "google/gemma-4-31b-it:free";

beforeEach(() => {
  recordCostUsage.mockReset();
  recordGlobalCostUsage.mockReset();
});

describe("estimatePrebillCents", () => {
  it("charges a non-zero floor for paid models (the 0¢ bug)", () => {
    expect(estimatePrebillCents(PAID_MODEL)).toBeGreaterThanOrEqual(1);
  });

  it("stays 0 for :free models", () => {
    expect(estimatePrebillCents(FREE_MODEL)).toBe(0);
  });
});

describe("trueUpCostLedgers", () => {
  it("charges the positive delta to both ledgers when actuals exceed the pre-bill", async () => {
    // 1M prompt tokens → far above the nominal-token pre-bill floor.
    await trueUpCostLedgers({
      userId: "u1",
      model: PAID_MODEL,
      prebilledCents: estimatePrebillCents(PAID_MODEL),
      usage: { prompt_tokens: 1_000_000, completion_tokens: 50_000 },
    });
    expect(recordCostUsage).toHaveBeenCalledTimes(1);
    const [userId, delta, model] = recordCostUsage.mock.calls[0];
    expect(userId).toBe("u1");
    expect(delta).toBeGreaterThan(0);
    expect(model).toBe(PAID_MODEL);
    expect(recordGlobalCostUsage).toHaveBeenCalledWith(delta);
  });

  it("charges only the global ledger for system calls (no userId)", async () => {
    await trueUpCostLedgers({
      userId: null,
      model: PAID_MODEL,
      prebilledCents: 0,
      usage: { prompt_tokens: 1_000_000, completion_tokens: 50_000 },
    });
    expect(recordCostUsage).not.toHaveBeenCalled();
    expect(recordGlobalCostUsage).toHaveBeenCalledTimes(1);
  });

  it("does nothing when usage is missing (streaming)", async () => {
    await trueUpCostLedgers({
      userId: "u1",
      model: PAID_MODEL,
      prebilledCents: 1,
      usage: null,
    });
    expect(recordCostUsage).not.toHaveBeenCalled();
    expect(recordGlobalCostUsage).not.toHaveBeenCalled();
  });

  it("does not refund when the pre-bill overshot the actuals", async () => {
    await trueUpCostLedgers({
      userId: "u1",
      model: PAID_MODEL,
      prebilledCents: 1000,
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect(recordCostUsage).not.toHaveBeenCalled();
    expect(recordGlobalCostUsage).not.toHaveBeenCalled();
  });

  it("does nothing for free models even with huge usage", async () => {
    await trueUpCostLedgers({
      userId: "u1",
      model: FREE_MODEL,
      prebilledCents: 0,
      usage: { prompt_tokens: 5_000_000, completion_tokens: 100_000 },
    });
    expect(recordCostUsage).not.toHaveBeenCalled();
    expect(recordGlobalCostUsage).not.toHaveBeenCalled();
  });

  it("charges NOTHING when the call was served on the user's own (BYOK) key", async () => {
    // BYOK: the user paid their own provider, so Klorn's per-user cap and the
    // shared global ceiling stay untouched even on a paid model with large
    // usage — that is the contract behind "add your own key in Settings".
    await trueUpCostLedgers({
      userId: "u1",
      model: PAID_MODEL,
      prebilledCents: 0,
      usage: { prompt_tokens: 1_000_000, completion_tokens: 50_000 },
      servedByUserKey: true,
    });
    expect(recordCostUsage).not.toHaveBeenCalled();
    expect(recordGlobalCostUsage).not.toHaveBeenCalled();
  });

  it("charges the FULL actual cost on an env fallthrough (the BYOK key failed)", async () => {
    // The user's key errored and the call fell through to Klorn's env provider,
    // so Klorn DID pay. The gate skipped the pre-bill (prebilledCents: 0), so
    // the full actual cost is charged here — not a delta against a pre-bill
    // that never happened. This is what closes the "junk key dodges the cap"
    // hole: env spend always lands on the ledgers.
    await trueUpCostLedgers({
      userId: "u1",
      model: PAID_MODEL,
      prebilledCents: 0,
      usage: { prompt_tokens: 1_000_000, completion_tokens: 50_000 },
      servedByUserKey: false,
    });
    expect(recordCostUsage).toHaveBeenCalledTimes(1);
    const [userId, charged] = recordCostUsage.mock.calls[0];
    expect(userId).toBe("u1");
    expect(charged).toBeGreaterThan(0);
    expect(recordGlobalCostUsage).toHaveBeenCalledWith(charged);
  });
});
