/**
 * Decision-metrics CLI — read the DecisionLabel ledger from the terminal.
 *
 * The same read path as GET /api/admin/decision-metrics, but against the DB
 * directly (no running server, no admin JWT) so the dogfood account can see its
 * own numbers today. Read-only, no LLM, safe to run against prod.
 *
 * Prints bounded honesty, not a clean accuracy %:
 *   - push.recallUpperBound      — confirmed escalations only (null ≠ agreement)
 *   - silent.overSuppressionRate — confirmed rescues only
 *   - byDecidedBy                — which judge path gets overruled (prior-bypass)
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @klorn/api decision-metrics -- \
 *     [--user=admin@example.com] \
 *     [--days=90] \
 *     [--out=./decision-metrics-result.json]
 *
 * Omit --user for every user (per-user breakdown in the `perUser` array).
 * Exits non-zero when the window holds zero ledger rows, so a cron caller can
 * tell "no traffic yet" apart from "0% recall".
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "../src/db.js";
import { getDecisionMetrics } from "../src/judge/decision-metrics.js";

interface CliArgs {
  user?: string;
  days?: number;
  out?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const map = new Map<string, string>();
  for (const raw of argv) {
    const m = raw.match(/^--([\w-]+)=(.+)$/);
    if (m) map.set(m[1], m[2]);
  }
  const daysRaw = map.get("days");
  const days = daysRaw === undefined ? undefined : Number(daysRaw);
  if (days !== undefined && (!Number.isFinite(days) || days < 1)) {
    throw new Error("--days must be a positive number");
  }
  return { user: map.get("user"), days, out: map.get("out") };
}

async function resolveUserId(email: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) throw new Error(`No user found for email=${email}`);
  return user.id;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const userId = args.user ? await resolveUserId(args.user) : undefined;

  const report = await getDecisionMetrics({
    ...(userId ? { userId } : {}),
    ...(args.days !== undefined ? { sinceDays: args.days } : {}),
  });

  const json = JSON.stringify(report, null, 2);
  if (args.out) {
    writeFileSync(resolve(args.out), json);
    console.error(`[decision-metrics] wrote ${args.out}`);
  }
  console.log(json);

  // Zero ledger rows in the window = no real traffic yet (the expected dogfood
  // state today), NOT a quality signal. Surface it as a distinct exit code.
  return report.overall.total === 0 ? 2 : 0;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (err) => {
    await prisma.$disconnect();
    console.error("[decision-metrics] FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
