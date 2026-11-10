/**
 * Lane-quality CLI — per lane, what users did with the mail Klorn judged.
 *
 * For each of the five lanes (and each lane × decidedBy cell): mails judged,
 * share with any outcome, share opened, share replied within 24h, share
 * archived / dismissed / snoozed / starred / unsubscribed, explicit overrides
 * and confirms, and the override flows (shown lane → lane the user moved it
 * to). See src/judge/lane-quality.ts for what each number does and does not
 * mean.
 *
 * Read-only: the queries run inside a READ ONLY transaction. No LLM, safe
 * against prod.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @klorn/api lane-quality -- \
 *     [--since=2026-10-25] [--until=2026-11-01] [--days=7] \
 *     [--user=admin@example.com] [--source=EMAIL] [--out=./lane-quality.json]
 *
 * --since wins over --days (default 7); --until defaults to now. Engagement
 * stamping started with migration 20261108120000, so start the window after
 * that deploy. Exits 2 when the window holds no judged rows.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "../src/db.js";
import type { AttentionSourceName } from "../src/judge/decision-label.js";
import { queryLaneQuality, renderLaneQualityReport } from "../src/judge/lane-quality.js";

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 7;
const SOURCES: readonly AttentionSourceName[] = [
  "EMAIL",
  "PENDING_ACTION",
  "TASK",
  "CALENDAR_EVENT",
  "NOTIFICATION",
  "COMMITMENT",
  "GITHUB",
];

interface CliArgs {
  since: Date;
  until: Date;
  user?: string;
  source: AttentionSourceName;
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
  const source = (map.get("source") ?? "EMAIL") as AttentionSourceName;
  if (!SOURCES.includes(source)) throw new Error(`--source must be one of ${SOURCES.join(", ")}`);
  return { since, until, user: map.get("user"), source, out: map.get("out") };
}

async function resolveUserId(email: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) throw new Error(`No user found for email=${email}`);
  return user.id;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const userId = args.user ? await resolveUserId(args.user) : undefined;
  const report = await queryLaneQuality({
    since: args.since,
    until: args.until,
    userId,
    source: args.source,
  });

  console.log(renderLaneQualityReport(report));
  if (args.out) {
    const path = resolve(args.out);
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nWrote ${path}`);
  }
  const judged = report.lanes.reduce((sum, lane) => sum + lane.judged, 0);
  return judged === 0 ? 2 : 0;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error("[lane-quality] failed:", err instanceof Error ? err.message : err);
    await prisma.$disconnect();
    process.exit(1);
  });
