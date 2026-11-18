/**
 * Localized Rules DSL errors (docs/design/rules-dsl.md §7). The API keeps its
 * English `message` and adds a stable `code` plus typed `params`; the web
 * renders the problem from `rulesDsl.problem.*` keys in every shipped locale.
 *
 * This is the guard that keeps the two sides in step:
 *  - every message the parser or compiler can emit has a key in all 3 locales
 *    (and no locale carries a stale one);
 *  - English from the key table reads exactly as the API's own message, so
 *    the table cannot drift from the source of truth;
 *  - no translation leaves a `{placeholder}` unfilled, and the lane errors
 *    list the five live lanes without ever offering AUTO or CALL;
 *  - an unknown code, or a missing param, falls back to the English message.
 */

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dslErrorText } from "../../../web/src/app/settings/_sections/rules-dsl";
import en from "../../../web/src/lib/locales/en";
import ko from "../../../web/src/lib/locales/ko";
import zh from "../../../web/src/lib/locales/zh";
import {
  checkRules,
  DSL_ERROR_CODES,
  DSL_MESSAGE_IDS,
  type DslError,
  messageIdOf,
  RULES_DSL_LIMITS,
} from "../rules-dsl/index.js";

const TABLES: Record<string, Record<string, string>> = { en, ko, zh };
const LOCALES = Object.keys(TABLES);
const PREFIX = "rulesDsl.problem.";
/** Short phrases the web slots into "Expected {expected}, found {found}". */
const PHRASE_IDS = ["expect.string", "expect.lane", "expect.either", "found.string"];
const LANES = ["PUSH", "MEETING", "QUEUE", "INFO", "SILENT"];

/** What `t` does in the app (i18n.tsx): the locale's key, else English, else the key. */
const translator = (locale: string) => (key: string) => TABLES[locale]?.[key] || en[key] || key;

const okRule = 'rule "a"\nwhen from address "a@b.co"\nthen lane PUSH';
const ruleWith = (...lines: string[]) => `version 1\nrule "a"\n${lines.join("\n")}`;
const manyRules = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `rule "r${i}"\nwhen from address "u${i}@b.co"\nthen lane PUSH`,
  ).join("\n");

/** One input per message the parser or compiler can produce. */
const CORPUS: Record<string, string> = {
  "empty file": "",
  "no version first": 'rule "a"',
  "wrong version": "version 2",
  "version twice": "version 1\nversion 1",
  "unknown statement": "version 1\nfoo",
  "statement that is a string": 'version 1\n"hello"',
  "missing token": "version 1\nrule",
  "missing token after when": 'version 1\nrule "a"\nwhen',
  "word where a string belongs": "version 1\nrule foo",
  "one of two words": 'version 1\nrule "a"\nwhen from foo "x@y.co"',
  "string where a lane belongs": ruleWith('when from address "a@b.co"', 'then lane "x"'),
  "extra word": ruleWith('when from address "a@b.co"', "then lane PUSH extra"),
  "extra string": ruleWith('when from address "a@b.co"', "then lane PUSH", 'disabled "x"'),
  "open string": 'version 1\nrule "abc',
  "bad escape": 'version 1\nrule "a\\nb"',
  "invisible character": 'version 1\nrule "a\u200bb"',
  "clause outside a rule": 'version 1\nwhen from address "a@b.co"',
  "blank name": 'version 1\nrule "  "\nwhen from address "a@b.co"\nthen lane PUSH',
  "repeated note": ruleWith('note "x"', 'note "y"'),
  "two senders": ruleWith('when from address "a@b.co"', 'when from address "c@d.co"'),
  "rule with nothing": 'version 1\nrule "a"\n',
  "unknown lane": ruleWith('when from address "a@b.co"', "then lane URGENT"),
  "retired lane AUTO": ruleWith('when from address "a@b.co"', "then lane AUTO"),
  "retired lane CALL": ruleWith('when from address "a@b.co"', "then lane call"),
  "bad address": ruleWith('when from address "nope"', "then lane PUSH"),
  "bad domain": ruleWith('when from domain "not a domain"', "then lane PUSH"),
  "public domain": ruleWith('when from domain "gmail.com"', "then lane PUSH"),
  "same sender twice": `version 1\n${okRule}\n${okRule}`,
  "text over 64 KiB": `version 1\n#${"x".repeat(RULES_DSL_LIMITS.maxTextBytes)}`,
  "501 rules": `version 1\n${manyRules(RULES_DSL_LIMITS.maxRules + 1)}`,
  "name too long": `version 1\nrule "${"n".repeat(RULES_DSL_LIMITS.maxNameChars + 1)}"`,
  "note too long": ruleWith(`note "${"n".repeat(RULES_DSL_LIMITS.maxNoteChars + 1)}"`),
  "sender too long": ruleWith(
    `when from address "${"a".repeat(RULES_DSL_LIMITS.maxValueChars + 1)}"`,
  ),
  "sender too long once lowercased": ruleWith(
    // "İ" lowercases to two UTF-16 units: under the limit as written, over it lowercased.
    `when from address "${"İ".repeat(Math.ceil(RULES_DSL_LIMITS.maxValueChars / 2) + 1)}"`,
    "then lane PUSH",
  ),
};

