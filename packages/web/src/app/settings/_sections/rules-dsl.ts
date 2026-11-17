// Rules DSL editor (Settings → Lanes): the user's lane pins as text, from
// /api/email/rules/dsl/* (api routes/rules-dsl.ts, docs/design/rules-dsl.md).
// Pure helpers, so the panel stays declarative and the rules are testable.

import type { RulesDslErrorParams, RulesDslErrorWire } from "@klorn/contract";

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

/** The most params one error may carry, how many keys are looked at, and the longest text one may hold. */
const MAX_PARAMS = 12;
const MAX_SCANNED_PARAMS = 64;
const MAX_PARAM_CHARS = 200;
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

/**
 * The params of a server error: strings and finite numbers under plain names
 * (never one that shadows an Object.prototype member), nothing else, and only
 * the first few keys are even looked at. A param that is too long is dropped
 * whole rather than shown cut, so the message falls back to the server's
 * English text.
 */
function paramsFrom(value: unknown): RulesDslErrorParams | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const params: Record<string, string | number> = {};
  let scanned = 0;
  let kept = 0;
  for (const [name, raw] of Object.entries(value)) {
    scanned += 1;
    if (scanned > MAX_SCANNED_PARAMS || kept >= MAX_PARAMS) break;
    if (!PARAM_NAME.test(name) || name in Object.prototype) continue;
    if (typeof raw === "string" && raw.length <= MAX_PARAM_CHARS) params[name] = raw;
    else if (typeof raw === "number" && Number.isFinite(raw)) params[name] = raw;
    else continue;
    kept += 1;
  }
  return params;
}

function toWire(error: RulesDslErrorWire): RulesDslErrorWire {
  const { line, column, code, message } = error;
  const params = paramsFrom(error.params);
  return params ? { line, column, code, message, params } : { line, column, code, message };
}

/** The well-formed errors in a server body; anything else is dropped. */
export function dslErrorsFrom(body: unknown): RulesDslErrorWire[] {
  const errors = body && typeof body === "object" ? (body as { errors?: unknown }).errors : null;
  if (!Array.isArray(errors)) return [];
  return errors.filter(isErrorWire).slice(0, MAX_SHOWN_ERRORS).map(toWire);
}

/** `t` as the i18n provider hands it out. */
export type Translate = (key: string, vars?: Record<string, string>) => string;

const KEY_PREFIX = "rulesDsl.problem.";
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;
const VARIANT = /^[a-z][a-z-]{0,40}$/;

/** `rulesDsl.problem.<code>`, or `<code>.<variant>` for a code with several messages. */
function problemKey(error: RulesDslErrorWire): string {
  const variant = error.params?.variant;
  const id =
    typeof variant === "string" && VARIANT.test(variant) ? `${error.code}.${variant}` : error.code;
  return `${KEY_PREFIX}${id}`;
}

/** The table's text for `id`, or undefined when no locale (English included) has it. */
function templateFor(t: Translate, key: string): string | undefined {
  const text = t(key);
  return text === key || text === "" ? undefined : text;
}

/**
 * Fill `{name}` placeholders in one pass, so text that went in cannot expand
 * another placeholder (a sender's `{found}` stays literal). Undefined when a
 * placeholder has no value.
 */
function fill(template: string, vars: ReadonlyMap<string, string>): string | undefined {
  let complete = true;
  const text = template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = vars.get(name);
    if (value === undefined) complete = false;
    return value ?? "";
  });
  return complete ? text : undefined;
}

function expectedPhrase(params: RulesDslErrorParams, t: Translate): string | undefined {
  const { expectedKind, expectedWords } = params;
  if (expectedKind === "string") return templateFor(t, `${KEY_PREFIX}expect.string`);
  if (expectedKind === "lane") return templateFor(t, `${KEY_PREFIX}expect.lane`);
  if (expectedKind !== "word" || typeof expectedWords !== "string") return undefined;
  const words = expectedWords.split("|").map((word) => `"${word}"`);
  if (words.length === 1) return words[0];
  const either = templateFor(t, `${KEY_PREFIX}expect.either`);
  if (words.length !== 2 || either === undefined) return undefined;
  return fill(
    either,
    new Map([
      ["a", words[0] as string],
      ["b", words[1] as string],
    ]),
  );
}

function foundPhrase(params: RulesDslErrorParams, t: Translate): string | undefined {
  if (params.foundKind === "string") return templateFor(t, `${KEY_PREFIX}found.string`);
  return typeof params.found === "string" ? `"${params.found}"` : undefined;
}

function templateVars(params: RulesDslErrorParams, t: Translate): Map<string, string> {
  const vars = new Map(Object.entries(params).map(([name, value]) => [name, String(value)]));
  if (params.expectedKind !== undefined) {
    const expected = expectedPhrase(params, t);
    if (expected === undefined) vars.delete("expected");
    else vars.set("expected", expected);
  }
  if (params.foundKind !== undefined) {
    const found = foundPhrase(params, t);
    if (found === undefined) vars.delete("found");
    else vars.set("found", found);
  }
  return vars;
}

/**
 * One problem in the user's language: the `rulesDsl.problem.<id>` text with
 * the error's params slotted in. The server's English message stands in for a
 * code this build has no text for, for a server that sent no params, and for
 * a param the text needs but did not get. The result is a plain string: it is
 * rendered as a text node, so user text inside it can never become markup.
 */
export function dslErrorText(error: RulesDslErrorWire, t: Translate): string {
  const template = templateFor(t, problemKey(error));
  if (template === undefined) return error.message;
  const text = fill(template, templateVars(error.params ?? {}, t));
  return text === undefined || text === "" ? error.message : text;
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
