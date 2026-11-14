/**
 * Rules DSL v1 round trip (docs/design/rules-dsl.md §9): the serializer is
 * canonical and stable — serialize(compile(parse(serialize(x)))) is
 * serialize(x) — checked on golden files and on seeded random rule sets that
 * lean on the awkward cases (quotes, backslashes, #, tabs, Korean, disabled,
 * empty notes).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildInventory,
  type CompiledRule,
  checkRules,
  exportText,
  type StoredEmailRule,
  type StoredLearnedRule,
  serializeRules,
} from "../rules-dsl/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, "fixtures", "rules-dsl", name), "utf8");

let seq = 0;
function stored(partial: Partial<StoredEmailRule>): StoredEmailRule {
  seq += 1;
  return {
    id: `rule-${seq}`,
    name: `rule ${seq}`,
    description: null,
    isActive: true,
    conditions: {},
    actionType: "PIN_TIER",
    actionValue: "QUEUE",
    updatedAt: new Date(Date.UTC(2026, 10, 1, 0, seq)),
    ...partial,
  };
}

function mixedInventory() {
  const rules: StoredEmailRule[] = [
    stored({
      name: "Investors always interrupt",
      conditions: { fromDomain: ["SequoiaCap.com"] },
      actionValue: "PUSH",
    }),
    stored({
      name: "Older investors copy",
      conditions: { fromDomain: ["sequoiacap.com"] },
      actionValue: "INFO",
      updatedAt: new Date(Date.UTC(2026, 0, 1)),
    }),
    stored({
      name: 'Old "weekly" newsletter',
      description: "muted 2026-11 # not a comment",
      isActive: false,
      conditions: { from: ["news@example.com"] },
      actionValue: "SILENT",
    }),
    stored({
      name: "Board",
      conditions: { from: ["assistant@board.example"] },
      actionValue: "MEETING",
    }),
    stored({
      name: "Thanks note",
      actionType: "AUTO_REPLY",
      conditions: { from: ["a@x.co", "b@x.co"] },
      actionValue: "Thanks, I will get back to you.",
    }),
    stored({
      name: "Vendors",
      actionType: "DRAFT_REPLY",
      isActive: false,
      conditions: { subjectContains: ["quote"] },
      actionValue: "template",
    }),
    stored({ name: "Tag receipts", actionType: "LABEL", actionValue: "Receipts" }),
    stored({
      name: "Two people",
      conditions: { from: ["a@x.co", "b@x.co"] },
      actionValue: "PUSH",
    }),
    stored({ name: "Retired", conditions: { from: ["c@x.co"] }, actionValue: "AUTO" }),
  ];
  const learned: StoredLearnedRule[] = [
    {
      pattern: "subject-keyword",
      value: "invoice",
      tier: "QUEUE",
      status: "OPEN",
      evidenceCount: 1,
    },
    {
      pattern: "sender-domain",
      value: "example.org",
      tier: "INFO",
      status: "APPLIED",
      evidenceCount: 12,
    },
  ];
  return buildInventory(rules, learned);
}

describe("golden files", () => {
  it("exports a mixed rule set exactly as the golden file", () => {
    expect(exportText(mixedInventory())).toBe(fixture("export-mixed.rules"));
  });

  it("exports an empty rule set with a commented example", () => {
    expect(exportText(buildInventory([], []))).toBe(fixture("empty.rules"));
  });

  it("the golden export parses back to its editable rules only", () => {
    const result = checkRules(fixture("export-mixed.rules"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rules.map((r) => r.name)).toEqual([
      "Board",
      'Old "weekly" newsletter',
      "Investors always interrupt",
    ]);
  });

  it("canonicalizes a hand-written file", () => {
    const result = checkRules(fixture("hand-written.rules"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(serializeRules({ rules: result.rules })).toBe(fixture("hand-written.canonical.rules"));
  });

  it("is stable on its own output: serialize(compile(parse(serialize(x)))) === serialize(x)", () => {
    for (const name of ["export-mixed.rules", "empty.rules", "hand-written.canonical.rules"]) {
      const text = fixture(name);
      const inventory = name === "export-mixed.rules" ? mixedInventory() : null;
      const once = checkRules(text);
      expect(once.ok).toBe(true);
      if (!once.ok) continue;
      const again = serializeRules({ rules: once.rules, readOnly: inventory?.readOnly });
      // The duplicate note is a pre-apply state; everything else is identical.
      expect(again).toBe(text.replace("# 1 older copy of this rule is removed on apply.\n", ""));
    }
  });
});

// ── property test: seeded so a failure reproduces ─────────────────────────

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAME_ALPHABET = ["a", "Z", " ", '"', "\\", "#", "\t", "가", "é", "-", ":", "'", "1", "→"];
const LANES = ["PUSH", "MEETING", "QUEUE", "INFO", "SILENT"] as const;

function randomRuleSet(rand: () => number): CompiledRule[] {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)] as T;
  const word = (min: number, max: number) =>
    Array.from({ length: min + Math.floor(rand() * (max - min + 1)) }, () =>
      pick("abcdefghijklmnopqrstuvwxyz0123456789-".split("")),
    ).join("");
  const text = (max: number) =>
    Array.from({ length: 1 + Math.floor(rand() * max) }, () => pick(NAME_ALPHABET)).join("");
  const count = Math.floor(rand() * 25);
  const seen = new Set<string>();
  const rules: CompiledRule[] = [];
  while (rules.length < count) {
    const scope = rand() < 0.5 ? "sender" : "domain";
    const domain = `${word(1, 10)}.${pick(["com", "io", "co.kr", "example"])}`;
    const value = scope === "sender" ? `${word(1, 12)}@${domain}` : domain;
    if (seen.has(`${scope}:${value}`)) continue;
    seen.add(`${scope}:${value}`);
    const name = `${pick(["r", "Rule", "가"])}${text(40)}`;
    rules.push({
      name,
      description: rand() < 0.3 ? null : rand() < 0.1 ? "" : text(80),
      scope,
      value,
      lane: pick(LANES),
      isActive: rand() < 0.8,
    });
  }
  return rules;
}

// Code-unit order, as the serializer sorts (never locale collation).
const keyOf = (r: CompiledRule) => `${r.scope === "sender" ? 0 : 1}:${r.value}`;
const byKey = (a: CompiledRule, b: CompiledRule) =>
  keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0;

describe("property: serialize → parse → compile → serialize is stable", () => {
  it.each(Array.from({ length: 40 }, (_, i) => i + 1))("seed %i", (seed) => {
    const rules = randomRuleSet(mulberry32(seed));
    const text = serializeRules({ rules });
    const parsed = checkRules(text);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors.slice(0, 3)));
    expect(parsed.rules).toEqual([...rules].sort(byKey));
    expect(serializeRules({ rules: parsed.rules })).toBe(text);
  });

  it("every editable stored row serializes to text that compiles back to it", () => {
    for (let seed = 100; seed < 120; seed++) {
      const rules = randomRuleSet(mulberry32(seed));
      const inventory = buildInventory(
        rules.map((r, i) =>
          stored({
            id: `p-${seed}-${i}`,
            name: r.name,
            description: r.description,
            isActive: r.isActive,
            conditions: r.scope === "sender" ? { from: [r.value] } : { fromDomain: [r.value] },
            actionValue: r.lane,
          }),
        ),
        [],
      );
      expect(inventory.readOnly).toEqual([]);
      const parsed = checkRules(exportText(inventory));
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors.slice(0, 3)));
      expect(parsed.rules).toEqual([...rules].sort(byKey));
    }
  });
});
