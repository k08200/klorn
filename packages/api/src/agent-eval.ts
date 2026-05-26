/**
 * Agent Evaluation Harness — Scenario-based regression tests for Eve's
 * autonomous agent decision logic.
 *
 * Tests focus on the logic that doesn't require LLM calls:
 * - Tool risk classification (LOW/MEDIUM/HIGH)
 * - Duplicate notification detection (fuzzy key matching)
 * - Tool gating by user plan
 *
 * These scenarios codify correct behavior so future refactors don't
 * regress on: duplicate alerts, over-proposing, risky tool auto-execution,
 * and missing approval gates.
 */

import { getNotifKey, getToolRisk, type RiskLevel } from "./agent-logic.js";
import { planHasFeature, TOOL_FEATURE_MAP } from "./stripe.js";

function isToolAllowedForPlan(toolName: string, plan: string): boolean {
  const featureKey = TOOL_FEATURE_MAP[toolName];
  if (!featureKey) return true;
  return planHasFeature(plan, featureKey);
}

export type Severity = "critical" | "high" | "medium" | "low";

export interface EvalScenario {
  id: string;
  name: string;
  description: string;
  severity: Severity;
  /** Category: what type of behavior this scenario guards */
  category: "risk-gating" | "dedup" | "plan-gating" | "notification";
  /** Run the assertion — returns null on pass, error message on fail */
  run(): string | null;
}

export interface EvalResult {
  scenario: EvalScenario;
  passed: boolean;
  message: string | null;
}

// ── Scenario 1: HIGH-risk destructive tools must never be LOW ────────────────
function scenarioHighRiskDeletesGated(): EvalScenario {
  return {
    id: "risk-01",
    name: "Destructive tools require explicit confirmation",
    description:
      "delete_email, archive_email, delete_event must all be HIGH risk so AUTO mode never runs them silently.",
    severity: "critical",
    category: "risk-gating",
    run() {
      const destructive = ["delete_email", "archive_email", "delete_event"];
      const offenders = destructive.filter((tool) => {
        const risk = getToolRisk(tool);
        return risk !== "HIGH";
      });
      if (offenders.length > 0) {
        return `Destructive tools not HIGH risk: ${offenders.join(", ")}`;
      }
      return null;
    },
  };
}

// ── Scenario 2: External-facing writes must be MEDIUM or HIGH ────────────────
function scenarioExternalWritesGated(): EvalScenario {
  return {
    id: "risk-02",
    name: "External-facing writes require approval",
    description:
      "send_email and create_event must never be LOW risk — they produce user-visible side effects.",
    severity: "critical",
    category: "risk-gating",
    run() {
      const externalTools = ["send_email", "create_event"];
      const lowRisk = externalTools.filter((t) => getToolRisk(t) === "LOW");
      if (lowRisk.length > 0) {
        return `External-facing tools marked LOW risk: ${lowRisk.join(", ")}`;
      }
      return null;
    },
  };
}

// ── Scenario 3: Skill execution must be LOW risk ─────────────────────────────
function scenarioSkillsAreLowRisk(): EvalScenario {
  return {
    id: "risk-03",
    name: "Skill tools are LOW risk",
    description:
      "execute_skill and list_skills are prompt-template operations with no side effects.",
    severity: "medium",
    category: "risk-gating",
    run() {
      const tools: Array<[string, RiskLevel]> = [
        ["execute_skill", "LOW"],
        ["list_skills", "LOW"],
      ];
      for (const [tool, expected] of tools) {
        const actual = getToolRisk(tool);
        if (actual !== expected) {
          return `${tool}: expected ${expected}, got ${actual ?? "undefined"}`;
        }
      }
      return null;
    },
  };
}

// ── Scenario 4: Notification dedup catches fuzzy title variations ────────────
function scenarioNotifDedupFuzzyMatching(): EvalScenario {
  return {
    id: "dedup-01",
    name: "Fuzzy notification dedup catches near-duplicates",
    description:
      "Two notifications with similar titles (different punctuation, case, trailing words) should normalize to the same key.",
    severity: "high",
    category: "dedup",
    run() {
      const pairs: Array<[string, string]> = [
        ["스크럼 장소 확인", "스크럼 장소 확인!"],
        ["Meeting at 3pm", "Meeting at 3pm "],
        ["Urgent: Reply needed", "URGENT: Reply Needed"],
      ];
      for (const [a, b] of pairs) {
        if (getNotifKey(a) !== getNotifKey(b)) {
          return `Failed to dedup "${a}" vs "${b}" — keys: "${getNotifKey(a)}" vs "${getNotifKey(b)}"`;
        }
      }
      return null;
    },
  };
}

