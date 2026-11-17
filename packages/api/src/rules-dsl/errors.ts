/**
 * Every problem the Rules DSL parser and compiler can report, in one place
 * (docs/design/rules-dsl.md §7). Each carries
 *
 *  - `code`    — stable; clients switch on it;
 *  - `message` — English, for API consumers and as the web's fallback;
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
import { truncateForMessage } from "./text.js";
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

function expectedParams(want: Expect): DslParams {
  if ("string" in want) return { expectedKind: "string" };
  if ("word" in want) return { expectedKind: "word", expectedWords: want.word };
  if ("oneOf" in want) return { expectedKind: "word", expectedWords: want.oneOf.join("|") };
  return { expectedKind: "lane" };
}

/**
 * A token as the message names it and as `params` carries it. A string
 * token is just "a string" (its text is never echoed); a word is cut once
 * and quoted.
 */
function found(token: TokenLike): { phrase: string; params: DslParams } {
  if (token.kind === "string") return { phrase: "a string", params: { foundKind: "string" } };
  const cut = truncateForMessage(token.text);
  return { phrase: `"${cut}"`, params: { foundKind: "word", found: cut } };
}

/**
 * The only way to build a problem: from a listed message id. The id fixes the
 * `code` and, after a dot, the `variant`, so a message that is not in
 * DSL_MESSAGE_IDS (and so has no translation to check) does not compile.
 */
function problem(id: DslMessageId, message: string, params: DslParams = {}): DslProblem {
  const [code, variant] = id.split(".") as [DslErrorCode, string | undefined];
  return { code, message, params: variant === undefined ? params : { variant, ...params } };
}

type UnexpectedVariant =
  Extract<DslMessageId, `unexpected-token.${string}`> extends `unexpected-token.${infer V}`
    ? V
    : never;

const unexpected = (variant: UnexpectedVariant, message: string, params: DslParams = {}) =>
  problem(`unexpected-token.${variant}`, message, params);

type TooLongSubject =
  Extract<DslMessageId, `string-too-long.${string}`> extends `string-too-long.${infer S}`
    ? S
    : never;

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
  unsupportedVersion: (word: string) => {
    const cut = truncateForMessage(word);
    return problem(
      "unsupported-version",
      `Unsupported version "${cut}". This Klorn reads version 1.`,
      { found: cut },
    );
  },
  versionRepeated: () => unexpected("version-repeated", "version 1 may appear only once, first."),
  unknownStatement: (head: TokenLike) => {
    const { phrase, params } = found(head);
    return unexpected(
      "statement",
      `Unexpected ${phrase}. A line starts with ${STATEMENTS}.`,
      params,
    );
  },
  expectedHere: (want: Expect) =>
    unexpected("expected-here", `Expected ${expected(want)} here.`, expectedParams(want)),
  expectedFound: (want: Expect, got: TokenLike) => {
    const { phrase, params } = found(got);
    return unexpected("expected-found", `Expected ${expected(want)}, found ${phrase}.`, {
      ...expectedParams(want),
      ...params,
    });
  },
  extraToken: (extra: TokenLike) => {
    const { phrase, params } = found(extra);
    return unexpected("extra", `Unexpected ${phrase} after the statement.`, params);
  },
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
  unknownLane: (word: string) => {
    const token = truncateForMessage(word);
    return problem("unknown-lane", `Unknown lane "${token}". Use ${LANE_LIST}.`, { token });
  },
  retiredLane: (word: string) => {
    const token = truncateForMessage(word);
    return problem("retired-lane", `"${token}" is a retired value, not a lane. Use ${LANE_LIST}.`, {
      token,
    });
  },
  invalidAddress: (raw: string) => {
    const value = truncateForMessage(raw);
    return problem("invalid-address", `"${value}" is not a valid email address.`, { value });
  },
  invalidDomain: (raw: string) => {
    const value = truncateForMessage(raw);
    return problem(
      "invalid-domain",
      `"${value}" is not a valid domain. Write it like example.com.`,
      { value },
    );
  },
  publicDomain: (raw: string) => {
    const value = truncateForMessage(raw);
    return problem(
      "public-domain",
      `"${value}" is a public mailbox domain anyone can mail from. Write a rule for one address instead.`,
      { value },
    );
  },
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
    return problem(
      `string-too-long.${subject}`,
      `${what} can be at most ${max} characters${suffix}.`,
      { max },
    );
  },
} as const;
