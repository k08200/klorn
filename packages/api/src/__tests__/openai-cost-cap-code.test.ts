/**
 * DailyCostCapExceededError carries a stable machine-readable `code` so clients
 * can tell the cap apart from an outage (and the free cap — where upgrading
 * helps — apart from the paid/global cap). Drives the REAL enforceCostGates
 * through createCompletion with the cost ledgers stubbed, one case per throw
 * site.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({
  globalAllowed: true,
  globalOverCapAfterPrebill: false,
  userAllowed: true,
  userOverCapAfterPrebill: false,
  freeCapApplied: false,
}));

vi.mock("../billing/cost-guard.js", () => ({
  checkGlobalCostGate: vi.fn(async () => ({ allowed: gate.globalAllowed })),
  recordGlobalCostUsage: vi.fn(async () => ({ overCap: gate.globalOverCapAfterPrebill })),
  checkCostGate: vi.fn(async () => ({
    allowed: gate.userAllowed,
    freeCapApplied: gate.freeCapApplied,
  })),
  recordCostUsage: vi.fn(async () => ({ overCap: gate.userOverCapAfterPrebill })),
}));

const providerCall = vi.hoisted(() => vi.fn());
vi.mock("../providers/index.js", () => ({
  getProvider: vi.fn(() => null),
  getProviderChain: vi.fn(() => [
    {
      name: "openrouter",
      quotaKey: "openrouter:test",
      defaultModel: "fake-default",
      supportsTools: true,
      client: null,
      resolveModel: (m: string) => m,
      call: providerCall,
    },
  ]),
}));
vi.mock("../billing/llm-usage.js", () => ({
  recordLlmUsage: vi.fn(async () => {}),
  estimatePrebillCents: vi.fn(() => 1),
  trueUpCostLedgers: vi.fn(async () => {}),
}));
vi.mock("../db.js", () => ({ prisma: {}, db: {} }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import {
  createCompletion,
  DAILY_COST_CAP_MESSAGE,
  DAILY_COST_CAP_UPGRADE_MESSAGE,
  DailyCostCapExceededError,
} from "../llm/openai.js";

const PARAMS = { model: "test/model", messages: [{ role: "user" as const, content: "hi" }] };

async function capError(): Promise<DailyCostCapExceededError> {
  const err = await createCompletion(PARAMS, { userId: "user-1" }).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DailyCostCapExceededError);
  return err as DailyCostCapExceededError;
}

beforeEach(() => {
  Object.assign(gate, {
    globalAllowed: true,
    globalOverCapAfterPrebill: false,
    userAllowed: true,
    userOverCapAfterPrebill: false,
    freeCapApplied: false,
  });
  providerCall.mockReset();
});

describe("DailyCostCapExceededError.code", () => {
  it("defaults to DAILY_COST_CAP when constructed with a message only", () => {
    expect(new DailyCostCapExceededError("x").code).toBe("DAILY_COST_CAP");
  });

  it("the free cap (read-side gate) is DAILY_COST_CAP_FREE with the upgrade message", async () => {
    gate.userAllowed = false;
    gate.freeCapApplied = true;
    const err = await capError();
    expect(err.code).toBe("DAILY_COST_CAP_FREE");
    expect(err.message).toBe(DAILY_COST_CAP_UPGRADE_MESSAGE);
  });

  it("the free cap (post-prebill re-check) is DAILY_COST_CAP_FREE too", async () => {
    gate.userOverCapAfterPrebill = true;
    gate.freeCapApplied = true;
    const err = await capError();
    expect(err.code).toBe("DAILY_COST_CAP_FREE");
    expect(err.message).toBe(DAILY_COST_CAP_UPGRADE_MESSAGE);
  });

  it("the paid per-user cap is DAILY_COST_CAP (read-side and post-prebill)", async () => {
    gate.userAllowed = false;
    expect((await capError()).code).toBe("DAILY_COST_CAP");
    gate.userAllowed = true;
    gate.userOverCapAfterPrebill = true;
    const err = await capError();
    expect(err.code).toBe("DAILY_COST_CAP");
    expect(err.message).toBe(DAILY_COST_CAP_MESSAGE);
  });

  it("the global ceiling is DAILY_COST_CAP (read-side and post-prebill)", async () => {
    gate.globalAllowed = false;
    expect((await capError()).code).toBe("DAILY_COST_CAP");
    gate.globalAllowed = true;
    gate.globalOverCapAfterPrebill = true;
    expect((await capError()).code).toBe("DAILY_COST_CAP");
    expect(providerCall).not.toHaveBeenCalled();
  });
});
