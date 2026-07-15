/**
 * Automated-sender PUSH floor (P0-A).
 *
 * Founder decision (2026-07-09): a machine-generated sender must never
 * INTERRUPT — no-reply@ / notifications@ / updates.* land QUEUE (a glance),
 * never PUSH. This is the sender-based complement to the subject-based
 * `isRoutineAccountConfirmation` cap: it catches Vercel/GitHub/monitoring
 * notices whose subject ("Failed deploy", "Monitor is DOWN") the LLM
 * over-scores as urgent even though no human is asking for anything.
 *
 * The founder's own ground truth agrees — every automated sender in
 * eval/judge-eval-set.json is labeled QUEUE or AUTO, never PUSH — so this
 * floor only ever fires on a live misclassification, never on the eval gate.
 */

import { describe, expect, it, vi } from "vitest";

// Force the LLM path unavailable so judgeEmail takes the deterministic keyword
// fallback — where a system-notification sender with an urgent word ("action
// required") scores PUSH and the floor must demote it to QUEUE.
vi.mock("../llm/openai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/openai.js")>();
  return {
    ...actual,
    createCompletion: vi.fn(async () => {
      throw new Error("LLM disabled — keyword fallback expected");
    }),
  };
});

import { isAutomatedSender } from "../keyword-policy.js";
import { judgeEmail } from "../poc-judge.js";

describe("isAutomatedSender", () => {
  it("matches machine-generated senders (no-reply / notifications@ / subdomains)", () => {
    expect(isAutomatedSender("Vercel <noreply@vercel.com>")).toBe(true);
    expect(isAutomatedSender("GitHub <notifications@github.com>")).toBe(true);
    expect(isAutomatedSender("Google <no-reply@accounts.google.com>")).toBe(true);
    expect(isAutomatedSender("Linear <notifications@linear.app>")).toBe(true);
    expect(isAutomatedSender("Acme <donotreply@acme.io>")).toBe(true);
    expect(isAutomatedSender("Shop <order-update@store.com>")).toBe(true);
  });

  it("does NOT match a real human sender (must stay PUSH-eligible)", () => {
    expect(isAutomatedSender("Sarah Kim <sarah@acmecorp.com>")).toBe(false);
    expect(isAutomatedSender("Sequoia <partner@sequoiacap.com>")).toBe(false);
    expect(isAutomatedSender("Shinhan Card <alert@shinhancard.com>")).toBe(false);
    expect(isAutomatedSender("")).toBe(false);
  });
});

describe("judgeEmail — automated-sender PUSH floor", () => {
  it("demotes a PUSH-scoring automated sender to QUEUE (keyword fallback)", async () => {
    const out = await judgeEmail({
      from: "GitHub <notifications@github.com>",
      subject: "Action required: review requested today",
      labels: [],
    });
    // Without the floor, the keyword fallback scores this PUSH (system notice +
    // urgent word). The floor must catch it.
    expect(out.tier).toBe("QUEUE");
    expect(out.source).toBe("keyword-fallback");
  });

  it("does NOT demote a real human urgent sender (floor leaves PUSH intact)", async () => {
    // An investor is a keyword-recognised human (patternMatched confidence 0.7)
    // so the fallback can reach PUSH; the floor must leave it alone.
    const out = await judgeEmail({
      from: "Sequoia <partner@sequoiacap.com>",
      subject: "Need the updated deck today — action required",
      labels: [],
    });
    expect(out.tier).toBe("PUSH");
  });

  it("leaves a non-PUSH automated sender untouched (no forced SILENT/QUEUE churn)", async () => {
    // No urgent word → keyword fallback scores QUEUE already; the floor is a
    // no-op here (it only ever demotes PUSH), so the tier is unchanged.
    const out = await judgeEmail({
      from: "Vercel <noreply@vercel.com>",
      subject: "Deployment completed: klorn-web",
      labels: [],
    });
    expect(out.tier).toBe("QUEUE");
  });
});
