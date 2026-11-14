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
 * resolved`.
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

// The resolver, or the pooled-cost module built on it (cost-guard.ts).
const RESOLVER_IMPORT =
  /from\s+"(?:\.\.?\/)+(?:org\/)?effective-tier\.js"|from\s+"\.\/team-cost-pool\.js"/;
const OWN_PLAN_MARKER = /effective-tier: (?:own plan|resolved)/;

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

const sources = walk(srcDir).map((path) => {
  const raw = readFileSync(path, "utf8");
  return { rel: relative(srcDir, path), raw, text: blankComments(raw) };
});

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

describe("plan gates read the effective plan", () => {
  it("finds the gate call sites (the guard cannot pass vacuously)", () => {
    const callers = sources.filter(
      ({ rel, text }) => !PLAN_PARAMETER_ONLY.has(rel) && callsGateHelper(text),
    );
    expect(callers.length).toBeGreaterThanOrEqual(15);
  });

  it("never hands a gate helper a raw `.plan`", () => {
    const offenders: string[] = [];
    for (const { rel, raw, text } of sources) {
      for (const match of text.matchAll(helperCall)) {
        const index = match.index ?? 0;
        // A resolver call nested in the arguments is the resolved plan.
        const args = callArgs(text, index + (match[1]?.length ?? 0)).replace(
          /\beffective(?:Plans?|Tier|TierOrOwnPlan)\([^)]*\)/g,
          "RESOLVED",
        );
        if (/\.plan\b/.test(args) && !OWN_PLAN_MARKER.test(lineBefore(raw, index))) {
          offenders.push(`${rel}: ${match[1]}(${args.slice(0, 60)})`);
        }
      }
      for (const match of text.matchAll(/PLAN_FEATURES\[([^\]]*)\]/g)) {
        if (/\.plan\b/.test(match[1] ?? "")) offenders.push(`${rel}: PLAN_FEATURES[${match[1]}]`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("aliases a raw plan with a FREE fallback only inside the resolver call", () => {
    const offenders: string[] = [];
    for (const { rel, raw, text } of sources) {
      if (rel === "org/effective-tier.ts" || !callsGateHelper(text)) continue;
      for (const match of text.matchAll(/\.plan\s*(?:\|\||\?\?)\s*"FREE"/g)) {
        const index = match.index ?? 0;
        const window = text.slice(Math.max(0, index - 160), index);
        const resolved = /effectivePlans?\(|effectiveTierOrOwnPlan\(|effectiveTier\(/.test(window);
        if (!resolved && !OWN_PLAN_MARKER.test(lineBefore(raw, index))) {
          const line = text.slice(text.lastIndexOf("\n", index) + 1, text.indexOf("\n", index));
          offenders.push(`${rel}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("imports the resolver wherever a gate helper is called", () => {
    const missing = sources
      .filter(({ rel, text }) => !PLAN_PARAMETER_ONLY.has(rel) && callsGateHelper(text))
      .filter(({ text }) => !RESOLVER_IMPORT.test(text))
      .map(({ rel }) => rel);
    expect(missing).toEqual([]);
  });
});