function errorsOf(text: string): DslError[] {
  const result = checkRules(text);
  if (result.ok) throw new Error("expected errors");
  return result.errors;
}

let cached: DslError[] | undefined;
const allErrors = (): DslError[] => {
  cached ??= Object.values(CORPUS).flatMap(errorsOf);
  return cached;
};
const wire = (e: DslError) => ({ ...e });

describe("the message catalog", () => {
  it("is exactly the set of messages the parser and compiler emit", () => {
    const emitted = new Set(allErrors().map(messageIdOf));
    expect([...emitted].sort()).toEqual([...DSL_MESSAGE_IDS].sort());
  });

  it("gives every error params of strings and numbers only", () => {
    for (const error of allErrors()) {
      expect(error.params).toBeTypeOf("object");
      for (const value of Object.values(error.params)) {
        expect(["string", "number"]).toContain(typeof value);
      }
    }
  });

  it("uses a variant exactly for the codes that stand for several messages", () => {
    const ids = DSL_MESSAGE_IDS.map((id) => id.split("."));
    const withVariant = new Set(ids.filter(([, variant]) => variant).map(([code]) => code));
    expect([...withVariant].sort()).toEqual(["string-too-long", "unexpected-token"]);
    for (const error of allErrors()) {
      expect(typeof error.params.variant === "string").toBe(withVariant.has(error.code));
    }
  });

  it("covers every code the parser can emit, and invents none", () => {
    const codes = new Set(DSL_MESSAGE_IDS.map((id) => id.split(".")[0]));
    expect([...codes].sort()).toEqual([...DSL_ERROR_CODES].sort());
  });

  it("keeps the English text, position and code of every error exactly as shipped", () => {
    const shipped = Object.fromEntries(
      Object.entries(CORPUS).map(([name, text]) => [
        name,
        errorsOf(text).map(({ line, column, code, message }) => [line, column, code, message]),
      ]),
    );
    expect(shipped).toMatchInlineSnapshot(`
      {
        "501 rules": [
          [
            1502,
            1,
            "too-many-rules",
            "At most 500 rules per file.",
          ],
        ],
        "bad address": [
          [
            3,
            19,
            "invalid-address",
            ""nope" is not a valid email address.",
          ],
        ],
        "bad domain": [
          [
            3,
            18,
            "invalid-domain",
            ""not a domain" is not a valid domain. Write it like example.com.",
          ],
        ],
        "bad escape": [
          [
            2,
            8,
            "bad-escape",
            "Only \\" and \\\\ can be escaped inside a string.",
          ],
        ],
        "blank name": [
          [
            2,
            6,
            "empty-rule-name",
            "A rule needs a name.",
          ],
        ],
        "clause outside a rule": [
          [
            2,
            1,
            "statement-outside-rule",
            ""when" belongs inside a rule. Start one with: rule "name"",
          ],
        ],
        "empty file": [
          [
            1,
            1,
            "missing-version",
            "The first statement must be: version 1",
          ],
        ],
        "extra string": [
          [
            5,
            10,
            "unexpected-token",
            "Unexpected a string after the statement.",
          ],
        ],
        "extra word": [
          [
            4,
            16,
            "unexpected-token",
            "Unexpected "extra" after the statement.",
          ],
        ],
        "invisible character": [
          [
            2,
            8,
            "forbidden-character",
            "Invisible, control or text-direction character U+200B is not allowed.",
          ],
        ],
        "missing token": [
          [
            2,
            6,
            "unexpected-token",
            "Expected a "quoted" string here.",
          ],
        ],
        "missing token after when": [
          [
            3,
            6,
            "unexpected-token",
            "Expected "from" here.",
          ],
        ],
        "name too long": [
          [
            2,
            6,
            "string-too-long",
            "A rule name can be at most 120 characters.",
          ],
        ],
        "no version first": [
          [
            1,
            1,
            "missing-version",
            "The first statement must be: version 1",
          ],
          [
            1,
            1,
            "missing-when",
            "This rule needs a sender: when from address "…"",
          ],
          [
            1,
            1,
            "missing-then",
            "This rule needs a lane: then lane PUSH (or PUSH, MEETING, QUEUE, INFO or SILENT)",
          ],
        ],
        "note too long": [
          [
            3,
            6,
            "string-too-long",
            "A note can be at most 500 characters.",
          ],
        ],
        "one of two words": [
          [
            3,
            11,
            "unexpected-token",
            "Expected "address" or "domain", found "foo".",
          ],
        ],
        "open string": [
          [
            2,
            6,
            "unterminated-string",
            "This string has no closing quote on the same line.",
          ],
        ],
        "public domain": [
          [
            3,
            18,
            "public-domain",
            ""gmail.com" is a public mailbox domain anyone can mail from. Write a rule for one address instead.",
          ],
        ],
        "repeated note": [
          [
            4,
            1,
            "duplicate-clause",
            "This rule already has a "note" line.",
          ],
        ],
        "retired lane AUTO": [
          [
            4,
            11,
            "retired-lane",
            ""AUTO" is a retired value, not a lane. Use PUSH, MEETING, QUEUE, INFO or SILENT.",
          ],
        ],
        "retired lane CALL": [
          [
            4,
            11,
            "retired-lane",
            ""call" is a retired value, not a lane. Use PUSH, MEETING, QUEUE, INFO or SILENT.",
          ],
        ],
        "rule with nothing": [
          [
            2,
            1,
            "missing-when",
            "This rule needs a sender: when from address "…"",
          ],
          [
            2,
            1,
            "missing-then",
            "This rule needs a lane: then lane PUSH (or PUSH, MEETING, QUEUE, INFO or SILENT)",
          ],
        ],
        "same sender twice": [
          [
            6,
            19,
            "duplicate-sender",
            "The rule on line 2 already covers this sender. One rule per sender.",
          ],
        ],
        "sender too long": [
          [
            3,
            19,
            "string-too-long",
            "A sender can be at most 254 characters.",
          ],
        ],
        "sender too long once lowercased": [
          [
            3,
            19,
            "string-too-long",
            "A sender can be at most 254 characters (counted lowercased).",
          ],
        ],
        "statement that is a string": [
          [
            2,
            1,
            "unexpected-token",
            "Unexpected a string. A line starts with rule, when, then, note or disabled.",
          ],
        ],
        "string where a lane belongs": [
          [
            4,
            11,
            "unexpected-token",
            "Expected a lane (PUSH, MEETING, QUEUE, INFO or SILENT), found a string.",
          ],
        ],
        "text over 64 KiB": [
          [
            1,
            1,
            "text-too-large",
            "The rules text can be at most 64 KiB.",
          ],
        ],
        "two senders": [
          [
            4,
            1,
            "too-many-conditions",
            "A rule has one sender condition. Write another rule for another sender.",
          ],
        ],
        "unknown lane": [
          [
            4,
            11,
            "unknown-lane",
            "Unknown lane "URGENT". Use PUSH, MEETING, QUEUE, INFO or SILENT.",
          ],
        ],
        "unknown statement": [
          [
            2,
            1,
            "unexpected-token",
            "Unexpected "foo". A line starts with rule, when, then, note or disabled.",
          ],
        ],
        "version twice": [
          [
            2,
            1,
            "unexpected-token",
            "version 1 may appear only once, first.",
          ],
        ],
        "word where a string belongs": [
          [
            2,
            6,
            "unexpected-token",
            "Expected a "quoted" string, found "foo".",
          ],
        ],
        "wrong version": [
          [
            1,
            9,
            "unsupported-version",
            "Unsupported version "2". This Klorn reads version 1.",
          ],
        ],
      }
    `);
  });
});

