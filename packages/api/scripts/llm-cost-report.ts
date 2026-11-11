/**
 * LLM cost report (docs/design/pricing-tiers.md): Klorn's spend per feature
 * and per user-day by plan, from LlmUsageLog.
 *
 *   pnpm cost-report [--days=7] [--out=report.json]
 *
 * The window is the last N complete UTC days (today, still in progress, is
 * left out so user-days are whole). Everything is aggregated in the database;
 * no raw rows are loaded. Prints JSON with aggregates only — no user ids, no
 * mail text. Rows written before the feature/cost columns existed show as
 * "(unattributed)" and are left out of the per-user-day figures. A user's plan
 * is their plan now, not at spend time.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildLlmCostReport, type FeatureGroup } from "../src/billing/llm-cost-report.js";
import { prisma } from "../src/db.js";

const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

interface CliArgs {
  days: number;
  out?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const map = new Map<string, string>();
  for (const raw of argv) {
    const m = raw.match(/^--([\w-]+)=(.+)$/);
    if (m) map.set(m[1], m[2]);
  }
  const days = map.has("days") ? Number(map.get("days")) : DEFAULT_DAYS;
  if (!Number.isInteger(days) || days <= 0 || days > MAX_DAYS) {
    throw new Error(`--days must be a whole number from 1 to ${MAX_DAYS}`);
  }
  return { days, out: map.get("out") };
}

/** [since, until): the last `days` complete UTC days, ending at today's midnight. */
function completeUtcDays(days: number, now: Date): { since: Date; until: Date } {
  const until = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { since: new Date(until.getTime() - days * DAY_MS), until };
}

async function featureGroups(since: Date, until: Date): Promise<FeatureGroup[]> {
  const groups = await prisma.llmUsageLog.groupBy({
    by: ["feature", "source", "ownedByUser", "usageMissing"],
    where: { createdAt: { gte: since, lt: until } },
    _count: { _all: true },
    _sum: { costMicroCents: true },
  });
  return groups.map((g) => ({
    feature: g.feature,
    source: g.source,
    ownedByUser: g.ownedByUser,
    usageMissing: g.usageMissing,
    calls: g._count._all,
    costMicroCents: g._sum.costMicroCents ?? 0,
  }));
}

/** Klorn-paid spend on attributed, priced calls, one row per user per UTC day. */
async function userDaySpend(since: Date, until: Date) {
  const rows = await prisma.$queryRaw<Array<{ userId: string | null; micro: bigint }>>`
    SELECT "userId", SUM("costMicroCents")::bigint AS micro
    FROM "LlmUsageLog"
    WHERE "createdAt" >= ${since} AND "createdAt" < ${until}
      AND "ownedByUser" = false AND "feature" IS NOT NULL AND "usageMissing" = false
    GROUP BY "userId", date_trunc('day', "createdAt")`;
  return rows.map((r) => ({ userId: r.userId, costMicroCents: Number(r.micro) }));
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const { since, until } = completeUtcDays(args.days, new Date());
  const [features, userDays] = await Promise.all([
    featureGroups(since, until),
    userDaySpend(since, until),
  ]);
  const userIds = [...new Set(userDays.flatMap((d) => (d.userId ? [d.userId] : [])))];
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, plan: true },
  });
  const planOf = new Map(users.map((u) => [u.id, String(u.plan)]));
  const report = {
    window: { days: args.days, since: since.toISOString(), until: until.toISOString() },
    ...buildLlmCostReport({ features, userDays, planOf }),
  };
  const json = JSON.stringify(report, null, 2);
  if (args.out) writeFileSync(resolve(args.out), `${json}\n`);
  else console.log(json);
  if (report.totals.usageMissingCalls > 0) {
    console.error(
      `[cost-report] ${report.totals.usageMissingCalls} call(s) returned no usage: their cost is unknown, not zero.`,
    );
  }
  return report.totals.calls === 0 ? 2 : 0;
}

/** Error name and code only: Prisma messages can carry the DB host or query values. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return "unknown error";
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? `${err.name} (${code})` : err.name;
}

main()
  .then((code) => prisma.$disconnect().then(() => process.exit(code)))
  .catch(async (err) => {
    const usage =
      err instanceof Error && err.message.startsWith("--days") ? `: ${err.message}` : "";
    console.error(`[cost-report] failed: ${describeError(err)}${usage}`);
    await prisma.$disconnect();
    process.exit(1);
  });
