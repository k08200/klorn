/**
 * IP24 report CLI — interrupt precision within 24h, Klorn vs the Gmail
 * IMPORTANT baseline, with the misses-per-100-rings guardrail and opens shown
 * apart. See src/judge/ip24.ts for every definition and caveat.
 *
 * Read-only: the query runs inside a READ ONLY transaction, so the database
 * refuses a write. No LLM. Prints aggregates only: N, pooled rates, the
 * per-user median and the per-user distribution, never a user id.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @klorn/api ip24-report -- \
 *     [--since=2026-11-13] [--until=2026-11-20] [--days=7] \
 *     [--user=admin@example.com] [--out=$TMPDIR/ip24.json]
 *
 * --out writes the same aggregates as JSON, per-user numbers included: keep
 * it outside the repo (ip24*.json is gitignored as a backstop).
 *
 * --since wins over --days (default 7); --until defaults to now. The ring and
 * Gmail snapshot columns start with migration 20261112020000, so start the
 * window after that deploy. Exits 2 when neither side has a ring at least 24h
 * old in the window.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "../src/db.js";
import { queryIp24, renderIp24Report } from "../src/judge/ip24.js";

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 7;

interface CliArgs {
  since: Date;
  until: Date;
  user?: string;
  out?: string;
}

function parseDate(name: string, raw: string): Date {
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) throw new Error(`--${name} must be an ISO date`);
  return value;
}

function parseArgs(argv: string[]): CliArgs {
  const map = new Map<string, string>();
  for (const raw of argv) {
    const m = raw.match(/^--([\w-]+)=(.+)$/);
    if (m) map.set(m[1], m[2]);
  }
  const until = map.has("until") ? parseDate("until", map.get("until") as string) : new Date();
  const days = Number(map.get("days") ?? DEFAULT_DAYS);
  if (!Number.isFinite(days) || days <= 0) throw new Error("--days must be a positive number");
  const since = map.has("since")
    ? parseDate("since", map.get("since") as string)
    : new Date(until.getTime() - days * DAY_MS);
  if (since >= until) throw new Error("--since must be before --until");
  return { since, until, user: map.get("user"), out: map.get("out") };
}

async function resolveUserId(email: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) throw new Error("No user found for that --user email");
  return user.id;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const userIds = args.user ? [await resolveUserId(args.user)] : undefined;
  const report = await queryIp24({ since: args.since, until: args.until, userIds });

  console.log(renderIp24Report(report));
  if (args.out) {
    const path = resolve(args.out);
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nWrote ${path}`);
  }
  return report.klorn.rings + report.gmail.rings === 0 ? 2 : 0;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error("[ip24-report] failed:", err instanceof Error ? err.message : err);
    await prisma.$disconnect();
    process.exit(1);
  });
