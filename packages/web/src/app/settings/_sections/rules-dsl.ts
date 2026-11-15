// Rules DSL editor (Settings → Lanes): the user's lane pins as text, from
// /api/email/rules/dsl/* (api routes/rules-dsl.ts, docs/design/rules-dsl.md).
// Pure helpers, so the panel stays declarative and the rules are testable.

import type { RulesDslErrorWire } from "@klorn/contract";

export const RULES_DSL_PATHS = {
  export: "/api/email/rules/dsl/export",
  validate: "/api/email/rules/dsl/validate",
  dryRun: "/api/email/rules/dsl/dry-run",
  apply: "/api/email/rules/dsl/apply",
} as const;

/** The most errors the panel lists (the server caps at the same number). */
const MAX_SHOWN_ERRORS = 50;

/** Shown only when the server opened the editor to this user (/me user.rulesDsl). */
export function rulesDslVisible(user: { rulesDsl?: boolean } | null | undefined): boolean {
  return user?.rulesDsl === true;
}

function isErrorWire(value: unknown): value is RulesDslErrorWire {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    Number.isInteger(e.line) &&
    Number.isInteger(e.column) &&
    typeof e.code === "string" &&
    typeof e.message === "string"
  );
}

/** The well-formed errors in a server body; anything else is dropped. */
export function dslErrorsFrom(body: unknown): RulesDslErrorWire[] {
  const errors = body && typeof body === "object" ? (body as { errors?: unknown }).errors : null;
  if (!Array.isArray(errors)) return [];
  return errors.filter(isErrorWire).slice(0, MAX_SHOWN_ERRORS);
}

/**
 * Caret offset of a 1-based line:column in `text`, clamped to the text and to
 * the line's end, so "go to error" can place the cursor in the textarea.
 */
export function offsetOfPosition(text: string, line: number, column: number): number {
  let start = 0;
  for (let current = 1; current < line; current++) {
    const next = text.indexOf("\n", start);
    if (next === -1) return text.length;
    start = next + 1;
  }
  const end = text.indexOf("\n", start);
  let lineEnd = end === -1 ? text.length : end;
  if (lineEnd > start && text[lineEnd - 1] === "\r") lineEnd -= 1;
  return Math.min(start + Math.max(0, column - 1), lineEnd);
}

/** The copy for a refused or failed request. */
export function dslFailureKey(status: number, body: unknown): string {
  const code = body && typeof body === "object" ? (body as { code?: unknown }).code : undefined;
  if (status === 409 || code === "rules-changed") return "rulesDsl.error.changed";
  if (status === 400) return "rulesDsl.error.invalid";
  if (status === 413) return "rulesDsl.error.tooLarge";
  if (status === 429) return "rulesDsl.error.rateLimited";
  if (status === 404) return "rulesDsl.error.unavailable";
  return "rulesDsl.error.failed";
}
