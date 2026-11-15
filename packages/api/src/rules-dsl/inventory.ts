/**
 * Rules DSL v1 inventory: which stored rows the DSL may edit and which it
 * only lists, plus the apply diff (docs/design/rules-dsl.md §2, §9). Pure:
 * the caller reads the rows and runs the plan.
 *
 * Editable = a PIN_TIER row the DSL can spell exactly AND the judge reads as
 * that same pin: one address or one non-public domain, a live lane, a name
 * and note within the limits. Everything else (reply/send rules, labels,
 * odd pins, learned rules) is listed read-only and never named by a plan.
 */

import { toLiveTier } from "../judge/tiers.js";
import { validateTierPin } from "../mail/pin-validate.js";
import { senderKey } from "./compile.js";
import { RULES_DSL_LIMITS } from "./limits.js";
import { type ReadOnlyEntry, serializeRules } from "./serialize.js";
import { isSpellable } from "./text.js";
import type { CompiledRule } from "./types.js";

export interface StoredEmailRule {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  conditions: unknown;
  actionType: string;
  actionValue: string;
  updatedAt: Date;
}

export interface StoredLearnedRule {
  pattern: string;
  value: string;
  tier: string;
  status: string;
  evidenceCount: number;
}

/** An editable rule and the rows behind it: the one the judge reads, and older copies. */
export interface InventoryRule extends CompiledRule {
  rowId: string;
  duplicateIds: string[];
  /** The kept row's updatedAt: the judge reads newest first. */
  updatedAt: Date;
}

export interface RuleInventory {
  editable: InventoryRule[];
  readOnly: ReadOnlyEntry[];
  /** PIN_TIER rows kept as-is: the judge still reads them, so a dry-run must too. */
  keptPins: StoredEmailRule[];
}

const CANNOT_EXPRESS = "it has conditions the DSL cannot express";
const NOT_A_SENDER = "the sender is not a valid address or domain";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The single sender a pin names, or why it does not name exactly one. */
function pinSender(conditions: unknown): { scope: "sender" | "domain"; raw: string } | string {
  if (!isPlainObject(conditions)) return CANNOT_EXPRESS;
  const keys = Object.keys(conditions);
  if (keys.length === 0) return "it names no sender";
  const key = keys[0];
  if (keys.length !== 1 || (key !== "from" && key !== "fromDomain")) return CANNOT_EXPRESS;
  const list = conditions[key];
  if (!Array.isArray(list) || list.length === 0) return "it names no sender";
  if (list.length > 1) return "it names several senders";
  const raw = list[0];
  if (typeof raw !== "string") return CANNOT_EXPRESS;
  return { scope: key === "from" ? "sender" : "domain", raw };
}

/** The rule as the DSL spells it, or why the row stays read-only. */
function editableFrom(row: StoredEmailRule): CompiledRule | string {
  const sender = pinSender(row.conditions);
  if (typeof sender === "string") return sender;
  if (!isSpellable(sender.raw, RULES_DSL_LIMITS.maxValueChars)) return NOT_A_SENDER;
  const validated = validateTierPin({
    scope: sender.scope,
    value: sender.raw,
    tier: row.actionValue,
  });
  if ("error" in validated) {
    if (validated.code === "tier") return "its lane is not one of the five live lanes";
    if (validated.code === "public-domain") return "its domain is a public mailbox domain";
    return NOT_A_SENDER;
  }
  // The judge lowercases and drops a leading "@" but never trims: a stored
  // value with spaces matches nothing, so it must not look like a live pin.
  const judged = sender.raw.toLowerCase();
  const asJudged = sender.scope === "domain" ? judged.replace(/^@/, "") : judged;
  if (asJudged !== validated.ok.value) return NOT_A_SENDER;
  const nameOk = isSpellable(row.name, RULES_DSL_LIMITS.maxNameChars) && row.name.trim() !== "";
  const noteOk =
    row.description === null || isSpellable(row.description, RULES_DSL_LIMITS.maxNoteChars);
  if (!nameOk || !noteOk) return "its name or note cannot be written in the DSL";
  return {
    name: row.name,
    description: row.description,
    scope: validated.ok.scope,
    value: validated.ok.value,
    lane: toLiveTier(validated.ok.tier),
    isActive: row.isActive,
  };
}

