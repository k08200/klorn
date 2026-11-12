/**
 * Commitment.dueAt backfill — OPEN ledger rows mined before deterministic due
 * dates (src/pim/commitment-due.ts). Decision logic lives in
 * src/pim/commitment-due-backfill.ts and mirrors ingestion exactly.
 *
 * Scope: status OPEN and dueAt null. DONE / DISMISSED / SNOOZED rows and rows
 * that already carry a dueAt (user-set or resolved) are never touched.
 *
 * OPS ONLY — founder approval required before --apply:
 *
 *   DATABASE_URL=... pnpm --filter @klorn/api backfill:commitment-due              # dry-run (default)
 *   DATABASE_URL=... pnpm --filter @klorn/api backfill:commitment-due -- --apply
 *
 * Output is aggregate counts only — no ids, titles, wording, or emails — so it
 * can be pasted anywhere. --apply sets dueAt (and dueText when the row had
 * none) only while the row is still OPEN with no dueAt, then re-projects its
 * queue item (COMMITMENT_UNCONFIRMED → DUE / OVERDUE). Exits non-zero on failure.
 */

import { prisma } from "../src/db.js";
import { upsertAttentionForCommitment } from "../src/judge/attention-mirror.js";
import {
  type DueBackfillDecision,
  type DueBackfillRow,
  planDueBackfill,
  summarizeDueBackfill,
} from "../src/pim/commitment-due-backfill.js";
import { normalizeTimeZone } from "../src/time-zone.js";

const APPLY = process.argv.includes("--apply");

/**
 * Error kind only: a Prisma error message can echo the query arguments (ids,
 * mail-derived wording), and this script's output must stay aggregate.
 */
function errorKind(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  const name = err instanceof Error ? err.name : typeof err;
  return typeof code === "string" ? `${name} ${code}` : name;
}

function unique(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}

async function loadRows(): Promise<{ rows: DueBackfillRow[]; zoneByUser: Map<string, string> }> {
  const commitments = await prisma.commitment.findMany({
    where: { status: "OPEN", dueAt: null },
    select: {
      id: true,
      userId: true,
      dueText: true,
      evidenceText: true,
      createdAt: true,
      sourceType: true,
      sourceId: true,
    },
  });
  const emailIds = unique(commitments.map((c) => (c.sourceType === "EMAIL" ? c.sourceId : null)));
  const emails = await prisma.emailMessage.findMany({
    where: { id: { in: emailIds } },
    select: { id: true, receivedAt: true },
  });
  const receivedAtById = new Map(emails.map((email) => [email.id, email.receivedAt]));
  const configs = await prisma.automationConfig.findMany({
    where: { userId: { in: unique(commitments.map((c) => c.userId)) } },
    select: { userId: true, timezone: true },
  });
  const zoneByUser = new Map(configs.map((c) => [c.userId, normalizeTimeZone(c.timezone)]));
  const rows = commitments.map((c) => ({
    id: c.id,
    userId: c.userId,
    dueText: c.dueText,
    evidenceText: c.evidenceText,
    createdAt: c.createdAt,
    sourceReceivedAt:
      c.sourceType === "EMAIL" && c.sourceId ? (receivedAtById.get(c.sourceId) ?? null) : null,
  }));
  return { rows, zoneByUser };
}

async function apply(decision: DueBackfillDecision): Promise<boolean> {
  const { count } = await prisma.commitment.updateMany({
    where: { id: decision.id, userId: decision.userId, status: "OPEN", dueAt: null },
    data: {
      dueAt: decision.dueAt,
      ...(decision.dueTextFromEvidence ? { dueText: decision.dueText } : {}),
    },
  });
  if (count === 0) return false;
  const updated = await prisma.commitment.findUnique({ where: { id: decision.id } });
  if (updated) await upsertAttentionForCommitment(updated);
  return true;
}

async function main(): Promise<void> {
  const { rows, zoneByUser } = await loadRows();
  const decisions = rows.map((row) =>
    planDueBackfill(row, zoneByUser.get(row.userId) ?? normalizeTimeZone(undefined)),
  );
  const summary = summarizeDueBackfill(decisions, new Date());
  console.log(JSON.stringify({ mode: APPLY ? "apply" : "dry-run", ...summary }, null, 2));
  if (!APPLY) return;

  let updated = 0;
  let skipped = 0;
  const failures = new Map<string, number>();
  for (const decision of decisions.filter((d) => d.outcome === "resolved")) {
    try {
      if (await apply(decision)) updated++;
      else skipped++; // changed since the read: closed, or a due date was set
    } catch (err) {
      const kind = errorKind(err);
      failures.set(kind, (failures.get(kind) ?? 0) + 1);
    }
  }
  console.log(
    JSON.stringify({
      updated,
      skippedChangedSinceRead: skipped,
      failed: Object.fromEntries(failures),
    }),
  );
  if (failures.size > 0) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    console.error(`[backfill-commitment-due-at] failed: ${errorKind(err)}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
