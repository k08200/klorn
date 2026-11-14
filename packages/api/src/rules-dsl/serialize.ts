/**
 * Rules DSL v1 serializer: rows → canonical text (docs/design/rules-dsl.md
 * §9). Deterministic and timestamp-free, so an unchanged rule set exports
 * byte-identical text and a git diff shows only real edits. Pure.
 */

import { senderKey } from "./compile.js";
import { commentString, dslString } from "./text.js";
import type { CompiledRule, DslLane } from "./types.js";

export type ReadOnlyEntry =
  | {
      kind: "reply";
      action: "AUTO_REPLY" | "DRAFT_REPLY";
      name: string;
      senderCount: number;
      isActive: boolean;
    }
  | { kind: "other"; action: string; name: string; isActive: boolean }
  | { kind: "pin"; name: string; reason: string; isActive: boolean }
  | {
      kind: "learned";
      pattern: string;
      value: string;
      lane: DslLane;
      status: string;
      evidenceCount: number;
    };

export interface SerializeInput {
  rules: readonly CompiledRule[];
  readOnly?: readonly ReadOnlyEntry[];
  /** Older rows for one sender that apply merges away, by senderKey. */
  duplicates?: ReadonlyMap<string, number>;
}

const HEADER = [
  "# Klorn rules (Rules DSL v1). One rule per sender: an address or a domain.",
  "# Lanes: PUSH, MEETING, QUEUE, INFO, SILENT. Lines starting with # are ignored.",
  "# Edit, then Validate and Apply in Settings > Lanes. Comments are not saved.",
];

const EMPTY_EXAMPLE = [
  "# No rules yet. For example:",
  '# rule "Investors always interrupt"',
  '#   when from domain "example.com"',
  "#   then lane PUSH",
];

const OTHER_ACTIONS: Readonly<Record<string, string>> = {
  LABEL: "label",
  ARCHIVE: "archive",
  NOTIFY: "notify",
};
const LEARNED_PATTERNS: Readonly<Record<string, string>> = {
  "sender-domain": "sender domain",
  "subject-keyword": "subject keyword",
};
const LEARNED_STATUS: Readonly<Record<string, string>> = {
  OPEN: "proposed",
  APPLIED: "applied",
  DISMISSED: "dismissed",
};

/** Address rules first (they outrank domain rules), each by sender, code-unit order. */
function canonicalOrder(rules: readonly CompiledRule[]): CompiledRule[] {
  const rank = (r: CompiledRule) => `${r.scope === "sender" ? 0 : 1}:${r.value}`;
  return [...rules].sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0));
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function ruleBlock(rule: CompiledRule, duplicates: number): string[] {
  const lines: string[] = [];
  if (duplicates > 0) {
    lines.push(
      duplicates === 1
        ? "# 1 older copy of this rule is removed on apply."
        : `# ${duplicates} older copies of this rule are removed on apply.`,
    );
  }
  lines.push(`rule ${dslString(rule.name)}`);
  if (rule.description !== null) lines.push(`  note ${dslString(rule.description)}`);
  lines.push(
    `  when from ${rule.scope === "sender" ? "address" : "domain"} ${dslString(rule.value)}`,
  );
  lines.push(`  then lane ${rule.lane}`);
  if (!rule.isActive) lines.push("  disabled");
  return lines;
}

function readOnlyLine(entry: ReadOnlyEntry): string {
  if (entry.kind === "learned") {
    const pattern = LEARNED_PATTERNS[entry.pattern] ?? "pattern";
    const status = LEARNED_STATUS[entry.status] ?? "unknown status";
    const evidence = plural(entry.evidenceCount, "correction", "corrections");
    return `# learned: ${pattern} ${commentString(entry.value)} -> ${entry.lane} (${status}, ${evidence})`;
  }
  const state = entry.isActive ? "active" : "disabled";
  const name = commentString(entry.name);
  if (entry.kind === "reply") {
    const action = entry.action === "AUTO_REPLY" ? "auto-reply" : "draft reply";
    const senders =
      entry.senderCount === 0 ? "any sender" : plural(entry.senderCount, "sender", "senders");
    return `# reply rule ${name}: ${action}, ${senders}, ${state}`;
  }
  if (entry.kind === "pin") return `# pin ${name}: kept as-is, ${entry.reason}, ${state}`;
  return `# rule ${name}: ${OTHER_ACTIONS[entry.action] ?? "another action"}, ${state}`;
}

export function serializeRules(input: SerializeInput): string {
  const lines = [...HEADER, "version 1"];
  const ordered = canonicalOrder(input.rules);
  if (ordered.length === 0) lines.push("", ...EMPTY_EXAMPLE);
  for (const rule of ordered) {
    lines.push("", ...ruleBlock(rule, input.duplicates?.get(senderKey(rule)) ?? 0));
  }
  const readOnly = input.readOnly ?? [];
  if (readOnly.length > 0) {
    lines.push("", "# Read-only below: listed for reference, never changed by Apply.");
    for (const entry of readOnly) lines.push(readOnlyLine(entry));
  }
  return `${lines.join("\n")}\n`;
}
