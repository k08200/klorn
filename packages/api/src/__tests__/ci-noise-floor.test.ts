/**
 * CI-noise SILENT floor integration (#793) — flag-gated behavior in judgeEmail
 * plus the eval-set no-flip invariant the issue demands.
 *
 * CI_NOISE_SILENT_FLOOR=false (default): tiers are byte-identical to before;
 * the detector only emits a shadow log so dogfood can measure would-be
 * silences before the founder flips anything.
 * CI_NOISE_SILENT_FLOOR=true: detected noise is floored to SILENT on the
 * scoring paths (LLM / keyword fallback) — never on prior/rule short-circuits.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createCompletionMock = vi.hoisted(() => vi.fn());

vi.mock("../llm/openai.js", () => ({
  createCompletion: createCompletionMock,
  MODEL: "test-model",
  JUDGE_MODEL: "test-judge-model",
}));

vi.mock("../sentry.js", () => ({
  captureError: vi.fn(),
}));

import { judgeEmail, POC_TIERS, type PocTier } from "../judge/poc-judge.js";

const EVAL_SET_PATH = fileURLToPath(new URL("../../eval/judge-eval-set.json", import.meta.url));

function ciNoiseEmail() {
  return {
    id: "noise-1",
    from: "Vercel <noreply@vercel.com>",
    subject: "Failed preview deployment: klorn-web",
    snippet: "The preview build for branch feat/x failed.",
    body: null,
    labels: [],
  };
}

beforeEach(() => {
  createCompletionMock.mockReset();
  createCompletionMock.mockRejectedValue(new Error("provider down"));
  delete process.env.CI_NOISE_SILENT_FLOOR;
});

afterEach(() => {
  delete process.env.CI_NOISE_SILENT_FLOOR;
});

describe("CI-noise SILENT floor (flag-gated)", () => {
  it("flag OFF (default): tier unchanged, shadow only", async () => {
    const judgement = await judgeEmail(ciNoiseEmail());
    expect(judgement.tier).not.toBe("SILENT");
    expect(judgement.source).toBe("keyword-fallback");
  });

  it("flag ON: detected noise is floored to SILENT", async () => {
    process.env.CI_NOISE_SILENT_FLOOR = "true";
    const judgement = await judgeEmail(ciNoiseEmail());
    expect(judgement.tier).toBe("SILENT");
    expect(judgement.reason).toMatch(/CI\/monitoring/i);
  });

  it("flag ON: a real operational alert is NOT silenced", async () => {
    process.env.CI_NOISE_SILENT_FLOOR = "true";
    const judgement = await judgeEmail({
      id: "down-1",
      from: "UptimeRobot <alert@uptimerobot.com>",
      subject: "Monitor is DOWN: prod-api",
      snippet: "Your monitor prod-api is currently down.",
      body: null,
      labels: [],
    });
    expect(judgement.tier).not.toBe("SILENT");
  });
});

describe("eval-set no-flip invariant (#793 guard)", () => {
  interface EvalItem {
    id: string;
    from: string;
    subject: string;
    snippet: string | null;
    labels: string[];
    label: PocTier | null;
  }

  it("every committed eval item judges identically with the flag OFF and ON", async () => {
    const file = JSON.parse(readFileSync(EVAL_SET_PATH, "utf8")) as { items: EvalItem[] };
    const items = file.items.filter(
      (i): i is EvalItem & { label: PocTier } =>
        i.label !== null && POC_TIERS.includes(i.label as PocTier),
    );
    expect(items.length).toBeGreaterThanOrEqual(50);

    for (const item of items) {
      const email = {
        id: item.id,
        from: item.from,
        subject: item.subject,
        snippet: item.snippet ?? null,
        body: null,
        labels: item.labels,
      };
      delete process.env.CI_NOISE_SILENT_FLOOR;
      const off = await judgeEmail(email);
      process.env.CI_NOISE_SILENT_FLOOR = "true";
      const on = await judgeEmail(email);
      expect(on.tier, `item ${item.id} (${item.subject}) flipped ${off.tier}→${on.tier}`).toBe(
        off.tier,
      );
    }
  });
});
