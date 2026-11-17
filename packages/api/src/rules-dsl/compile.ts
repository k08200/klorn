/**
 * Rules DSL v1 compiler: AST → the PIN_TIER rows it stands for. Senders go
 * through the pin writers' own validator (mail/pin-validate.ts), so a rule
 * the DSL accepts is a pin every other path would accept too. Pure.
 */

import { validateTierPin } from "../mail/pin-validate.js";
import { problems } from "./errors.js";
import { RULES_DSL_LIMITS } from "./limits.js";
import { failure, parseRules } from "./parse.js";
import type {
  AstRule,
  CompiledRule,
  CompileResult,
  DslAst,
  DslError,
  DslFailure,
  DslProblem,
} from "./types.js";

/** Identity of a rule: its sender. One rule per sender in a file. */
export function senderKey(rule: Pick<CompiledRule, "scope" | "value">): string {
  return `${rule.scope}:${rule.value}`;
}

function senderError(rule: AstRule, code: string): DslProblem {
  const value = rule.sender.value;
  switch (code) {
    case "address":
      return problems.invalidAddress(value);
    case "too-long":
      return problems.stringTooLong("sender-lowercased");
    case "public-domain":
      return problems.publicDomain(value);
    default:
      return problems.invalidDomain(value);
  }
}

function compileRule(rule: AstRule): CompiledRule | DslProblem {
  const validated = validateTierPin({
    scope: rule.sender.scope === "address" ? "sender" : "domain",
    value: rule.sender.value,
    tier: rule.target.lane,
  });
  if ("error" in validated) return senderError(rule, validated.code);
  return {
    name: rule.name,
    description: rule.note,
    scope: validated.ok.scope,
    value: validated.ok.value,
    lane: rule.target.lane,
    isActive: !rule.disabled,
  };
}

export function compileRules(ast: DslAst): CompileResult {
  const errors: DslError[] = [];
  const rules: CompiledRule[] = [];
  const firstLine = new Map<string, number>();
  for (const rule of ast.rules) {
    // Past the cap nothing more is reported, so stop working.
    if (errors.length > RULES_DSL_LIMITS.maxErrors) break;
    const compiled = compileRule(rule);
    const at = { line: rule.sender.line, column: rule.sender.valueColumn };
    if ("code" in compiled) {
      errors.push({ ...at, ...compiled });
      continue;
    }
    const key = senderKey(compiled);
    const earlier = firstLine.get(key);
    if (earlier !== undefined) {
      errors.push({ ...at, ...problems.duplicateSender(earlier) });
      continue;
    }
    firstLine.set(key, rule.line);
    rules.push(compiled);
  }
  return errors.length > 0 ? failure(errors) : { ok: true, rules };
}

/** parse + compile: the text's rules, or every error in it. */
export function checkRules(text: string): CompileResult | DslFailure {
  const parsed = parseRules(text);
  return parsed.ok ? compileRules(parsed.ast) : parsed;
}
