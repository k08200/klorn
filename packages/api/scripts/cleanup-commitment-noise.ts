/**
 * Commitment Ledger retro-cleanup CLI — remove/fix rows mined before the
 * 2026-07-22 quality fixes (automated notices saved as WAITING ON, sender
 * first-person promises saved as I OWE).
 *
 * Scope: rows the EMAIL mining pipeline created (dedupKey "email:*") in
 * OPEN/SNOOZED status. DONE/DISMISSED rows are never touched — the user
 * already acted on them. Decision logic lives in
 * src/pim/commitment-cleanup.ts and mirrors the current pipeline exactly.
 *
 * OPS ONLY — run by hand against prod:
 *
 *   DATABASE_URL=... pnpm --filter @klorn/api cleanup:commitment-noise           # dry-run (default)
 *   DATABASE_URL=... pnpm --filter @klorn/api cleanup:commitment-noise -- --apply
 *
 * Dry-run prints every decision with a short evidence excerpt (the operator's
 * own data — review before applying) and changes nothing. --apply deletes the
 * noise rows (CommitmentPath cascades) and updates mis-attributed owners.
 * Exits non-zero on failure.
 */

import { prisma } from "../src/db.js";
import { classifyMinedCommitment, type SourceEmailRow } from "../src/pim/commitment-cleanup.js";
import { resolveUserEmail } from "../src/resolve-user-email.js";

const APPLY = process.argv.includes("--apply");
const EXCERPT_LEN = 80;

function excerpt(value: string | null): string {
  const compact = (value ?? "").replace(/\s+/g, " ").trim();
  return compact.length > EXCERPT_LEN ? `${compact.slice(0, EXCERPT_LEN - 1)}…` : compact;
}

async function main(): Promise<void> {
  const rows = await prisma.commitment.findMany({
    where: {
      sourceType: "EMAIL",
      dedupKey: { startsWith: "email:" },
      status: { in: ["OPEN", "SNOOZED"] },
    },
    select: {
      id: true,
      userId: true,
      owner: true,
      evidenceText: true,
      confidence: true,
      sourceId: true,
    },
    orderBy: { createdAt: "asc" },
  });
  console.log(`[cleanup-commitment-noise] ${rows.length} mined OPEN/SNOOZED row(s) to evaluate`);
  if (rows.length === 0) return;

  // One email + one user-email lookup per distinct key, not per row.
  const emailIds = [...new Set(rows.map((r) => r.sourceId).filter((id): id is string => !!id))];
  const emails = await prisma.emailMessage.findMany({
    where: { id: { in: emailIds } },
    select: {
      id: true,
      from: true,
      fromAddress: true,
      subject: true,
      body: true,
      snippet: true,
      labels: true,
    },
  });
  const emailById = new Map<string, SourceEmailRow>(emails.map((e) => [e.id, e]));

  const userEmailByUserId = new Map<string, string | null>();
  for (const userId of new Set(rows.map((r) => r.userId))) {
    userEmailByUserId.set(userId, await resolveUserEmail(userId));
  }

  const toDelete: string[] = [];
  const toReattribute: Array<{ id: string; counterpartyEmail: string | null }> = [];
  let kept = 0;

  for (const row of rows) {
    const email = row.sourceId ? (emailById.get(row.sourceId) ?? null) : null;
    const decision = classifyMinedCommitment(row, email, userEmailByUserId.get(row.userId) ?? null);
    console.log(
      `  ${decision.action.toUpperCase().padEnd(11)} ${row.id}  [${row.owner}] ` +
        `"${excerpt(row.evidenceText)}" — ${decision.reason}`,
    );
    if (decision.action === "delete") toDelete.push(row.id);
    else if (decision.action === "reattribute") {
      toReattribute.push({ id: row.id, counterpartyEmail: decision.counterpartyEmail });
    } else kept++;
  }

  console.log(
    `[cleanup-commitment-noise] plan: delete ${toDelete.length}, ` +
      `reattribute ${toReattribute.length}, keep ${kept}`,
  );
  if (!APPLY) {
    console.log("[cleanup-commitment-noise] dry-run — nothing changed. Re-run with --apply.");
    return;
  }

  const deleted = await prisma.commitment.deleteMany({ where: { id: { in: toDelete } } });
  for (const fix of toReattribute) {
    await prisma.commitment.update({
      where: { id: fix.id },
      data: { owner: "COUNTERPARTY", counterpartyEmail: fix.counterpartyEmail },
    });
  }
  console.log(
    `[cleanup-commitment-noise] applied — ${deleted.count} deleted, ` +
      `${toReattribute.length} re-attributed`,
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    await prisma.$disconnect();
    console.error("[cleanup-commitment-noise] FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
