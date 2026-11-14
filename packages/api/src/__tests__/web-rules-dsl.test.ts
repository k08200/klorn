/**
 * Web side of the Rules DSL editor (settings/_sections/rules-dsl.ts): shown
 * only when the server opened it to this user, server errors read safely,
 * an error's line:column mapped to a caret offset, and each refusal mapped
 * to its copy.
 */

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
