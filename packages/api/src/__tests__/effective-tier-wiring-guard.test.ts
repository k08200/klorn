/**
 * Every plan gate reads the effective plan (Klorn Teams v1.1, gap 1).
 *
 * A Klorn Teams seat is derived from membership at read time and never
 * written to User.plan, so a gate that reads User.plan directly silently
 * refuses a paying seat holder. This guard scans the API source and fails
 * when a gate helper is handed a raw `.plan`, when a raw plan is aliased with
 * a "FREE" fallback outside the resolver, or when a file calls a gate helper
 * without importing the resolver. The rare deliberate own-plan read carries
 * an `effective-tier: own plan` comment on the line above, with its reason; a
 * read of a value the resolver already produced carries `effective-tier:
 * resolved`, and a plan that is no gate input (a checkout's requested plan)
 * `effective-tier: not a gate`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..");

const GATE_HELPERS = [
  "isEntitled",
  "isHardPaywalled",
  "planHasFeature",
  "getEffectivePlan",
  "isToolAllowedForPlan",
  "getToolsForPlan",
  "scopeLinkedInboxes",
  "syncsEveryLinkedInbox",
  "buildMcpServer",
  "mcpToolDefs",
  "maybeNudgeFreeDailyLimit",
];

/**
 * Files that define a gate helper or only receive an already-resolved plan as
 * a parameter from their caller (or, for the agent eval, fixed literal plans).
 */
const PLAN_PARAMETER_ONLY = new Set([
  "billing/stripe.ts",
  "billing/mail-sync-scope.ts",
  "agentcore/tool-executor.ts",
  "agentcore/agent-eval.ts",
  "mcp/tool-gate.ts",
  "mcp/server.ts",
]);

/** Gate call sites the guard must see, so it can never pass vacuously. */
const SENTINEL_CALLERS = [
  "automation-scheduler.ts",
  "agentcore/autonomous-agent-scheduler.ts",
  "learning/pattern-learner.ts",
  "llm/llm-credentials.ts",
  "billing/cost-guard.ts",
  "routes/mcp.ts",
  "routes/auth.ts",
  "routes/billing.ts",
];

// A value import of the resolver, or of the pooled-cost module built on it
// (cost-guard.ts). `import type` does not count.
const RESOLVER_IMPORT =
  /import\s+\{[^}]*\}\s+from\s+"(?:\.\.?\/)+(?:org\/)?effective-tier\.js"|import\s+\{[^}]*\}\s+from\s+"\.\/team-cost-pool\.js"/;
const RESOLVER_CALL = /\beffective(?:Plans?|PlanOrOwn|PlansOrOwn|Tier|TierOrOwnPlan)\(/g;
const OWN_PLAN_MARKER = /effective-tier: (?:own plan|resolved|not a gate)/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "__tests__" || name === "__fixtures__" || name === "scripts") continue;
      out.push(...walk(path));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Comments blanked to spaces (offsets and newlines kept), so prose that names
 * a helper ("isEntitled() reads user.plan") is not mistaken for a call.
 */
function blankComments(text: string): string {
  const blank = (chunk: string) => chunk.replace(/[^\n]/g, " ");
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(
      /(^|[^:"'`\\])(\/\/[^\n]*)/gm,
      (_, lead: string, comment: string) => lead + blank(comment),
    );
}

const sources = walk(srcDir).map((path) =>
  source(relative(srcDir, path), readFileSync(path, "utf8")),
);

/** The text of a call's argument list (balanced parentheses), starting at `(`. */
function callArgs(text: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return text.slice(openParen + 1, i);
    }
  }
  return text.slice(openParen + 1);
}

function lineBefore(text: string, index: number): string {
  const lineStart = text.lastIndexOf("\n", index - 1);
  const prevStart = text.lastIndexOf("\n", lineStart - 1);
  return text.slice(prevStart + 1, lineStart);
}

const helperCall = new RegExp(`(?<![\\w.])(${GATE_HELPERS.join("|")})\\(`, "g");

function callsGateHelper(text: string): boolean {
  helperCall.lastIndex = 0;
  for (const match of text.matchAll(helperCall)) {
    const before = text.slice(Math.max(0, (match.index ?? 0) - 9), match.index);
    if (!/function\s*$/.test(before)) return true;
  }
  return /PLAN_FEATURES\[/.test(text);
}

interface Source {
  rel: string;
  raw: string;
  text: string;
}

function source(rel: string, raw: string): Source {
  return { rel, raw, text: blankComments(raw) };
}

/** Gate helpers handed a raw `.plan` (a nested resolver call is resolved). */
function rawPlanArguments({ rel, raw, text }: Source): string[] {
  const offenders: string[] = [];
  for (const match of text.matchAll(helperCall)) {
    const index = match.index ?? 0;
    const args = callArgs(text, index + (match[1]?.length ?? 0)).replace(
      /\beffective(?:Plans?|PlanOrOwn|PlansOrOwn|Tier|TierOrOwnPlan)\([^)]*\)/g,
      "RESOLVED",
    );
    if (/\.plan\b/.test(args) && !OWN_PLAN_MARKER.test(lineBefore(raw, index))) {
      offenders.push(`${rel}: ${match[1]}(${args.slice(0, 60)})`);
    }
  }
  for (const match of text.matchAll(/PLAN_FEATURES\[([^\]]*)\]/g)) {
    if (/\.plan\b/.test(match[1] ?? "")) offenders.push(`${rel}: PLAN_FEATURES[${match[1]}]`);
  }
  return offenders;
}

