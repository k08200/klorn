/**
 * Manual CLI over the fallback-rejudge core (src/judge/fallback-rejudge.ts) —
 * repair keyword-fallback decisions left behind by a provider outage.
 *
 * The automated counterpart is the scheduler sweep (FALLBACK_REJUDGE_SWEEP,
 * default OFF); this CLI exists for bulk one-off repairs and for accounts
 * where the operator wants to review the plan first.
 *
 * DRY RUN by default: prints old→new per item through the production judge
 * path without writing. Writes only with CONFIRM=1. Eligibility and write
 * semantics live in the shared core — this file only parses flags and prints.
 *
 * Usage (packages/api):
 *   npx tsx scripts/rejudge-fallback.ts --user=<account email>            # dry run
 *   CONFIRM=1 npx tsx scripts/rejudge-fallback.ts --user=<account email>  # apply
 *   Optional: --limit=<n>  --delay=<ms, default 500>  --lookback=<days, default 14>
 * Run with JUDGE_INCLUDE_BODY=true to match prod judging.
 */

import { prisma } from "../src/db.js";
import { rejudgeFallbackItems } from "../src/judge/fallback-rejudge.js";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

const userEmail = arg("user");
if (!userEmail) throw new Error("--user=<account email> is required");
const APPLY = process.env.CONFIRM === "1";

async function main(): Promise<number> {
  const user = await prisma.user.findUnique({
    where: { email: userEmail },
    select: { id: true },
  });
  if (!user) throw new Error(`no user found for email=${userEmail}`);
  console.log(
    `rejudging keyword-fallback residue for ${userEmail} — ${APPLY ? "APPLYING" : "DRY RUN (set CONFIRM=1 to write)"}`,
  );

  const summary = await rejudgeFallbackItems(user.id, {
    apply: APPLY,
    limit: arg("limit") ? Number(arg("limit")) : undefined,
    delayMs: arg("delay") ? Number(arg("delay")) : undefined,
    lookbackDays: arg("lookback") ? Number(arg("lookback")) : undefined,
    onRow: (line) => console.log(`  ${line}`),
  });

  console.log(
    `\nsummary: ${summary.changed} tier change(s), ${summary.unchanged} unchanged${summary.skippedFallback ? ", ABORTED — provider still degraded" : ""}${APPLY ? " — WRITTEN" : " — dry run, nothing written"}`,
  );
  return 0;
}

main()
  .then((code) => prisma.$disconnect().then(() => process.exit(code)))
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
