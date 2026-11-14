/**
 * Rules DSL v1 parser + compiler (src/rules-dsl, docs/design/rules-dsl.md):
 * every error carries a 1-based line:column and a code; lanes are the five
 * live ones only (AUTO and CALL are retired values, never targets); every
 * input limit refuses with its own code; quoted input is cut, never echoed
 * whole; and the module is pure (no db, no network, no fs).
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkRules, compileRules, parseRules, RULES_DSL_LIMITS } from "../rules-dsl/index.js";

const ok = (body: string) => `version 1\n${body}`;

function errorsOf(text: string) {
  const result = checkRules(text);
  if (result.ok) throw new Error("expected errors, got a valid rule set");
  return result.errors;
}

function firstError(text: string) {
  const errors = errorsOf(text);
  expect(errors.length).toBeGreaterThan(0);
  return errors[0];
}

describe("a valid file", () => {
  it("compiles one rule per block into a PIN_TIER row shape", () => {
    const result = checkRules(
      ok(
        [
          'rule "Investors always interrupt"',
          '  when from domain "SequoiaCap.com"',
          "  then lane PUSH",
          "",
          'rule "Old newsletter"',
          '  note "muted 2026-11"',
          '  when from address "News@Example.com"',
          "  then lane silent",
          "  disabled",
        ].join("\n"),
      ),
    );
    expect(result).toEqual({
      ok: true,
      rules: [
        {
          name: "Investors always interrupt",
          description: null,
          scope: "domain",
          value: "sequoiacap.com",
          lane: "PUSH",
          isActive: true,
        },
        {
          name: "Old newsletter",
          description: "muted 2026-11",
          scope: "sender",
          value: "news@example.com",
          lane: "SILENT",
          isActive: false,
        },
      ],
    });
  });

  it("accepts clauses in any order, indentation or none, comments and CRLF", () => {
    const text = [
      "# my rules",
      "  version 1   # header",
      'rule "a # not a comment"   # trailing comment',
      "then lane INFO",
      '\twhen from domain "@acme.io"',
      "",
    ].join("\r\n");
    const result = checkRules(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rules).toEqual([
      {
        name: "a # not a comment",
        description: null,
        scope: "domain",
        value: "acme.io",
        lane: "INFO",
        isActive: true,
      },
    ]);
  });

  it('unescapes \\" and \\\\ inside strings', () => {
    const result = checkRules(
      ok('rule "say \\"hi\\" \\\\ bye"\n when from address "a@b.co"\n then lane QUEUE'),
    );
    expect(result.ok && result.rules[0]?.name).toBe('say "hi" \\ bye');
  });

  it("treats an empty rule set as valid", () => {
    expect(checkRules("version 1\n")).toEqual({ ok: true, rules: [] });
    expect(checkRules("# nothing yet\nversion 1")).toEqual({ ok: true, rules: [] });
  });

  it("separates parse (AST) from compile (rows)", () => {
    const parsed = parseRules(ok('rule "x"\nwhen from address "A@B.co"\nthen lane MEETING'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.ast.rules[0]).toMatchObject({
      name: "x",
      line: 2,
      sender: { scope: "address", value: "A@B.co", line: 3 },
      target: { lane: "MEETING", line: 4 },
    });
    const compiled = compileRules(parsed.ast);
    expect(compiled.ok && compiled.rules[0]?.value).toBe("a@b.co");
  });
});

describe("errors carry line:column and a code", () => {
  it("needs the version header first", () => {
    expect(firstError('rule "x"\nwhen from address "a@b.co"\nthen lane PUSH')).toMatchObject({
      line: 1,
      column: 1,
      code: "missing-version",
    });
    expect(firstError("")).toMatchObject({ line: 1, column: 1, code: "missing-version" });
  });

  it("refuses another version", () => {
    expect(firstError("version 2\n")).toMatchObject({
      line: 1,
      column: 9,
      code: "unsupported-version",
    });
  });

  it("points at an unknown statement", () => {
    expect(firstError(ok('rule "x"\n  whenever from address "a@b.co"'))).toMatchObject({
      line: 3,
      column: 3,
      code: "unexpected-token",
    });
  });

  it("points at a stray token after a complete statement", () => {
    expect(
      firstError(ok('rule "x" extra\nwhen from address "a@b.co"\nthen lane PUSH')),
    ).toMatchObject({ line: 2, column: 10, code: "unexpected-token" });
  });

  it("points at an unterminated string", () => {
    expect(firstError(ok('rule "x\nwhen from address "a@b.co"\nthen lane PUSH'))).toMatchObject({
      line: 2,
      column: 6,
      code: "unterminated-string",
    });
  });

  it("points at an unknown escape", () => {
    expect(
      firstError(ok('rule "a\\nb"\nwhen from address "a@b.co"\nthen lane PUSH')),
    ).toMatchObject({ line: 2, column: 8, code: "bad-escape" });
  });

  it("refuses a clause before any rule", () => {
    expect(firstError(ok("then lane PUSH"))).toMatchObject({
      line: 2,
      column: 1,
      code: "statement-outside-rule",
    });
  });

  it("refuses a blank rule name", () => {
    expect(firstError(ok('rule "  "\nwhen from address "a@b.co"\nthen lane PUSH'))).toMatchObject({
      line: 2,
      column: 6,
      code: "empty-rule-name",
    });
  });

  it("needs a when and a then in every rule, reported at the rule", () => {
    const errors = errorsOf(ok('rule "a"\n\nrule "b"\n  when from address "b@b.co"'));
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ line: 2, column: 1, code: "missing-when" }),
        expect.objectContaining({ line: 2, column: 1, code: "missing-then" }),
        expect.objectContaining({ line: 4, column: 1, code: "missing-then" }),
      ]),
    );
  });

  it("refuses a repeated then, note or disabled", () => {
    const errors = errorsOf(
      ok(
        'rule "a"\nwhen from address "a@b.co"\nthen lane PUSH\nthen lane INFO\nnote "x"\nnote "y"\ndisabled\n  disabled',
      ),
    );
    expect(errors.map((e) => [e.line, e.column, e.code])).toEqual([
      [5, 1, "duplicate-clause"],
      [7, 1, "duplicate-clause"],
      [9, 3, "duplicate-clause"],
    ]);
  });

  it("refuses a second condition in one rule (max conditions per rule)", () => {
    expect(RULES_DSL_LIMITS.maxConditionsPerRule).toBe(1);
    expect(
      firstError(
        ok('rule "a"\nwhen from address "a@b.co"\nwhen from domain "b.co"\nthen lane PUSH'),
      ),
    ).toMatchObject({ line: 4, column: 1, code: "too-many-conditions" });
  });

  it("refuses a when that is not from address|domain", () => {
    expect(firstError(ok('rule "a"\nwhen subject "invoice"\nthen lane PUSH'))).toMatchObject({
      line: 3,
      column: 6,
      code: "unexpected-token",
    });
    expect(firstError(ok('rule "a"\nwhen from sender "a@b.co"\nthen lane PUSH'))).toMatchObject({
      line: 3,
      column: 11,
      code: "unexpected-token",
    });
  });

  it("returns every error in text order, and a broken clause does not also count as missing", () => {
    const errors = errorsOf(
      ok(
        'rule "b"\nwhen from x\nthen lane PUSH\nrule "a"\nwhen from address "a@b.co"\nthen lane NOPE\nbogus',
      ),
    );
    expect(errors.map((e) => [e.line, e.code])).toEqual([
      [3, "unexpected-token"],
      [7, "unknown-lane"],
      [8, "unexpected-token"],
    ]);
  });
});

describe("lanes: the five live ones only", () => {
  it.each([
    "PUSH",
    "MEETING",
    "QUEUE",
    "INFO",
    "SILENT",
    "push",
    "Silent",
  ])("accepts %s", (lane) => {
    expect(checkRules(ok(`rule "a"\nwhen from address "a@b.co"\nthen lane ${lane}`)).ok).toBe(true);
  });

  it.each([
    "AUTO",
    "auto",
    "CALL",
    "Call",
  ])("refuses the retired value %s with a helpful message", (lane) => {
    const error = firstError(ok(`rule "a"\nwhen from address "a@b.co"\nthen lane ${lane}`));
    expect(error).toMatchObject({ line: 4, column: 11, code: "retired-lane" });
    expect(error.message).toContain("PUSH, MEETING, QUEUE, INFO or SILENT");
    expect(error.message).toContain("retired");
  });

  it("refuses an unknown lane", () => {
    const error = firstError(ok('rule "a"\nwhen from address "a@b.co"\nthen lane URGENT'));
    expect(error).toMatchObject({ line: 4, column: 11, code: "unknown-lane" });
    expect(error.message).toContain('"URGENT"');
  });

  it("refuses a missing lane", () => {
    expect(firstError(ok('rule "a"\nwhen from address "a@b.co"\nthen lane'))).toMatchObject({
      line: 4,
      code: "unexpected-token",
    });
  });
});

describe("senders: the pin writers' own validation", () => {
  it("refuses a bad address and a bad domain", () => {
    expect(
      firstError(ok('rule "a"\nwhen from address "not-an-address"\nthen lane PUSH')),
    ).toMatchObject({ line: 3, column: 19, code: "invalid-address" });
    expect(firstError(ok('rule "a"\nwhen from domain "a@b.co"\nthen lane PUSH'))).toMatchObject({
      line: 3,
      column: 18,
      code: "invalid-domain",
    });
  });

  it("refuses a public mailbox domain and points to the address form", () => {
    const error = firstError(ok('rule "a"\nwhen from domain "gmail.com"\nthen lane PUSH'));
    expect(error).toMatchObject({ line: 3, column: 18, code: "public-domain" });
    expect(error.message).toContain("address");
  });

  it("allows one rule per sender, naming the earlier line", () => {
    const error = firstError(
      ok(
        'rule "a"\nwhen from address "A@b.co"\nthen lane PUSH\nrule "b"\nwhen from address "a@B.co"\nthen lane INFO',
      ),
    );
    expect(error).toMatchObject({ line: 6, column: 19, code: "duplicate-sender" });
    expect(error.message).toContain("line 2");
  });

  it("lets an address rule and a domain rule for the same domain coexist", () => {
    expect(
      checkRules(
        ok(
          'rule "a"\nwhen from address "ceo@b.co"\nthen lane PUSH\nrule "b"\nwhen from domain "b.co"\nthen lane INFO',
        ),
      ).ok,
    ).toBe(true);
  });
});

describe("limits", () => {
  it("refuses text over 64 KiB (UTF-8 bytes) before parsing", () => {
    expect(RULES_DSL_LIMITS.maxTextBytes).toBe(64 * 1024);
    const pad = "#".repeat(RULES_DSL_LIMITS.maxTextBytes);
    expect(errorsOf(`version 1\n${pad}`)).toEqual([
      expect.objectContaining({ line: 1, column: 1, code: "text-too-large" }),
    ]);
    // Multi-byte characters count as bytes, not characters.
    const korean = `version 1\n# ${"가".repeat(Math.ceil(RULES_DSL_LIMITS.maxTextBytes / 3))}`;
    expect(firstError(korean).code).toBe("text-too-large");
  });

  it("accepts text right at the limit", () => {
    const head = "version 1\n#";
    const text = head + "x".repeat(RULES_DSL_LIMITS.maxTextBytes - head.length);
    expect(checkRules(text)).toEqual({ ok: true, rules: [] });
  });

  it("refuses more than 500 rules, at the first one over", () => {
    expect(RULES_DSL_LIMITS.maxRules).toBe(500);
    const rule = (i: number) => `rule "r${i}"\nwhen from address "u${i}@b.co"\nthen lane PUSH`;
    const at = Array.from({ length: 500 }, (_, i) => rule(i)).join("\n");
    expect(checkRules(ok(at)).ok).toBe(true);
    const over = Array.from({ length: 501 }, (_, i) => rule(i)).join("\n");
    expect(errorsOf(ok(over))).toEqual([
      expect.objectContaining({ line: 2 + 500 * 3, column: 1, code: "too-many-rules" }),
    ]);
  });

  it("refuses a name over 120 characters", () => {
    expect(RULES_DSL_LIMITS.maxNameChars).toBe(120);
    const good = checkRules(
      ok(`rule "${"n".repeat(120)}"\nwhen from address "a@b.co"\nthen lane PUSH`),
    );
    expect(good.ok).toBe(true);
    expect(
      firstError(ok(`rule "${"n".repeat(121)}"\nwhen from address "a@b.co"\nthen lane PUSH`)),
    ).toMatchObject({ line: 2, column: 6, code: "string-too-long" });
  });

  it("refuses a note over 500 characters", () => {
    expect(RULES_DSL_LIMITS.maxNoteChars).toBe(500);
    expect(
      firstError(
        ok(`rule "a"\nnote "${"n".repeat(501)}"\nwhen from address "a@b.co"\nthen lane PUSH`),
      ),
    ).toMatchObject({ line: 3, column: 6, code: "string-too-long" });
  });

  it("refuses an address or domain over 254 characters", () => {
    expect(RULES_DSL_LIMITS.maxValueChars).toBe(254);
    const long = `${"a".repeat(250)}@b.co`;
    expect(firstError(ok(`rule "a"\nwhen from address "${long}"\nthen lane PUSH`))).toMatchObject({
      line: 3,
      column: 19,
      code: "string-too-long",
    });
  });

  it("caps the error list at 50 and says it did", () => {
    expect(RULES_DSL_LIMITS.maxErrors).toBe(50);
    const text = ok(Array.from({ length: 80 }, () => "bogus").join("\n"));
    const result = checkRules(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });
});

describe("hostile input", () => {
  it.each([
    ["NUL", "\u0000"],
    ["escape", "\u001b"],
    ["DEL", "\u007f"],
    ["RTL override", "‮"],
    ["LTR isolate", "⁦"],
    ["lone CR", "\r"],
  ])("refuses a %s character with its position", (_label, ch) => {
    const error = firstError(ok(`rule "a${ch}b"\nwhen from address "a@b.co"\nthen lane PUSH`));
    expect(error).toMatchObject({ line: 2, column: 8, code: "forbidden-character" });
  });

  it("never echoes more than 40 characters of user input in a message", () => {
    const junk = `${"x".repeat(5000)}`;
    for (const text of [
      ok(junk),
      ok(`rule "a"\nwhen from address "a@b.co"\nthen lane ${junk}`),
      ok(`rule "a"\nwhen from address "${"y".repeat(240)}"\nthen lane PUSH`),
    ]) {
      for (const error of errorsOf(text)) {
        expect(error.message.length).toBeLessThan(200);
        expect(error.message).not.toContain("x".repeat(41));
        expect(error.message).not.toContain("y".repeat(41));
      }
    }
  });

  it("parses a pathological line in linear time (no backtracking)", () => {
    // 60 KiB of quote/backslash soup on one line.
    const soup = `version 1\nrule "${'\\"'.repeat(15_000)}`;
    const started = process.cpuUsage();
    checkRules(soup);
    const { user, system } = process.cpuUsage(started);
    expect((user + system) / 1000).toBeLessThan(500);
  });
});

describe("the module stays pure", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, "..", "rules-dsl");
  it.each(readdirSync(dir).filter((f) => f.endsWith(".ts")))("%s imports no I/O", (file) => {
    const text = readFileSync(join(dir, file), "utf8");
    const imports = [...text.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
    for (const spec of imports) {
      expect(spec).not.toMatch(/db\.js|prisma|node:fs|node:net|node:http|fetch|sentry/);
    }
  });
});
