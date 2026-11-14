/**
 * Rules DSL v1 compiler: AST → the PIN_TIER rows it stands for. Senders go
 * through the pin writers' own validator (mail/pin-validate.ts), so a rule
 * the DSL accepts is a pin every other path would accept too. Pure.
 */

import { validateTierPin } from "../mail/pin-validate.js";
import { RULES_DSL_LIMITS } from "./limits.js";
import { failure, parseRules } from "./parse.js";
import { quoteForMessage } from "./text.js";
import type {
  AstRule,
  CompiledRule,
  CompileResult,
  DslAst,
  DslError,
  DslErrorCode,
  DslFailure,
} from "./types.js";

/** Identity of a rule: its sender. One rule per sender in a file. */
export function senderKey(rule: Pick<CompiledRule, "scope" | "value">): string {
  return `${rule.scope}:${rule.value}`;
}

function senderError(rule: AstRule, code: string): { code: DslErrorCode; message: string } {
  const value = quoteForMessage(rule.sender.value);
  switch (code) {
    case "address":
      return { code: "invalid-address", message: `${value} is not a valid email address.` };
    case "too-long":
      return {
        code: "string-too-long",
        message: `A sender can be at most ${RULES_DSL_LIMITS.maxValueChars} characters (counted lowercased).`,
      };
    case "public-domain":
      return {
        code: "public-domain",
        message: `${value} is a public mailbox domain anyone can mail from. Write a rule for one address instead.`,
      };
    default:
      return {
        code: "invalid-domain",
        message: `${value} is not a valid domain. Write it like example.com.`,
      };
  }
}

function compileRule(rule: AstRule): CompiledRule | { code: DslErrorCode; message: string } {
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
      errors.push({
        ...at,
        code: "duplicate-sender",
        message: `The rule on line ${earlier} already covers this sender. One rule per sender.`,
      });
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
