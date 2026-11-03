/**
 * Policy replay CLI (docs/design/attention-engine-v3.md §5 "Policy replay").
 *
 * Re-runs policy v3 over stored mail and diffs it against the lane v2 shows,
 * with the daily PUSH interrupt budget simulated per user per local day. This
 * is what the founder reads before flipping JUDGE_V3_POLICY.
 *
 * Read-only. No LLM call, no write, no notification. Safe against prod.
 * Facts (--facts):
 *  - stored (default): each row is decided as the live path would decide it
 *    (v3/live-decision.ts). Stored LLM facts (AttentionFacts) go to the
 *    policy; otherwise the v2 lane stands, or keyword facts when v2 itself fell
 *    back to keywords;
 *  - keyword: every row gets keyword facts (v3/keyword-facts.ts), the
 *    model-down estimate.
 * The report says what decided each row.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @klorn/api replay:policy -- \
 *     [--user=admin@example.com] [--days=30] [--budget=5|unlimited] \
 *     [--facts=stored|keyword] [--out=./replay.json] [--max-changes=40] [--show-subjects]
 *
 * Prints ids only by default. --show-subjects adds each changed mail's subject
 * (truncated) to the terminal output; it is never written to --out.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "../src/db.js";
import { toLiveTier } from "../src/judge/tiers.js";
import { parseStoredFacts } from "../src/judge/v3/facts-store.js";
import { resolveInterruptBudget } from "../src/judge/v3/interrupt-budget.js";
import { loadRelationshipSnapshot } from "../src/judge/v3/relationship-loader.js";
import {
  LIVE_LANES,
  type ReplayFactsMode,
  type ReplayReport,
  type ReplayRow,
  replayPolicy,
} from "../src/judge/v3/replay.js";
import { prismaShadowDeps } from "../src/judge/v3/shadow.js";

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
  facts: ReplayFactsMode;
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
  const facts = map.get("facts") ?? "stored";
  if (facts !== "stored" && facts !== "keyword") {
    throw new Error("--facts must be 'stored' or 'keyword'");
  }
  return {
    user: map.get("user"),
    days,
    budget,
    facts,
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
    const [items, labels, facts] = await Promise.all([
      prisma.attentionItem.findMany({
        where: { source: "EMAIL", sourceId: { in: ids } },
        select: {
          userId: true,
          sourceId: true,
          tier: true,
          isManualOverride: true,
          agentTierSetAt: true,
          v3PolicyVersion: true,
          heldAt: true,
        },
      }),
      prisma.decisionLabel.findMany({
        where: { source: "EMAIL", sourceId: { in: ids } },
        select: { userId: true, sourceId: true, decidedBy: true },
      }),
      prisma.attentionFacts.findMany({
        where: { source: "EMAIL", sourceId: { in: ids } },
        select: {
          userId: true,
          sourceId: true,
          factsVersion: true,
          factsSource: true,
          facts: true,
          certainFields: true,
          signals: true,
          relationship: true,
          v2Tier: true,
        },
      }),
    ]);
    const itemBy = new Map(items.map((i) => [`${i.userId}|${i.sourceId}`, i]));
    const labelBy = new Map(labels.map((l) => [`${l.userId}|${l.sourceId}`, l]));
    const factsBy = new Map(facts.map((f) => [`${f.userId}|${f.sourceId}`, f]));
    await loadZones(
      emails.map((e) => e.userId),
      zones,
    );
    for (const e of emails) {
      const item = itemBy.get(`${e.userId}|${e.id}`);
      const stored = factsBy.get(`${e.userId}|${e.id}`);
      subjects.set(e.id, printableSubject(e.subject));
      rows.push({
        id: e.id,
        userId: e.userId,
        receivedAt: e.receivedAt,
        timeZone: zones.get(e.userId) ?? DEFAULT_TIME_ZONE,
        v2Tier: toLiveTier(v2LaneOf(item, stored?.v2Tier ?? null)),
        v2Source: labelBy.get(`${e.userId}|${e.id}`)?.decidedBy ?? null,
        // An agent's lane is preserved on a re-judge like a human's.
        manualOverride: (item?.isManualOverride ?? false) || item?.agentTierSetAt != null,
        email: {
          from: e.from,
          subject: e.subject,
          snippet: e.snippet,
          body: e.body?.slice(0, BODY_SCAN_CHARS) ?? null,
          labels: e.labels,
          hasListUnsubscribe: e.listUnsubscribeMailto != null || e.listUnsubscribeUrl != null,
        },
        stored: stored ? parseStoredFacts(stored) : null,
      });
    }
  }
  return { rows, subjects };
}

interface ItemLane {
  tier: string | null;
  isManualOverride: boolean;
  agentTierSetAt: Date | null;
  v3PolicyVersion: string | null;
  heldAt: Date | null;
}

/**
 * The lane v2 decided. No item yet reads as QUEUE, exactly as the lane queries
 * treat it. A human's or an agent's lane is kept as is. For an item v3 decided
 * live, AttentionItem.tier is v3's lane:
 *  - with a facts row, the v2 lane frozen on it is used;
 *  - without one (a precedence source, or no facts), v3 kept v2's lane and
 *    only a budget hold changed it, so a held item was v2 PUSH.
 */
