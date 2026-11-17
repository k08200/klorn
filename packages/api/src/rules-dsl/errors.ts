/**
 * Every problem the Rules DSL parser and compiler can report, in one place
 * (docs/design/rules-dsl.md §7). Each carries
 *
 *  - `code`    — stable; clients switch on it;
 *  - `message` — English, for API and CLI consumers and as the web's fallback;
 *  - `params`  — typed values the message is built from (the offending token
 *                cut to 40 characters, a limit, a line number), so the web can
 *                say it in the user's language without parsing English.
 *
 * Two codes cover several distinct messages (`unexpected-token`,
 * `string-too-long`); they carry a `variant` param. A message's id is
 * `code`, or `code.variant`, and the web's translation key is
 * `rulesDsl.problem.<id>` (packages/web/src/lib/locales/*).
 *
 * Pure: strings in, strings out.
 */

import { RULES_DSL_LIMITS } from "./limits.js";
import { quoteForMessage, truncateForMessage } from "./text.js";
import type { DslErrorCode, DslParams, DslProblem } from "./types.js";

/** Every message id the parser and compiler can emit (a test pins this to what they do emit). */
export const DSL_MESSAGE_IDS = [
  "missing-version",
  "unsupported-version",
  "unexpected-token.version-repeated",
  "unexpected-token.statement",
  "unexpected-token.expected-here",
  "unexpected-token.expected-found",
  "unexpected-token.extra",
  "unterminated-string",
  "bad-escape",
  "forbidden-character",
  "statement-outside-rule",
  "empty-rule-name",
  "duplicate-clause",
  "too-many-conditions",
  "missing-when",
  "missing-then",
  "unknown-lane",
  "retired-lane",
  "invalid-address",
  "invalid-domain",
  "public-domain",
  "duplicate-sender",
  "text-too-large",
  "too-many-rules",
  "string-too-long.name",
  "string-too-long.note",
  "string-too-long.sender",
  "string-too-long.sender-lowercased",
] as const;

export type DslMessageId = (typeof DSL_MESSAGE_IDS)[number];

/** The id of an error's message: its code, plus its variant when it has one. */
export function messageIdOf(error: {
  code: string;
  params?: { readonly variant?: unknown };
}): string {
  const variant = error.params?.variant;
  return typeof variant === "string" && variant !== "" ? `${error.code}.${variant}` : error.code;
}

export const LANE_LIST = "PUSH, MEETING, QUEUE, INFO or SILENT";
const STATEMENTS = "rule, when, then, note or disabled";

/** What the parser needs to know about a token to describe it. */
export interface TokenLike {
  kind: "word" | "string";
  text: string;
}

/** A token shape: a fixed word, one of several words, a string, or any word. */
export type Expect =
  | { word: string }
  | { oneOf: readonly string[] }
  | { string: true }
  | { anyWord: true };

function expected(want: Expect): string {
  if ("string" in want) return 'a "quoted" string';
  if ("word" in want) return `"${want.word}"`;
  if ("oneOf" in want) return want.oneOf.map((w) => `"${w}"`).join(" or ");
  return `a lane (${LANE_LIST})`;
}

/** A string token is "a string" (its text is never echoed); a word is quoted, cut. */
function describe(token: TokenLike): string {
  return token.kind === "string" ? "a string" : quoteForMessage(token.text);
}

function expectedParams(want: Expect): DslParams {
  if ("string" in want) return { expectedKind: "string" };
  if ("word" in want) return { expectedKind: "word", expectedWords: want.word };
  if ("oneOf" in want) return { expectedKind: "word", expectedWords: want.oneOf.join("|") };
  return { expectedKind: "lane" };
}

function foundParams(token: TokenLike): DslParams {
  return token.kind === "string"
    ? { foundKind: "string" }
    : { foundKind: "word", found: truncateForMessage(token.text) };
}

const problem = (code: DslErrorCode, message: string, params: DslParams = {}): DslProblem => ({
  code,
  message,
  params,
});

const unexpected = (message: string, variant: string, params: DslParams = {}) =>
  problem("unexpected-token", message, { variant, ...params });

type TooLongSubject = "name" | "note" | "sender" | "sender-lowercased";

const TOO_LONG: Record<TooLongSubject, { what: string; max: number; suffix: string }> = {
  name: { what: "A rule name", max: RULES_DSL_LIMITS.maxNameChars, suffix: "" },
  note: { what: "A note", max: RULES_DSL_LIMITS.maxNoteChars, suffix: "" },
  sender: { what: "A sender", max: RULES_DSL_LIMITS.maxValueChars, suffix: "" },
  "sender-lowercased": {
    what: "A sender",
    max: RULES_DSL_LIMITS.maxValueChars,
    suffix: " (counted lowercased)",
  },
};

