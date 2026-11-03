/**
 * Policy replay CLI (docs/design/attention-engine-v3.md §5 "Policy replay").
 *
 * Re-runs policy v3 over stored mail and diffs it against the lane v2 shows,
 * with the daily PUSH interrupt budget simulated per user per local day. This
 * is what the founder reads before flipping JUDGE_V3_POLICY.
 *
 * Read-only. No LLM call, no write, no notification. Safe against prod.
 * Facts: rows with stored facts (AttentionFacts, written by the P2 extractor
 * under JUDGE_V3_SHADOW) use them; every other row uses keyword facts
 * (v3/keyword-facts.ts), the model-down path. The report says how many of each.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @klorn/api replay:policy -- \
 *     [--user=admin@example.com] [--days=30] [--budget=5|unlimited] \
 *     [--out=./replay.json] [--max-changes=40] [--show-subjects]
 *
 * Prints ids only by default. --show-subjects adds each changed mail's subject
 * (truncated) to the terminal output; it is never written to --out.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "../src/db.js";
import { toLiveTier } from "../src/judge/tiers.js";
import { resolveInterruptBudget } from "../src/judge/v3/interrupt-budget.js";
import {
  LIVE_LANES,
  type ReplayReport,
  type ReplayRow,
  replayPolicy,
} from "../src/judge/v3/replay.js";

const PAGE = 500;
const BODY_SCAN_CHARS = 4000; // detectSchedulingIntent reads at most this much body
const DEFAULT_DAYS = 30;
const DEFAULT_MAX_CHANGES = 40;
const SUBJECT_PREVIEW = 80;
const DEFAULT_TIME_ZONE = "Asia/Seoul"; // AutomationConfig.timezone's schema default

interface CliArgs {
  user?: string;
  days: number;
  budget: number | null;
  out?: string;
  maxChanges: number;
  showSubjects: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const map = new Map<string, string>();
  const flags = new Set<string>();
  for (const raw of argv) {
    const kv = raw.match(/^--([\w-]+)=(.+)$/);
    if (kv) map.set(kv[1], kv[2]);
    else if (raw.startsWith("--")) flags.add(raw.slice(2));
  }
  const days = Number(map.get("days") ?? DEFAULT_DAYS);
  if (!Number.isInteger(days) || days < 1) throw new Error("--days must be a positive integer");
  const maxChanges = Number(map.get("max-changes") ?? DEFAULT_MAX_CHANGES);
  if (!Number.isInteger(maxChanges) || maxChanges < 0)
    throw new Error("--max-changes must be >= 0");
  const budgetRaw = map.get("budget");
  const budget = resolveInterruptBudget({
    JUDGE_V3_PUSH_BUDGET: budgetRaw ?? process.env.JUDGE_V3_PUSH_BUDGET,
  });
  if (budgetRaw && budgetRaw !== "unlimited" && budget !== Number(budgetRaw)) {
    throw new Error("--budget must be a positive integer or 'unlimited'");
  }
  return {
    user: map.get("user"),
    days,
    budget,
    out: map.get("out"),
    maxChanges,
    showSubjects: flags.has("show-subjects"),
  };
}

async function resolveUserId(email: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) throw new Error(`No user with email ${email}`);
  return user.id;
}

async function loadRows(
  userId: string | undefined,
  since: Date,
): Promise<{ rows: ReplayRow[]; subjects: Map<string, string> }> {
  const rows: ReplayRow[] = [];
  const subjects = new Map<string, string>();
  const zones = new Map<string, string>();
  for (let skip = 0; ; skip += PAGE) {
    const emails = await prisma.emailMessage.findMany({
      where: { ...(userId ? { userId } : {}), receivedAt: { gte: since } },
      orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
      skip,
      take: PAGE,
      select: {
        id: true,
        userId: true,
        from: true,
        subject: true,
        snippet: true,
        body: true,
        labels: true,
        receivedAt: true,
        listUnsubscribeMailto: true,
        listUnsubscribeUrl: true,
      },
    });
    if (emails.length === 0) break;
    const ids = emails.map((e) => e.id);
    const [items, labels] = await Promise.all([
      prisma.attentionItem.findMany({
        where: { source: "EMAIL", sourceId: { in: ids } },
        select: { userId: true, sourceId: true, tier: true, isManualOverride: true },
      }),
      prisma.decisionLabel.findMany({
        where: { source: "EMAIL", sourceId: { in: ids } },
        select: { userId: true, sourceId: true, decidedBy: true },
      }),
    ]);
    const itemBy = new Map(items.map((i) => [`${i.userId}|${i.sourceId}`, i]));
    const labelBy = new Map(labels.map((l) => [`${l.userId}|${l.sourceId}`, l]));
    await loadZones(
      emails.map((e) => e.userId),
      zones,
    );
    for (const e of emails) {
      const item = itemBy.get(`${e.userId}|${e.id}`);
      subjects.set(e.id, printableSubject(e.subject));
      rows.push({
        id: e.id,
        userId: e.userId,
        receivedAt: e.receivedAt,
        timeZone: zones.get(e.userId) ?? DEFAULT_TIME_ZONE,
        // No item yet reads as QUEUE, exactly as the lane queries treat it.
        v2Tier: toLiveTier(item?.tier ?? "QUEUE"),
        v2Source: labelBy.get(`${e.userId}|${e.id}`)?.decidedBy ?? null,
        manualOverride: item?.isManualOverride ?? false,
        email: {
          from: e.from,
          subject: e.subject,
          snippet: e.snippet,
          body: e.body?.slice(0, BODY_SCAN_CHARS) ?? null,
          labels: e.labels,
          hasListUnsubscribe: e.listUnsubscribeMailto != null || e.listUnsubscribeUrl != null,
        },
        stored: null,
      });
    }
  }
  return { rows, subjects };
}

/**
 * A subject is attacker-controlled: drop control characters (terminal escape
 * sequences included) before it reaches the operator's terminal, then cap it.
 */