// ── Scenario 5: Notification dedup distinguishes different messages ──────────
function scenarioNotifDedupDistinguishesDifferent(): EvalScenario {
  return {
    id: "dedup-02",
    name: "Dedup does not collapse genuinely different notifications",
    description:
      "Two unrelated notifications must produce different keys so Eve doesn't miss real alerts.",
    severity: "high",
    category: "dedup",
    run() {
      const pairs: Array<[string, string]> = [
        ["Meeting at 3pm", "Meeting at 5pm"],
        ["Reply to Alice", "Reply to Bob"],
        ["Task overdue: Design review", "Task overdue: Deployment"],
      ];
      for (const [a, b] of pairs) {
        if (getNotifKey(a) === getNotifKey(b)) {
          return `Incorrectly deduped "${a}" vs "${b}" — both produced "${getNotifKey(a)}"`;
        }
      }
      return null;
    },
  };
}

// ── Scenario 6: Plan gating — FREE plan can create events, but not destructive writes ───────
function scenarioFreePlanGated(): EvalScenario {
  return {
    id: "plan-01",
    name: "FREE plan users can create approved events, but cannot execute irreversible writes",
    description:
      "FREE plan supports the beta wedge of approved calendar creation, but send_email and " +
      "delete_event must remain gated. Note: FREE plan retains email_read + calendar_read access.",
    severity: "high",
    category: "plan-gating",
    run() {
      if (!isToolAllowedForPlan("create_event", "FREE")) {
        return `Approved calendar creation should be available on FREE plan`;
      }
      const gatedTools = ["send_email", "delete_event"];
      for (const tool of gatedTools) {
        if (isToolAllowedForPlan(tool, "FREE")) {
          return `Irreversible tool "${tool}" incorrectly allowed on FREE plan`;
        }
      }
      return null;
    },
  };
}

// ── Scenario 7: Plan gating — PRO plan can access core premium tools ─────────
function scenarioProPlanAccess(): EvalScenario {
  return {
    id: "plan-02",
    name: "PRO plan unlocks Gmail and Calendar tools",
    description: "PRO users must have access to email and calendar tools after upgrading.",
    severity: "medium",
    category: "plan-gating",
    run() {
      const proTools = ["list_emails", "list_events"];
      for (const tool of proTools) {
        if (!isToolAllowedForPlan(tool, "PRO")) {
          return `Tool "${tool}" incorrectly gated on PRO plan`;
        }
      }
      return null;
    },
  };
}

// ── Scenario 8: Notification key is bounded in length ────────────────────────
function scenarioNotifKeyLength(): EvalScenario {
  return {
    id: "dedup-03",
    name: "Notification key respects length limit",
    description:
      "Very long titles must not blow up the key — keep to a fixed prefix so DB lookups stay fast.",
    severity: "low",
    category: "notification",
    run() {
      const longTitle = "a".repeat(500);
      const key = getNotifKey(longTitle);
      if (key.length > 30) {
        return `Notification key exceeds 30 chars: ${key.length}`;
      }
      return null;
    },
  };
}

/** All scenarios — add new cases here to grow the regression suite. */
export const EVAL_SCENARIOS: EvalScenario[] = [
  scenarioHighRiskDeletesGated(),
  scenarioExternalWritesGated(),
  scenarioSkillsAreLowRisk(),
  scenarioNotifDedupFuzzyMatching(),
  scenarioNotifDedupDistinguishesDifferent(),
  scenarioFreePlanGated(),
  scenarioProPlanAccess(),
  scenarioNotifKeyLength(),
];

/** Run all scenarios and return detailed results */
export function runAllScenarios(): EvalResult[] {
  return EVAL_SCENARIOS.map((scenario) => {
    try {
      const message = scenario.run();
      return { scenario, passed: message === null, message };
    } catch (err) {
      return {
        scenario,
        passed: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

/** Summary of eval run for the ops dashboard */
export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  failures: Array<{ id: string; name: string; severity: Severity; message: string }>;
}

export function summarizeEval(results: EvalResult[]): EvalSummary {
  const failures = results
    .filter((r) => !r.passed)
    .map((r) => ({
      id: r.scenario.id,
      name: r.scenario.name,
      severity: r.scenario.severity,
      message: r.message ?? "Unknown failure",
    }));
  return {
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: failures.length,
    passRate: results.length > 0 ? results.filter((r) => r.passed).length / results.length : 0,
    failures,
  };
}