describe("locale tables", () => {
  it("cover every locale the web ships", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../web/src/lib/locales");
    const files = readdirSync(dir)
      .filter((f) => /^[a-z]{2}\.ts$/.test(f))
      .map((f) => f.slice(0, 2))
      .sort();
    expect(files).toEqual([...LOCALES].sort());
    expect(LOCALES).toHaveLength(3);
  });

  it.each(LOCALES)("%s has a key for every message and no stale ones", (locale) => {
    const keys = Object.keys(TABLES[locale] ?? {})
      .filter((k) => k.startsWith(PREFIX))
      .map((k) => k.slice(PREFIX.length))
      .sort();
    expect(keys).toEqual([...DSL_MESSAGE_IDS, ...PHRASE_IDS].sort());
    for (const id of keys) {
      expect(TABLES[locale]?.[PREFIX + id]?.trim(), `${locale} ${id}`).toBeTruthy();
    }
  });
});

describe("rendering every emitted error", () => {
  it.each(LOCALES)("%s leaves no placeholder unfilled", (locale) => {
    const t = translator(locale);
    for (const error of allErrors()) {
      const text = dslErrorText(wire(error), t);
      expect(text, `${locale} ${messageIdOf(error)}`).not.toMatch(/\{[A-Za-z]+\}/);
      expect(text.trim()).not.toBe("");
      expect(text).not.toContain(PREFIX);
      // A broken placeholder makes the web fall back to the server's English
      // message, which would satisfy every check above. Only English may read
      // as the message itself.
      if (locale !== "en") expect(text, `${locale} ${messageIdOf(error)}`).not.toBe(error.message);
    }
  });

  it.each(
    LOCALES.filter((l) => l !== "en"),
  )("%s keeps English's placeholders in every text", (locale) => {
    const placeholders = (text: string | undefined) =>
      [...(text ?? "").matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1]).sort();
    for (const id of [...DSL_MESSAGE_IDS, ...PHRASE_IDS]) {
      expect(placeholders(TABLES[locale]?.[PREFIX + id]), `${locale} ${id}`).toEqual(
        placeholders(en[PREFIX + id]),
      );
    }
  });

  it("reads in English exactly like the API's own message", () => {
    const t = translator("en");
    for (const error of allErrors()) {
      expect(dslErrorText(wire(error), t), messageIdOf(error)).toBe(error.message);
    }
  });

  it.each(LOCALES.filter((l) => l !== "en"))("%s actually translates", (locale) => {
    const t = translator(locale);
    const retired = errorsOf(CORPUS["retired lane AUTO"] ?? "")[0] as DslError;
    expect(dslErrorText(wire(retired), t)).not.toBe(retired.message);
  });

  it.each(LOCALES)("%s names the five lanes and never offers AUTO or CALL", (locale) => {
    const t = translator(locale);
    const laneErrors = allErrors().filter((e) =>
      ["unknown-lane", "retired-lane", "missing-then"].includes(e.code),
    );
    expect(laneErrors.length).toBeGreaterThan(2);
    for (const error of laneErrors) {
      const text = dslErrorText(wire(error), t);
      for (const lane of LANES) expect(text, `${locale} ${error.code}`).toContain(lane);
    }
    // The templates themselves: AUTO and CALL appear nowhere in them. (An error
    // quotes the user's own word, e.g. "AUTO", through {token}; that is the
    // input being refused, not a lane being offered.)
    for (const id of [...DSL_MESSAGE_IDS, ...PHRASE_IDS]) {
      expect(TABLES[locale]?.[PREFIX + id], `${locale} ${id}`).not.toMatch(/\b(AUTO|CALL)\b/i);
    }
  });

  it("says in every language that a retired lane name is retired, quoting the word", () => {
    const retired = errorsOf(CORPUS["retired lane AUTO"] ?? "")[0] as DslError;
    expect(retired.params).toMatchObject({ token: "AUTO" });
    for (const locale of LOCALES) {
      const text = dslErrorText(wire(retired), translator(locale));
      expect(text, locale).toContain('"AUTO"');
    }
  });

  it("slots the expected and found phrases into the sentence", () => {
    const error = errorsOf(CORPUS["one of two words"] ?? "")[0] as DslError;
    expect(error.params).toMatchObject({
      variant: "expected-found",
      expectedKind: "word",
      expectedWords: "address|domain",
      foundKind: "word",
      found: "foo",
    });
    for (const locale of LOCALES) {
      const text = dslErrorText(wire(error), translator(locale));
      expect(text, locale).toContain('"address"');
      expect(text, locale).toContain('"domain"');
      expect(text, locale).toContain('"foo"');
    }
  });
});