export const problems = {
  missingVersion: () => problem("missing-version", "The first statement must be: version 1"),
  unsupportedVersion: (found: string) =>
    problem(
      "unsupported-version",
      `Unsupported version ${quoteForMessage(found)}. This Klorn reads version 1.`,
      { found: truncateForMessage(found) },
    ),
  versionRepeated: () => unexpected("version 1 may appear only once, first.", "version-repeated"),
  unknownStatement: (head: TokenLike) =>
    unexpected(
      `Unexpected ${describe(head)}. A line starts with ${STATEMENTS}.`,
      "statement",
      foundParams(head),
    ),
  expectedHere: (want: Expect) =>
    unexpected(`Expected ${expected(want)} here.`, "expected-here", expectedParams(want)),
  expectedFound: (want: Expect, got: TokenLike) =>
    unexpected(`Expected ${expected(want)}, found ${describe(got)}.`, "expected-found", {
      ...expectedParams(want),
      ...foundParams(got),
    }),
  extraToken: (extra: TokenLike) =>
    unexpected(`Unexpected ${describe(extra)} after the statement.`, "extra", foundParams(extra)),
  unterminatedString: () =>
    problem("unterminated-string", "This string has no closing quote on the same line."),
  badEscape: () => problem("bad-escape", 'Only \\" and \\\\ can be escaped inside a string.'),
  forbiddenCharacter: (hex: string) =>
    problem(
      "forbidden-character",
      `Invisible, control or text-direction character U+${hex} is not allowed.`,
      { codePoint: `U+${hex}` },
    ),
  statementOutsideRule: (keyword: string) =>
    problem(
      "statement-outside-rule",
      `"${keyword}" belongs inside a rule. Start one with: rule "name"`,
      { keyword },
    ),
  emptyRuleName: () => problem("empty-rule-name", "A rule needs a name."),
  duplicateClause: (keyword: string) =>
    problem("duplicate-clause", `This rule already has a "${keyword}" line.`, { keyword }),
  tooManyConditions: () =>
    problem(
      "too-many-conditions",
      "A rule has one sender condition. Write another rule for another sender.",
    ),
  missingWhen: () => problem("missing-when", 'This rule needs a sender: when from address "…"'),
  missingThen: () =>
    problem("missing-then", `This rule needs a lane: then lane PUSH (or ${LANE_LIST})`),
  unknownLane: (word: string) =>
    problem("unknown-lane", `Unknown lane ${quoteForMessage(word)}. Use ${LANE_LIST}.`, {
      token: truncateForMessage(word),
    }),
  retiredLane: (word: string) =>
    problem(
      "retired-lane",
      `${quoteForMessage(word)} is a retired value, not a lane. Use ${LANE_LIST}.`,
      { token: truncateForMessage(word) },
    ),
  invalidAddress: (value: string) =>
    problem("invalid-address", `${quoteForMessage(value)} is not a valid email address.`, {
      value: truncateForMessage(value),
    }),
  invalidDomain: (value: string) =>
    problem(
      "invalid-domain",
      `${quoteForMessage(value)} is not a valid domain. Write it like example.com.`,
      { value: truncateForMessage(value) },
    ),
  publicDomain: (value: string) =>
    problem(
      "public-domain",
      `${quoteForMessage(value)} is a public mailbox domain anyone can mail from. Write a rule for one address instead.`,
      { value: truncateForMessage(value) },
    ),
  duplicateSender: (firstLine: number) =>
    problem(
      "duplicate-sender",
      `The rule on line ${firstLine} already covers this sender. One rule per sender.`,
      { firstLine },
    ),
  textTooLarge: () => {
    const kib = RULES_DSL_LIMITS.maxTextBytes / 1024;
    return problem("text-too-large", `The rules text can be at most ${kib} KiB.`, {
      maxKib: kib,
    });
  },
  tooManyRules: () =>
    problem("too-many-rules", `At most ${RULES_DSL_LIMITS.maxRules} rules per file.`, {
      max: RULES_DSL_LIMITS.maxRules,
    }),
  stringTooLong: (subject: TooLongSubject) => {
    const { what, max, suffix } = TOO_LONG[subject];
    return problem("string-too-long", `${what} can be at most ${max} characters${suffix}.`, {
      variant: subject,
      max,
    });
  },
} as const;
