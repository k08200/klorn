/**
 * Re-encrypt every stored secret under the active encryption key.
 *
 * Rotation flow:
 *   1. Add the new key to TOKEN_ENCRYPTION_KEYS and set
 *      TOKEN_ENCRYPTION_ACTIVE_KEY_ID to it; keep the old key in the ring.
 *   2. Deploy — new writes are already v2 under the new key; old rows still
 *      decrypt via the retained old key.
 *   3. Run this sweep with --apply to rewrite every old row to the new key.
 *      Re-run until it reports rewritten=0 (skipped rows are ones live traffic
 *      changed mid-sweep; a re-run picks them up).
 *   4. Only then drop the retired key. If any v1 rows still exist, KEEP the
 *      legacy TOKEN_ENCRYPTION_KEY set until this sweep has migrated them all —
 *      removing it early makes decryptToken fail-closed on every remaining v1
 *      row (by design), e.g. breaking Gmail sync for those users.
 *
 * Covers every encrypted column: UserToken (Google OAuth), the two linked
 * account tables (calendar/inbox OAuth), and the User BYOK/app-secret columns
 * (Naver IMAP password, GitHub PAT, OpenRouter/Gemini keys).
 *
 * Usage:
 *   cd packages/api && pnpm tsx src/scripts/reencrypt-tokens.ts            # dry run
 *   cd packages/api && pnpm tsx src/scripts/reencrypt-tokens.ts --apply    # rewrite
 *
 * Safe to re-run and safe to interrupt: each row is rewritten only when it is
 * not already current (needsReencryption), and a decrypt failure on one row is
 * logged and skipped rather than aborting the whole sweep.
 */

import { activeKeyId, needsReencryption, reencryptToActiveKey } from "../crypto-tokens.js";
import { prisma } from "../db.js";

interface SweepStats {
  scanned: number;
  rewritten: number;
  skipped: number;
  failed: number;
}

interface FieldSweep {
  label: string;
  scan: (apply: boolean) => Promise<SweepStats>;
}

function summarize(results: Array<{ label: string } & SweepStats>) {
  const totals: SweepStats = { scanned: 0, rewritten: 0, skipped: 0, failed: 0 };
  for (const r of results) {
    totals.scanned += r.scanned;
    totals.rewritten += r.rewritten;
    totals.skipped += r.skipped;
    totals.failed += r.failed;
    console.log(
      `  ${r.label}: scanned=${r.scanned} rewritten=${r.rewritten} skipped=${r.skipped} failed=${r.failed}`,
    );
  }
  console.log(
    `Totals: scanned=${totals.scanned} rewritten=${totals.rewritten} skipped=${totals.skipped} failed=${totals.failed}`,
  );
  return totals;
}

/**
 * Build a sweep over one table's encrypted string columns, keyed by row id.
 *
 * `guardedUpdate` must issue a conditional updateMany that only writes when the
 * originally-read ciphertext still matches (where: { id, ...originalValues }),
 * returning the affected row count. This closes a lost-update race: live
 * traffic (e.g. a Gmail OAuth refresh) can rotate a token between our read and
 * our write, and a blind update would clobber that fresh token with a
 * re-encryption of the stale value we read. On a 0-row match we skip the row —
 * it changed under us; a fresh write is already v2-or-newer, and a later run
 * re-checks it.
 */
