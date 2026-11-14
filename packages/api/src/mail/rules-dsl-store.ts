/**
 * Rules DSL reads and writes (docs/design/rules-dsl.md §11). The pure parts —
 * parse, compile, serialize, inventory, apply plan, dry-run math — live in
 * src/rules-dsl; this file only loads the user's rows and runs the plan.
 *
 * Every query and write is scoped by the caller's userId. Writes also match
 * `actionType = PIN_TIER`, so even a stale or forged plan cannot reach a
 * reply/send rule; LearnedRule is read, never written.
 */

import { createHash } from "node:crypto";
import type {
  RulesDslApplyResponse,
  RulesDslDryRunResponse,
  RulesDslExportResponse,
} from "@klorn/contract";
import { prisma } from "../db.js";
import { toLiveTier } from "../judge/tiers.js";
import {
  buildInventory,
  type CompiledRule,
  currentPinRules,
  dryRunRules,
  exportText,
  planApply,
  proposedPinRules,
  type RuleInventory,
  type StoredEmailRule,
  type StoredLearnedRule,
  toRuleRow,
} from "../rules-dsl/index.js";
import { extractEmailAddress } from "./email-address.js";

/** Far above any real rule set; bounds one request's read. */
const MAX_RULE_ROWS = 5000;
const MAX_LEARNED_ROWS = 2000;
export const DRY_RUN_DEFAULT_MAILS = 200;
export const DRY_RUN_MAX_MAILS = 500;
const AUDIT_SOURCE = "rules-dsl";

const RULE_SELECT = {
  id: true,
  name: true,
  description: true,
  isActive: true,
  conditions: true,
  actionType: true,
  actionValue: true,
  updatedAt: true,
} as const;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function loadRules(userId: string): Promise<StoredEmailRule[]> {
  return prisma.emailRule.findMany({
    where: { userId },
    select: RULE_SELECT,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: MAX_RULE_ROWS,
  });
}

function loadLearned(userId: string): Promise<StoredLearnedRule[]> {
  return prisma.learnedRule.findMany({
    where: { userId },
    select: { pattern: true, value: true, tier: true, status: true, evidenceCount: true },
    orderBy: [{ pattern: "asc" }, { value: "asc" }],
    take: MAX_LEARNED_ROWS,
  });
}

/**
 * Identifies the rows apply would replace: the editable pins and their older
 * copies, ids included. Read-only rows (reply rules, learned rules) are left
 * out, since apply never touches them and a weekly mining run must not make
 * an open editor stale.
 */
export function inventoryHash(inventory: RuleInventory): string {
  const state = inventory.editable
    .map((r) => [
      r.rowId,
      [...r.duplicateIds].sort(),
      r.name,
      r.description,
      r.scope,
      r.value,
      r.lane,
      r.isActive,
    ])
    .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1));
  return sha256(JSON.stringify(state));
}

export async function exportRulesFor(userId: string): Promise<RulesDslExportResponse> {
  const [rules, learned] = await Promise.all([loadRules(userId), loadLearned(userId)]);
  const inventory = buildInventory(rules, learned);
  return {
    text: exportText(inventory),
    baseHash: inventoryHash(inventory),
    ruleCount: inventory.editable.length,
    readOnlyCount: inventory.readOnly.length,
  };
}

/** Read-only: the user's rules, newest judged mail and their senders. No write. */
export async function dryRunFor(
  userId: string,
  rules: readonly CompiledRule[],
  limit: number,
): Promise<RulesDslDryRunResponse> {
  const stored = await loadRules(userId);
  const inventory = buildInventory(stored, []);
  const items = await prisma.attentionItem.findMany({
    where: { userId, source: "EMAIL" },
    orderBy: [{ surfacedAt: "desc" }, { id: "desc" }],
    take: limit,
    select: { sourceId: true, tier: true, isManualOverride: true },
  });
  const mails =
    items.length === 0
      ? []
      : await prisma.emailMessage.findMany({
          where: { userId, id: { in: items.map((item) => item.sourceId) } },
          select: { id: true, from: true, fromAddress: true, subject: true },
        });
  const mailBy = new Map(mails.map((mail) => [mail.id, mail]));
  const dryMails = items.flatMap((item) => {
    const mail = mailBy.get(item.sourceId);
    if (!mail) return [];
    // The judge's own sender key (judge-context.ts buildJudgeContext).
    const sender = mail.fromAddress || extractEmailAddress(mail.from ?? "");
    return [
      {
        id: mail.id,
        sender,
        subject: mail.subject,
        lane: toLiveTier(item.tier),
        manual: item.isManualOverride,
      },
    ];
  });
  return dryRunRules({
    current: currentPinRules(stored),
    proposed: proposedPinRules(rules, inventory.keptPins),
    mails: dryMails,
  });
}

export type ApplyOutcome =
  | { kind: "conflict" }
  | { kind: "applied"; result: Omit<RulesDslApplyResponse, "text" | "baseHash"> };

/**
 * Replace the user's editable pins with `rules`, in one transaction with the
 * audit row. Refuses (conflict) when the pins changed since the export the
 * user edited, so a pin made elsewhere meanwhile is never silently deleted.
 */
export async function applyRulesFor(
  userId: string,
  rules: readonly CompiledRule[],
  text: string,
  baseHash: string,
): Promise<ApplyOutcome> {
  const stored = await loadRules(userId);
  const inventory = buildInventory(stored, []);
  if (inventoryHash(inventory) !== baseHash) return { kind: "conflict" };
  const plan = planApply(inventory, rules);
  const scope = { userId, actionType: "PIN_TIER" as const };
  const writes = [
    ...(plan.deletes.length > 0
      ? [prisma.emailRule.deleteMany({ where: { ...scope, id: { in: plan.deletes } } })]
      : []),
    ...plan.updates.map((update) =>
      prisma.emailRule.updateMany({
        where: { ...scope, id: update.id },
        data: toRuleRow(update.rule),
      }),
    ),
    ...(plan.creates.length > 0
      ? [
          prisma.emailRule.createMany({
            data: plan.creates.map((r) => ({ userId, ...toRuleRow(r) })),
          }),
        ]
      : []),
    prisma.ruleChangeAudit.create({
      data: {
        userId,
        source: AUDIT_SOURCE,
        ruleCount: rules.length,
        addedCount: plan.creates.length,
        changedCount: plan.updates.length,
        removedCount: plan.deletes.length,
        textHash: sha256(text),
      },
    }),
  ];
  await prisma.$transaction(writes);
  return {
    kind: "applied",
    result: {
      added: plan.creates.length,
      changed: plan.updates.length,
      removed: plan.deletes.length,
      unchanged: plan.unchanged,
    },
  };
}