describe("fallbacks and escaping", () => {
  const t = translator("ko");

  it("shows the English message for a code this build does not know", () => {
    const text = dslErrorText(
      { line: 1, column: 1, code: "brand-new-code", message: "Something new.", params: { n: 1 } },
      t,
    );
    expect(text).toBe("Something new.");
  });

  it("shows the English message when a server that predates params sends none", () => {
    const error = errorsOf(CORPUS["unknown lane"] ?? "")[0] as DslError;
    const { params: _params, ...legacy } = error;
    expect(dslErrorText(legacy, t)).toBe(error.message);
  });

  it("shows the English message when a needed param is missing", () => {
    const text = dslErrorText(
      { line: 3, column: 5, code: "unknown-lane", message: "Unknown lane.", params: {} },
      t,
    );
    expect(text).toBe("Unknown lane.");
  });

  it("puts the user's text in as plain text: no markup is added, removed or interpreted", () => {
    const hostile = '<img src=x onerror="alert(1)">&amp;{token}$&';
    const text = dslErrorText(
      { line: 1, column: 1, code: "unknown-lane", message: "m", params: { token: hostile } },
      translator("en"),
    );
    expect(text).toBe(`Unknown lane "${hostile}". Use PUSH, MEETING, QUEUE, INFO or SILENT.`);
  });

  it("does not let one param's text expand another placeholder", () => {
    const text = dslErrorText(
      {
        line: 1,
        column: 1,
        code: "unexpected-token",
        message: "m",
        params: {
          variant: "expected-found",
          expectedKind: "string",
          foundKind: "word",
          found: "{expected}",
        },
      },
      translator("en"),
    );
    expect(text).toBe('Expected a "quoted" string, found "{expected}".');
  });
});
