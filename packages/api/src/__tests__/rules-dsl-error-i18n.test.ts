/**
 * Localized Rules DSL errors (docs/design/rules-dsl.md §7). The API keeps its
 * English `message` and adds a stable `code` plus typed `params`; the web
 * renders the problem from `rulesDsl.problem.*` keys in every shipped locale.
 *
 * This is the guard that keeps the two sides in step:
 *  - every message the parser or compiler can emit has a key in all 7 locales
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
import de from "../../../web/src/lib/locales/de";
import en from "../../../web/src/lib/locales/en";
import es from "../../../web/src/lib/locales/es";
import fr from "../../../web/src/lib/locales/fr";
import ja from "../../../web/src/lib/locales/ja";
import ko from "../../../web/src/lib/locales/ko";
import zh from "../../../web/src/lib/locales/zh";
import {
  checkRules,
  DSL_MESSAGE_IDS,
  type DslError,
  messageIdOf,
  RULES_DSL_LIMITS,
} from "../rules-dsl/index.js";

const TABLES: Record<string, Record<string, string>> = { en, ko, ja, zh, es, fr, de };
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
  "invisible character": 'version 1\nrule "a​b"',
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
    `when from address "${"İ".repeat(RULES_DSL_LIMITS.maxValueChars - 54)}"`,
    "then lane PUSH",
  ),
};

function errorsOf(text: string): DslError[] {
  const result = checkRules(text);
  if (result.ok) throw new Error("expected errors");
  return result.errors;
}

const allErrors = () => Object.values(CORPUS).flatMap(errorsOf);
const wire = (e: DslError) => ({ ...e });

describe("the message catalog", () => {
  it("is exactly the set of messages the parser and compiler emit", () => {
    const emitted = new Set(allErrors().map(messageIdOf));
    expect([...emitted].sort()).toEqual([...DSL_MESSAGE_IDS].sort());
  });

  it("gives every error a stable code, typed params and a variant only where needed", () => {
    for (const error of allErrors()) {
      expect(typeof error.code).toBe("string");
      expect(error.params).toBeTypeOf("object");
      for (const value of Object.values(error.params)) {
        expect(["string", "number"]).toContain(typeof value);
      }
    }
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
    expect(LOCALES).toHaveLength(7);
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

  it("falls back to the English table when a locale lacks a key", () => {
    const sparse = (key: string) => en[key] ?? key;
    const error = errorsOf(CORPUS["retired lane AUTO"] ?? "")[0] as DslError;
    expect(dslErrorText(wire(error), sparse)).toBe(error.message);
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