function v2LaneOf(item: ItemLane | undefined, frozenV2: string | null): string {
  if (!item) return "QUEUE";
  const kept = item.isManualOverride || item.agentTierSetAt !== null;
  if (kept || !item.v3PolicyVersion) return item.tier ?? "QUEUE";
  if (frozenV2) return frozenV2;
  return item.heldAt ? "PUSH" : (item.tier ?? "QUEUE");
}

/**
 * Trust for the slot reserve, as live loads it for a budgeted PUSH with no
 * relationship: only v2 PUSH rows can become one without facts. Read-only.
 */
async function attachRelationships(rows: ReplayRow[]): Promise<ReplayRow[]> {
  const contexts = new Map<string, string[]>();
  const out: ReplayRow[] = [];
  for (const row of rows) {
    if (row.v2Tier !== "PUSH" || row.stored?.relationship) {
      out.push(row);
      continue;
    }
    if (!contexts.has(row.userId)) {
      contexts.set(row.userId, (await prismaShadowDeps.userContext(row.userId)).userAddresses);
    }
    const relationship = await loadRelationshipSnapshot({
      userId: row.userId,
      senderAddress: row.email.from,
      userAddresses: contexts.get(row.userId) ?? [],
      senderAuthenticated: null,
      excludeEmailId: row.id,
    });
    out.push({ ...row, relationship });
  }
  return out;
}

/**
 * A subject is attacker-controlled: drop control characters (terminal escape
 * sequences included) before it reaches the operator's terminal, then cap it.
 */
function printableSubject(subject: string): string {
  // Unicode format characters too (bidi overrides, zero-width): they can
  // reorder what the terminal shows.
  return (
    subject
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
      .replace(/[\u0000-\u001f\u007f-\u009f]|\p{Cf}/gu, " ")
      .slice(0, SUBJECT_PREVIEW)
  );
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
    `  items ${total}, users ${report.users}, facts mode ${report.factsMode}, stored rows ${report.storedFacts.rows} (LLM ${report.storedFacts.llm}), precedence kept ${report.precedenceKept}`,
  );
  console.log(
    `  decided by: LLM facts ${report.basis.llm}, keyword facts ${report.basis.keyword}, v2 lane ${report.basis.v2}`,
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
      `  ${c.receivedAt.slice(0, 16)} ${c.id} ${c.v2}→${c.v3}${c.held ? " (held)" : ""} [${c.reasonCodes.join(",")}] ${c.basis}${subject}`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const userId = args.user ? await resolveUserId(args.user) : undefined;
  const since = new Date(Date.now() - args.days * 24 * 60 * 60 * 1000);
  const loaded = await loadRows(userId, since);
  const rows = await attachRelationships(loaded.rows);
  const { subjects } = loaded;
  if (rows.length === 0) {
    console.error(`No mail in the last ${args.days} days${args.user ? ` for ${args.user}` : ""}.`);
    process.exitCode = 1;
    return;
  }
  const report = replayPolicy(rows, { budget: args.budget, facts: args.facts });
  printReport(report, args, subjects);
  if (args.out) {
    const path = resolve(args.out);
    // Ids and lane changes for every user: owner-only.
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(`\nWrote ${path}`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