/** True when `index` sits inside the argument list of a resolver call. */
function insideResolverCall(text: string, index: number): boolean {
  let open = -1;
  for (const match of text.slice(0, index).matchAll(RESOLVER_CALL)) {
    open = (match.index ?? 0) + match[0].length - 1;
  }
  if (open < 0) return false;
  let depth = 0;
  for (let i = open; i < index; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
  }
  return depth > 0;
}

/**
 * Raw plans aliased in a gate-calling file outside a resolver call:
 * `x.plan || "FREE"`, `const p = x.plan;`, `const { plan } = x`.
 */
function rawPlanAliases({ rel, raw, text }: Source): string[] {
  if (rel === "org/effective-tier.ts" || !callsGateHelper(text)) return [];
  const patterns = [
    /\.plan\s*(?:\|\||\?\?)\s*"FREE"/g,
    /(?:const|let)\s+\w+\s*=\s*[\w?.]+\.plan\s*;/g,
    /(?:const|let)\s*\{[^}]*\bplan\b[^}]*\}\s*=/g,
  ];
  const offenders: string[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (insideResolverCall(text, index) || OWN_PLAN_MARKER.test(lineBefore(raw, index))) continue;
      const line = text.slice(text.lastIndexOf("\n", index) + 1, text.indexOf("\n", index));
      offenders.push(`${rel}: ${line.trim()}`);
    }
  }
  return offenders;
}

function missesResolverImport({ rel, text }: Source): boolean {
  return !PLAN_PARAMETER_ONLY.has(rel) && callsGateHelper(text) && !RESOLVER_IMPORT.test(text);
}

describe("the guard's detectors fire on known-bad code", () => {
  const bad = source(
    "probe.ts",
    [
      'import type { Tier } from "./org/effective-tier.js";',
      'import { isEntitled, planHasFeature } from "./billing/stripe.js";',
      "export function probe(user: { plan: string }, other: { plan: string }) {",
      '  const fallback = user.plan || "FREE";',
      "  const alias = other.plan;",
      "  const { plan } = user;",
      '  return isEntitled(user.plan) && planHasFeature(alias, "multi_account");',
      "}",
    ].join("\n"),
  );

  it("flags a raw plan handed to a gate helper", () => {
    expect(rawPlanArguments(bad)).toEqual(["probe.ts: isEntitled(user.plan)"]);
  });

  it("flags raw plan aliases outside a resolver call", () => {
    expect(rawPlanAliases(bad)).toHaveLength(3);
  });

  it("flags a type-only resolver import", () => {
    expect(missesResolverImport(bad)).toBe(true);
  });

  it("accepts a resolver call around the raw plan", () => {
    const good = source(
      "good.ts",
      [
        'import { effectivePlan } from "./org/effective-tier.js";',
        'import { isEntitled } from "./billing/stripe.js";',
        "export async function good(user: { id: string; plan: string | null }) {",
        '  const plan = await effectivePlan({ id: user.id, plan: user.plan ?? "FREE" });',
        "  return isEntitled(plan);",
        "}",
      ].join("\n"),
    );
    expect(rawPlanArguments(good)).toEqual([]);
    expect(rawPlanAliases(good)).toEqual([]);
    expect(missesResolverImport(good)).toBe(false);
  });
});

describe("plan gates read the effective plan", () => {
  it("finds the gate call sites, every sentinel among them", () => {
    const callers = sources
      .filter(({ rel, text }) => !PLAN_PARAMETER_ONLY.has(rel) && callsGateHelper(text))
      .map(({ rel }) => rel);
    expect(callers.length).toBeGreaterThanOrEqual(15);
    expect(callers).toEqual(expect.arrayContaining(SENTINEL_CALLERS));
  });

  it("never hands a gate helper a raw `.plan`", () => {
    expect(sources.flatMap(rawPlanArguments)).toEqual([]);
  });

  it("aliases a raw plan only inside a resolver call", () => {
    expect(sources.flatMap(rawPlanAliases)).toEqual([]);
  });

  it("imports the resolver wherever a gate helper is called", () => {
    expect(sources.filter(missesResolverImport).map(({ rel }) => rel)).toEqual([]);
  });

  it("keeps the lenient (...OrOwn) resolvers off access gates", () => {
    // They swallow a failed seat lookup; only non-gate paths may: the
    // schedulers, the /api/devices list and the billing display routes.
    const lenientCallers = new Set([
      "automation-scheduler.ts",
      "agentcore/autonomous-agent-scheduler.ts",
      "learning/pattern-learner.ts",
      "routes/devices.ts",
      "routes/billing.ts",
    ]);
    const users = sources
      .filter(
        ({ rel, text }) => rel !== "org/effective-tier.ts" && /\beffectivePlans?OrOwn\(/.test(text),
      )
      .map(({ rel }) => rel);
    expect(users.filter((rel) => !lenientCallers.has(rel))).toEqual([]);
  });
});
