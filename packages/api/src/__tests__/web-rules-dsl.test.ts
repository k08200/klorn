/**
 * Web side of the Rules DSL editor (settings/_sections/rules-dsl.ts): shown
 * only when the server opened it to this user, server errors read safely,
 * an error's line:column mapped to a caret offset, and each refusal mapped
 * to its copy.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  dslErrorsFrom,
  dslFailureKey,
  offsetOfPosition,
  RULES_DSL_PATHS,
  rulesDslVisible,
} from "../../../web/src/app/settings/_sections/rules-dsl";

describe("rulesDslVisible", () => {
  it("is true only when /me says the editor is open to this user", () => {
    expect(rulesDslVisible({ rulesDsl: true })).toBe(true);
    expect(rulesDslVisible({ rulesDsl: false })).toBe(false);
    expect(rulesDslVisible({})).toBe(false);
    expect(rulesDslVisible(null)).toBe(false);
  });
});

describe("RULES_DSL_PATHS", () => {
  it("names the four API routes", () => {
    expect(RULES_DSL_PATHS).toEqual({
      export: "/api/email/rules/dsl/export",
      validate: "/api/email/rules/dsl/validate",
      dryRun: "/api/email/rules/dsl/dry-run",
      apply: "/api/email/rules/dsl/apply",
    });
  });
});

describe("dslErrorsFrom", () => {
  it("keeps well-formed errors and drops anything else", () => {
    expect(
      dslErrorsFrom({
        errors: [
          { line: 2, column: 3, code: "unknown-lane", message: "Unknown lane" },
          { line: "2", column: 3, code: "x", message: "bad line type" },
          null,
          "junk",
        ],
      }),
    ).toEqual([{ line: 2, column: 3, code: "unknown-lane", message: "Unknown lane" }]);
    expect(dslErrorsFrom(null)).toEqual([]);
    expect(dslErrorsFrom({ errors: "nope" })).toEqual([]);
  });

  it("caps the list it renders", () => {
    const errors = Array.from({ length: 200 }, (_, i) => ({
      line: i + 1,
      column: 1,
      code: "x",
      message: "m",
    }));
    expect(dslErrorsFrom({ errors })).toHaveLength(50);
  });
});

describe("dslErrorsFrom params", () => {
  const base = { line: 2, column: 3, code: "unknown-lane", message: "Unknown lane" };

  it("keeps string and number params, which the localized message is built from", () => {
    const [error] = dslErrorsFrom({
      errors: [{ ...base, params: { token: "URGENT", max: 120, variant: "name" } }],
    });
    expect(error?.params).toEqual({ token: "URGENT", max: 120, variant: "name" });
  });

  it("drops params of any other type or an unsafe name, but keeps the error", () => {
    // JSON.parse, so "__proto__" is a real own key, as it would be off the wire.
    const params = JSON.parse(
      '{"ok":"yes","nested":{"a":1},"list":["x"],"flag":true,"nothing":null,"bad-name":"x","__proto__":"x","infinite":1e999}',
    );
    const [error] = dslErrorsFrom({ errors: [{ ...base, params }] });
    expect(error).toMatchObject({ line: 2, column: 3, code: "unknown-lane" });
    expect(error?.params).toEqual({ ok: "yes" });
  });

  it("ignores a params value that is not an object", () => {
    for (const params of ["x", 5, null, ["a"]]) {
      const [error] = dslErrorsFrom({ errors: [{ ...base, params }] });
      expect(error).toEqual(base);
    }
  });

  it("bounds how many params and how much text one error can carry", () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p${i}`, "x"]));
    const [error] = dslErrorsFrom({
      errors: [{ ...base, params: { ...many, long: "y".repeat(5000) } }],
    });
    expect(Object.keys(error?.params ?? {}).length).toBeLessThanOrEqual(12);
    // A param that is too long is dropped whole, never shown cut: the message
    // then falls back to the server's English text.
    const [long] = dslErrorsFrom({
      errors: [{ ...base, params: { long: "y".repeat(5000), ok: "z" } }],
    });
    expect(long?.params).toEqual({ ok: "z" });
  });
});

describe("the editor renders problems as text", () => {
  const panel = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../web/src/app/settings/_sections/rules-dsl-panel.tsx",
    ),
    "utf8",
  );

  it("shows the localized problem, not the server's English message", () => {
    expect(panel).toContain("dslErrorText(error, t)");
    expect(panel).not.toMatch(/\{error\.message\}/);
  });

  it("never injects markup: no innerHTML anywhere in the editor", () => {
    expect(panel).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
  });
});

describe("offsetOfPosition", () => {
  const text = 'version 1\nrule "a"\r\n  then lane X';
  it("maps a 1-based line:column to a caret offset", () => {
    expect(offsetOfPosition(text, 1, 1)).toBe(0);
    expect(offsetOfPosition(text, 2, 6)).toBe(15);
    expect(offsetOfPosition(text, 3, 3)).toBe(text.indexOf("then"));
  });

  it("clamps positions outside the text", () => {
    expect(offsetOfPosition(text, 99, 1)).toBe(text.length);
    expect(offsetOfPosition(text, 1, 999)).toBe(9);
    expect(offsetOfPosition(text, 0, 0)).toBe(0);
  });
});

describe("dslFailureKey", () => {
  it("maps each refusal to its copy", () => {
    expect(dslFailureKey(409, { code: "rules-changed" })).toBe("rulesDsl.error.changed");
    expect(dslFailureKey(400, { code: "invalid-rules" })).toBe("rulesDsl.error.invalid");
    expect(dslFailureKey(429, {})).toBe("rulesDsl.error.rateLimited");
    expect(dslFailureKey(404, {})).toBe("rulesDsl.error.unavailable");
    expect(dslFailureKey(413, {})).toBe("rulesDsl.error.tooLarge");
    expect(dslFailureKey(500, {})).toBe("rulesDsl.error.failed");
  });
});