function printableSubject(subject: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  return subject.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, SUBJECT_PREVIEW);
}

async function loadZones(userIds: string[], zones: Map<string, string>): Promise<void> {
  const missing = [...new Set(userIds)].filter((id) => !zones.has(id));
  if (missing.length === 0) return;
  const configs = await prisma.automationConfig.findMany({
    where: { userId: { in: missing } },
    select: { userId: true, timezone: true },
  });
  for (const c of configs) zones.set(c.userId, c.timezone);
}

const pct = (n: number, total: number) => (total ? `${((100 * n) / total).toFixed(1)}%` : "-");

function printReport(report: ReplayReport, args: CliArgs, subjects: Map<string, string>): void {
  const total = report.items;
  console.log(`\nPolicy ${report.policyVersion} replay — last ${args.days} days`);
  console.log(
    `  items ${total}, users ${report.users}, facts stored ${report.factsSource.stored} / keyword ${report.factsSource.keyword}, precedence kept ${report.precedenceKept}`,
  );
  console.log(`\nLane            v2 shown         v3 pre-budget    v3 final`);
  for (const lane of LIVE_LANES) {
    const cell = (n: number) => `${String(n).padStart(6)} ${pct(n, total).padStart(7)}  `;
    console.log(
      `  ${lane.padEnd(12)}${cell(report.lanes.v2[lane])}${cell(report.lanes.v3PreBudget[lane])}${cell(report.lanes.v3[lane])}`,
    );
  }
  console.log("\nTransitions v2 → v3 (changed only):");
  for (const [key, n] of Object.entries(report.transitions).sort((a, b) => b[1] - a[1])) {
    const [from, to] = key.split("→");
    if (from !== to) console.log(`  ${key.padEnd(18)} ${n}`);
  }
  const b = report.budget;
  console.log(
    `\nInterrupt budget ${b.limit ?? "unlimited"}/day: candidates ${b.candidates}, admitted ${b.admitted}, held ${b.held}`,
  );
  console.log(
    `  user-days with a candidate ${b.userDaysWithCandidates}, max per user-day ${b.maxCandidatesPerUserDay}, user-days over budget ${b.userDaysOverBudget}`,
  );
  const p = report.parity;
  console.log(
    `\nKeyword parity (model-down path) over ${p.compared}: violations hidden ${p.violations.hidden}, lost PUSH ${p.violations.lostPush}, machine PUSH ${p.violations.machinePush}`,
  );
  for (const [key, n] of Object.entries(p.divergences).sort((a, c) => c[1] - a[1]))
    console.log(`  ${key.padEnd(40)} ${n}`);
  console.log(
    `\nChanged items (${report.changes.length}, showing ${Math.min(args.maxChanges, report.changes.length)}):`,
  );
  for (const c of report.changes.slice(0, args.maxChanges)) {
    const subject = args.showSubjects ? `  "${subjects.get(c.id) ?? ""}"` : "";
    console.log(
      `  ${c.receivedAt.slice(0, 16)} ${c.id} ${c.v2}→${c.v3}${c.held ? " (held)" : ""} [${c.reasonCodes.join(",")}] ${c.factsSource}${subject}`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const userId = args.user ? await resolveUserId(args.user) : undefined;
  const since = new Date(Date.now() - args.days * 24 * 60 * 60 * 1000);
  const { rows, subjects } = await loadRows(userId, since);
  if (rows.length === 0) {
    console.error(`No mail in the last ${args.days} days${args.user ? ` for ${args.user}` : ""}.`);
    process.exitCode = 1;
    return;
  }
  const report = replayPolicy(rows, { budget: args.budget });
  printReport(report, args, subjects);
  if (args.out) {
    const path = resolve(args.out);
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nWrote ${path}`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
