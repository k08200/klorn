/**
 * Attention engine v3 shadow — disagreement report (docs/design/attention-engine-v3.md §5).
 *
 *   pnpm v3-shadow-report [--days=7] [--user=you@example.com] [--out=report.json]
 *
 * Reads AttentionFacts rows written by the JUDGE_V3_SHADOW extractor and prints
 * JSON: v2 lane vs the lane the facts imply (doc §3(4), pre-budget), fallback
 * and escalation rates, evidence drops, models, cost per day. Counts and
 * EmailMessage ids only, never mail text. Exit 2 = no shadow rows in the window.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "../src/db.js";
import { summarizeShadow } from "../src/judge/v3/shadow-report.js";

const DEFAULT_DAYS = 7;
const MAX_ROWS = 50_000;

interface CliArgs {
  user?: string;
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
  if (!Number.isFinite(days) || days <= 0) throw new Error("--days must be a positive number");
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
  const since = new Date(Date.now() - args.days * 86_400_000);
  const rows = await prisma.attentionFacts.findMany({
    where: { extractedAt: { gte: since }, ...(userId ? { userId } : {}) },
    select: {
      sourceId: true,
      factsSource: true,
      facts: true,
      signals: true,
      relationship: true,
      v2Tier: true,
      escalate: true,
      escalateReasons: true,
      evidenceCheck: true,
      costUsd: true,
      model: true,
      provider: true,
      extractedAt: true,
    },
    orderBy: { extractedAt: "asc" },
    take: MAX_ROWS,
  });
  const report = {
    window: { since: since.toISOString(), days: args.days, user: args.user ?? "all" },
    truncated: rows.length === MAX_ROWS,
    ...summarizeShadow(rows),
  };
  const json = JSON.stringify(report, null, 2);
  if (args.out) {
    writeFileSync(resolve(args.out), json);
    console.error(`[v3-shadow-report] wrote ${args.out}`);
  }
  console.log(json);
  return rows.length === 0 ? 2 : 0;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (err) => {
    await prisma.$disconnect();
    console.error("[v3-shadow-report] FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