function tableSweep<Row extends { id: string }>(
  label: string,
  fetch: () => Promise<Row[]>,
  columns: Array<keyof Row>,
  guardedUpdate: (
    id: string,
    data: Record<string, string>,
    guard: Record<string, string>,
  ) => Promise<{ count: number }>,
): FieldSweep {
  return {
    label,
    scan: async (apply) => {
      const rows = await fetch();
      const stats: SweepStats = { scanned: rows.length, rewritten: 0, skipped: 0, failed: 0 };
      for (const row of rows) {
        const data: Record<string, string> = {};
        const guard: Record<string, string> = {};
        for (const col of columns) {
          const value = row[col] as unknown as string | null | undefined;
          if (!needsReencryption(value)) continue;
          try {
            const next = reencryptToActiveKey(value);
            if (next && next !== value) {
              data[col as string] = next;
              // `value` is truthy here (needsReencryption is false for empty).
              guard[col as string] = value as string;
            }
          } catch (err) {
            stats.failed += 1;
            console.error(`  [${label}] row ${row.id} column ${String(col)} failed:`, err);
          }
        }
        if (Object.keys(data).length === 0) continue;
        if (!apply) {
          stats.rewritten += 1;
          continue;
        }
        const { count } = await guardedUpdate(row.id, data, guard);
        if (count > 0) stats.rewritten += 1;
        else stats.skipped += 1; // row changed under us since the read
      }
      return stats;
    },
  };
}

function buildSweeps(): FieldSweep[] {
  return [
    tableSweep(
      "UserToken",
      () =>
        prisma.userToken.findMany({ select: { id: true, accessToken: true, refreshToken: true } }),
      ["accessToken", "refreshToken"],
      (id, data, guard) => prisma.userToken.updateMany({ where: { id, ...guard }, data }),
    ),
    tableSweep(
      "LinkedCalendarAccount",
      () =>
        prisma.linkedCalendarAccount.findMany({
          select: { id: true, accessToken: true, refreshToken: true },
        }),
      ["accessToken", "refreshToken"],
      (id, data, guard) =>
        prisma.linkedCalendarAccount.updateMany({ where: { id, ...guard }, data }),
    ),
    tableSweep(
      "LinkedInboxAccount",
      () =>
        prisma.linkedInboxAccount.findMany({
          select: { id: true, accessToken: true, refreshToken: true },
        }),
      ["accessToken", "refreshToken"],
      (id, data, guard) => prisma.linkedInboxAccount.updateMany({ where: { id, ...guard }, data }),
    ),
    tableSweep(
      "User(secrets)",
      () =>
        prisma.user.findMany({
          select: {
            id: true,
            naverImapPasswordCipher: true,
            githubTokenCipher: true,
            openRouterApiKey: true,
            geminiApiKey: true,
          },
        }),
      ["naverImapPasswordCipher", "githubTokenCipher", "openRouterApiKey", "geminiApiKey"],
      (id, data, guard) => prisma.user.updateMany({ where: { id, ...guard }, data }),
    ),
  ];
}

async function main() {
  const apply = process.argv.includes("--apply");

  const active = activeKeyId();
  if (!active) {
    console.error(
      "No keyring active: set TOKEN_ENCRYPTION_KEYS + TOKEN_ENCRYPTION_ACTIVE_KEY_ID first. " +
        "Nothing to migrate in legacy single-key mode.",
    );
    process.exit(1);
  }

  console.log(`Active key id: ${active}. Mode: ${apply ? "APPLY" : "dry run"}.`);

  const results: Array<{ label: string } & SweepStats> = [];
  for (const sweep of buildSweeps()) {
    results.push({ label: sweep.label, ...(await sweep.scan(apply)) });
  }

  console.log("");
  const totals = summarize(results);

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to rewrite the rows above.");
  } else {
    console.log(`\nRewrote ${totals.rewritten} row(s) to key "${active}".`);
    if (totals.skipped > 0) {
      console.log(`${totals.skipped} row(s) changed under us mid-sweep — re-run to pick them up.`);
    }
    if (totals.failed > 0) {
      console.log(`${totals.failed} column(s) failed to decrypt and were left as-is.`);
    }
  }

  await prisma.$disconnect();
  // Non-zero exit if anything failed to decrypt, so CI/cron can alert.
  if (totals.failed > 0) process.exit(2);
}

main().catch((err) => {
  console.error("Re-encryption sweep failed:", err);
  process.exit(1);
});