function readOnlyRule(row: StoredEmailRule): ReadOnlyEntry {
  if (row.actionType === "AUTO_REPLY" || row.actionType === "DRAFT_REPLY") {
    const from = isPlainObject(row.conditions) ? row.conditions.from : undefined;
    return {
      kind: "reply",
      action: row.actionType,
      name: row.name,
      senderCount: Array.isArray(from) ? from.length : 0,
      isActive: row.isActive,
    };
  }
  return { kind: "other", action: row.actionType, name: row.name, isActive: row.isActive };
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The judge reads the newest ACTIVE pin; that one is the rule, older rows are copies. */
function representative(rows: readonly { rule: CompiledRule; row: StoredEmailRule }[]) {
  return [...rows].sort(
    (a, b) =>
      Number(b.row.isActive) - Number(a.row.isActive) ||
      b.row.updatedAt.getTime() - a.row.updatedAt.getTime() ||
      byText(a.row.id, b.row.id),
  );
}

export function buildInventory(
  rows: readonly StoredEmailRule[],
  learned: readonly StoredLearnedRule[],
): RuleInventory {
  const groups = new Map<string, { rule: CompiledRule; row: StoredEmailRule }[]>();
  const readOnly: ReadOnlyEntry[] = [];
  const keptPins: StoredEmailRule[] = [];
  for (const row of rows) {
    if (row.actionType !== "PIN_TIER") {
      readOnly.push(readOnlyRule(row));
      continue;
    }
    const rule = editableFrom(row);
    if (typeof rule === "string") {
      readOnly.push({ kind: "pin", name: row.name, reason: rule, isActive: row.isActive });
      keptPins.push(row);
      continue;
    }
    const key = senderKey(rule);
    groups.set(key, [...(groups.get(key) ?? []), { rule, row }]);
  }
  const editable = [...groups.values()].map((group) => {
    const [first, ...rest] = representative(group);
    const winner = first as { rule: CompiledRule; row: StoredEmailRule };
    return {
      ...winner.rule,
      rowId: winner.row.id,
      duplicateIds: rest.map((r) => r.row.id),
      updatedAt: winner.row.updatedAt,
    };
  });
  const learnedEntries = [...learned]
    .sort((a, b) => byText(a.pattern, b.pattern) || byText(a.value, b.value))
    .map(
      (rule): ReadOnlyEntry => ({
        kind: "learned",
        pattern: rule.pattern,
        value: rule.value,
        lane: toLiveTier(rule.tier),
        status: rule.status,
        evidenceCount: rule.evidenceCount,
      }),
    );
  return { editable, readOnly: [...readOnly, ...learnedEntries], keptPins };
}

/** The canonical export of an inventory, duplicate notes included. */
export function exportText(inventory: RuleInventory): string {
  const duplicates = new Map(
    inventory.editable
      .filter((rule) => rule.duplicateIds.length > 0)
      .map((rule) => [senderKey(rule), rule.duplicateIds.length]),
  );
  return serializeRules({ rules: inventory.editable, readOnly: inventory.readOnly, duplicates });
}

export interface ApplyPlan {
  creates: CompiledRule[];
  updates: { id: string; rule: CompiledRule }[];
  deletes: string[];
  unchanged: number;
}

/** Same stored fields: apply leaves the row untouched. */
export function sameRule(a: CompiledRule, b: CompiledRule): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.lane === b.lane &&
    a.isActive === b.isActive
  );
}

function stripRow(rule: CompiledRule): CompiledRule {
  const { name, description, scope, value, lane, isActive } = rule;
  return { name, description, scope, value, lane, isActive };
}

/**
 * The diff that makes the editable pins equal `rules`. Identity is the
 * sender: a rule keeps its row while its sender stays the same. Only ids of
 * editable rows (and their older copies) can appear in it.
 */
export function planApply(inventory: RuleInventory, rules: readonly CompiledRule[]): ApplyPlan {
  const existing = new Map(inventory.editable.map((rule) => [senderKey(rule), rule]));
  const plan: ApplyPlan = { creates: [], updates: [], deletes: [], unchanged: 0 };
  const kept = new Set<string>();
  const seen = new Set<string>();
  for (const rule of rules) {
    const key = senderKey(rule);
    // checkRules never yields one sender twice; a direct caller might.
    if (seen.has(key)) continue;
    seen.add(key);
    const current = existing.get(key);
    if (!current) {
      plan.creates.push(stripRow(rule));
      continue;
    }
    kept.add(key);
    plan.deletes.push(...current.duplicateIds);
    if (sameRule(current, rule)) plan.unchanged += 1;
    else plan.updates.push({ id: current.rowId, rule: stripRow(rule) });
  }
  for (const [key, current] of existing) {
    if (!kept.has(key)) plan.deletes.push(current.rowId, ...current.duplicateIds);
  }
  return plan;
}

/** The EmailRule columns one rule writes; the same shape every pin writer uses. */
export function toRuleRow(rule: CompiledRule) {
  return {
    name: rule.name,
    description: rule.description,
    isActive: rule.isActive,
    conditions: rule.scope === "domain" ? { fromDomain: [rule.value] } : { from: [rule.value] },
    actionType: "PIN_TIER" as const,
    actionValue: rule.lane,
  };
}
