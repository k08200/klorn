/**
 * D4 against the production failure of #1319: every LLM provider refuses (402,
 * no OpenRouter credits). This runs the REAL LLM layer (createCompletion, its
 * failover and failure ledger) with a provider chain that always fails, behind
 * the real drive routes and the real summary job.
 *
 * Uploads and listings must not notice. A summary waits PENDING with
 * `llm-unavailable` and keeps retrying with a backoff capped at a day: an outage
 * is never a content failure, and it gives the user's daily slots back.
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
// The per-user RPM window parks a background call for a slot; the sweeps here
// run back to back on a test clock, so the wall-clock window would only stall them.
vi.mock("../billing/quota-limiter.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../billing/quota-limiter.js")>()),
  awaitUserCallSlot: vi.fn(async () => {}),
}));
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
  it("uploads and listings work; the summary waits PENDING with a code, never FAILED", async () => {
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

    // The job keeps retrying on later sweeps: an outage never turns into FAILED,
    // its wait doubles up to a day, and it spends none of the user's daily count.
    const { runDriveSummarySweep } = await import("../drive/summary-job.js");
    const { DRIVE_SUMMARY_OUTAGE_MAX_MS } = await import("../drive/summary-policy.js");
    const row = () => holder.db?.tables.driveFileSummary[0];
    let now = Date.parse("2026-10-20T00:00:00.000Z");
    for (let i = 0; i < 15; i++) {
      now = Math.max(now, (row()?.nextAttemptAt as Date).getTime());
      await runDriveSummarySweep(new Date(now));
    }
    expect(row()).toMatchObject({ status: "PENDING", error: "llm-unavailable", attempts: 0 });
    const wait = (row()?.nextAttemptAt as Date).getTime() - now;
    expect(wait).toBe(DRIVE_SUMMARY_OUTAGE_MAX_MS);
    expect(holder.db?.tables.driveSummaryUsage.every((u) => u.count === 0)).toBe(true);

    const again = await upload(t, t.me, {
      filename: "second.txt",
      data: Buffer.from("more", "utf8"),
      contentType: "text/plain",
    });
    expect(again.statusCode).toBe(201);
  });
});
