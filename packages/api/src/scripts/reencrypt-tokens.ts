/**
 * Re-encrypt every stored secret under the active encryption key.
 *
 * Rotation flow:
 *   1. Add the new key to TOKEN_ENCRYPTION_KEYS and set
 *      TOKEN_ENCRYPTION_ACTIVE_KEY_ID to it; keep the old key in the ring.
 *   2. Deploy — new writes are already v2 under the new key; old rows still
 *      decrypt via the retained old key.
 *   3. Run this sweep with --apply to rewrite every old row to the new key.
 *   4. Once the sweep reports 0 remaining, drop the old key from the ring.
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

interface FieldSweep {
  label: string;
  scan: (apply: boolean) => Promise<{ scanned: number; rewritten: number; failed: number }>;
}

function summarize(
  results: Array<{ label: string; scanned: number; rewritten: number; failed: number }>,
) {
  let scanned = 0;
  let rewritten = 0;
  let failed = 0;
  for (const r of results) {
    scanned += r.scanned;
    rewritten += r.rewritten;
    failed += r.failed;
    console.log(
      `  ${r.label}: scanned=${r.scanned} needing-rewrite=${r.rewritten} failed=${r.failed}`,
    );
  }
  console.log(`Totals: scanned=${scanned} rewritten=${rewritten} failed=${failed}`);
  return { scanned, rewritten, failed };
}

/** Build a sweep over one table's encrypted string columns, keyed by row id. */
function tableSweep<Row extends { id: string }>(
  label: string,
  fetch: () => Promise<Row[]>,
  columns: Array<keyof Row>,
  update: (id: string, data: Record<string, string>) => Promise<unknown>,
): FieldSweep {
  return {
    label,
    scan: async (apply) => {
      const rows = await fetch();
      let rewritten = 0;
      let failed = 0;
      for (const row of rows) {
        const data: Record<string, string> = {};
        for (const col of columns) {
          const value = row[col] as unknown as string | null | undefined;
          if (!needsReencryption(value)) continue;
          try {
            const next = reencryptToActiveKey(value);
            if (next && next !== value) data[col as string] = next;
          } catch (err) {
            failed += 1;
            console.error(`  [${label}] row ${row.id} column ${String(col)} failed:`, err);
          }
        }
        if (Object.keys(data).length === 0) continue;
        rewritten += 1;
        if (apply) await update(row.id, data);
      }
      return { scanned: rows.length, rewritten, failed };
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
      (id, data) => prisma.userToken.update({ where: { id }, data }),
    ),
    tableSweep(
      "LinkedCalendarAccount",
      () =>
        prisma.linkedCalendarAccount.findMany({
          select: { id: true, accessToken: true, refreshToken: true },
        }),
      ["accessToken", "refreshToken"],
      (id, data) => prisma.linkedCalendarAccount.update({ where: { id }, data }),
    ),
    tableSweep(
      "LinkedInboxAccount",
      () =>
        prisma.linkedInboxAccount.findMany({
          select: { id: true, accessToken: true, refreshToken: true },
        }),
      ["accessToken", "refreshToken"],
      (id, data) => prisma.linkedInboxAccount.update({ where: { id }, data }),
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
      (id, data) => prisma.user.update({ where: { id }, data }),
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

  const results: Array<{ label: string; scanned: number; rewritten: number; failed: number }> = [];
  for (const sweep of buildSweeps()) {
    results.push({ label: sweep.label, ...(await sweep.scan(apply)) });
  }

  console.log("");
  const totals = summarize(results);

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to rewrite the rows above.");
  } else {
    console.log(`\nRewrote ${totals.rewritten} row(s) to key "${active}".`);
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
