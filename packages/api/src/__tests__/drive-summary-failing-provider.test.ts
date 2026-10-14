/**
 * D4 against the production failure of #1319: every LLM provider refuses (402,
 * no OpenRouter credits). This runs the REAL LLM layer (createCompletion, its
 * failover and failure ledger) with a provider chain that always fails, behind
 * the real drive routes and the real summary job.
 *
 * Uploads and listings must not notice. A summary waits PENDING with
 * `llm-unavailable`, retries with backoff, and ends FAILED with that code.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildKlornDriveApp,
  flagsOn,
  holder,
  type KlornDriveTestApp,
  PREFIX,
  upload,
} from "./helpers/klorn-drive-app.js";

const providerCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("../db.js", async () => {
  const { klornDriveDbMock } = await import("./helpers/klorn-drive-app.js");
  return klornDriveDbMock();
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../providers/index.js", () => {
  const refuse = async () => {
    providerCalls.count += 1;
    throw Object.assign(new Error("Insufficient credits"), { status: 402 });
  };
  const provider = (name: "openrouter" | "gemini") => ({
    name,
    quotaKey: `${name}:env`,
    defaultModel: "fake-default",
    supportsTools: false,
    client: null,
    resolveModel: (m: string) => m,
    call: refuse,
  });
  return {
    getProvider: vi.fn(() => null),
    getProviderChain: vi.fn(() => [provider("openrouter"), provider("gemini")]),
  };
});
// The cost gates and the usage ledger write to tables this fake does not hold.
vi.mock("../billing/cost-guard.js", () => ({
  checkCostGate: vi.fn(async () => ({ allowed: true })),
  recordCostUsage: vi.fn(async () => ({ overCap: false, totalCents: 0 })),
  checkGlobalCostGate: vi.fn(async () => ({ allowed: true })),
  recordGlobalCostUsage: vi.fn(async () => ({ overCap: false, totalCents: 0 })),
}));
vi.mock("../billing/llm-usage.js", () => ({
  recordLlmUsage: vi.fn(async () => {}),
  estimatePrebillCents: vi.fn(() => 0),
  trueUpCostLedgers: vi.fn(async () => {}),
}));
vi.mock("../llm/llm-credentials.js", () => ({ getUserLlmCredentials: vi.fn(async () => ({})) }));
// The process-wide pacer spaces background calls 4 s apart; the job's runs here
// would wait on it. Pass-through: the pacing is not what is under test.
vi.mock("../llm/background-pacer.js", () => ({
  backgroundLlmPacer: { run: <T>(task: () => Promise<T>) => task() },
}));

let t: KlornDriveTestApp;

beforeEach(async () => {
  flagsOn();
  vi.stubEnv("DRIVE_SUMMARIES_ENABLED", "true");
  providerCalls.count = 0;
  t = await buildKlornDriveApp();
});

afterEach(async () => {
  await t.app.close();
  vi.unstubAllEnvs();
});

describe("every provider refuses (#1319)", () => {
  it("uploads and listings work; the summary waits, retries and fails with a code", async () => {
    const res = await upload(t, t.me, {
      filename: "plan.txt",
      data: Buffer.from("Launch plan: beta on 2026-11-02, 100 seats.", "utf8"),
      contentType: "text/plain",
    });
    expect(res.statusCode).toBe(201);
    const file = res.json().file as { id: string };

    const onDemand = await t.app.inject({
      method: "POST",
      url: `${PREFIX}/files/${file.id}/summarize`,
      headers: t.me,
    });
    expect(onDemand.statusCode).toBe(200);
    expect(onDemand.json().summary).toEqual({
      status: "PENDING",
      text: null,
      error: "llm-unavailable",
      summarizedAt: null,
    });
    expect(providerCalls.count).toBeGreaterThan(0);

    const list = await t.app.inject({ method: "GET", url: `${PREFIX}/files`, headers: t.me });
    expect(list.statusCode).toBe(200);
    expect(list.json().files).toHaveLength(1);
    const meta = await t.app.inject({
      method: "GET",
      url: `${PREFIX}/files/${file.id}`,
      headers: t.me,
    });
    expect(meta.statusCode).toBe(200);
    expect(meta.json().summary.status).toBe("PENDING");

    // The job takes the retries on later days (the per-file count is 3 a day).
    const { runDriveSummarySweep } = await import("../drive/summary-job.js");
    const row = () => holder.db?.tables.driveFileSummary[0];
    let day = Date.parse("2026-10-20T00:00:00.000Z");
    for (let i = 0; i < 6 && row()?.status === "PENDING"; i++) {
      day += 2 * 24 * 60 * 60_000;
      await runDriveSummarySweep(new Date(day));
    }
    expect(row()).toMatchObject({ status: "FAILED", error: "llm-unavailable", summary: null });

    const again = await upload(t, t.me, {
      filename: "second.txt",
      data: Buffer.from("more", "utf8"),
      contentType: "text/plain",
    });
    expect(again.statusCode).toBe(201);
  });
});
