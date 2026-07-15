import { describe, expect, it } from "vitest";
import { EVAL_SCENARIOS, runAllScenarios, summarizeEval } from "../agentcore/agent-eval.js";

describe("agent-eval", () => {
  it("has a non-empty scenario catalog", () => {
    expect(EVAL_SCENARIOS.length).toBeGreaterThan(0);
  });

  it("assigns unique IDs to every scenario", () => {
    const ids = EVAL_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all current scenarios pass against production decision logic", () => {
    const results = runAllScenarios();
    const failures = results.filter((r) => !r.passed);
    if (failures.length > 0) {
      const report = failures
        .map((f) => `[${f.scenario.severity}] ${f.scenario.id}: ${f.message}`)
        .join("\n");
      throw new Error(`Eval scenarios failed:\n${report}`);
    }
    expect(failures.length).toBe(0);
  });

  it("summary produces correct pass rate", () => {
    const results = runAllScenarios();
    const summary = summarizeEval(results);
    expect(summary.total).toBe(results.length);
    expect(summary.passed + summary.failed).toBe(summary.total);
    expect(summary.passRate).toBeGreaterThanOrEqual(0);
    expect(summary.passRate).toBeLessThanOrEqual(1);
  });

  it("summary captures failure details with severity", () => {
    const fakeResults = [
      {
        scenario: {
          id: "fake-01",
          name: "Fake failure",
          description: "test",
          severity: "critical" as const,
          category: "risk-gating" as const,
          run: () => null,
        },
        passed: false,
        message: "simulated failure",
      },
    ];
    const summary = summarizeEval(fakeResults);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].severity).toBe("critical");
    expect(summary.failures[0].message).toBe("simulated failure");
  });

  it("scenarios cover key categories", () => {
    const categories = new Set(EVAL_SCENARIOS.map((s) => s.category));
    expect(categories.has("risk-gating")).toBe(true);
    expect(categories.has("dedup")).toBe(true);
    expect(categories.has("plan-gating")).toBe(true);
  });

  it("includes at least one critical-severity scenario", () => {
    const critical = EVAL_SCENARIOS.filter((s) => s.severity === "critical");
    expect(critical.length).toBeGreaterThan(0);
  });

  it("each scenario has a non-empty name and description", () => {
    for (const s of EVAL_SCENARIOS) {
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
    }
  });
});
