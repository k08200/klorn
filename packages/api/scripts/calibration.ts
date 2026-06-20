/**
 * Calibration measurement — Day 14+7 retention POC infra.
 *
 * Reads existing AttentionItem rows + FeedbackEvent overrides for a single
 * user inside a window (default 7 days), and emits JSON with:
 *
 *   - perTier:           count + mean/p10/p50/p90 of stated model confidence
 *   - overrideRate:      DISMISSED / IGNORED FeedbackEvents per tier as a
 *                        proxy for "user disagreed with this decision"
 *   - groundTruthAccuracy: if --ground-truth=<path> is supplied, joins on
 *                        AttentionItem.sourceId === groundTruth.items[].id
 *                        (source=EMAIL only) and computes per-tier accuracy
 *                        against the founder-labelled subset
 *   - driftSignal:       this-window tier distribution vs the previous
 *                        same-length window — flags large category shifts
 *
 * Why this exists:
 *
 *   The dev.to thread response was "the system needs the confidence to act
 *   and the humility to abstain when unsure." That requires a measurement
 *   that's NOT just "accuracy at a single point in time" — it's a
 *   distribution + a drift signal that we can re-run on a schedule and
 *   show in the POC retention evidence (Day 14+7 gate).
 *
 *   poc-accuracy.ts already does the one-shot LLM re-judge step (expensive,
 *   requires API keys). This script is its complement: read-only, no LLM,
 *   safe to run daily against prod.
 *
 * Usage:
 *
 *   DATABASE_URL=... pnpm --filter @klorn/api calibration -- \
 *     --user=admin@example.com \
 *     --window-days=7 \
 *     [--ground-truth=./poc-ground-truth.json] \
 *     [--out=./calibration-result.json]
 *
 * Exits non-zero if --user resolves to no AttentionItems (so a cron caller
 * notices when the user reconnects-but-no-sync-happened scenario lands).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type AttentionRow,
  type CalibrationReport,
  computeDriftSignal,
  computeGroundTruthAccuracy,
  computeOverrideRate,
  computePerTier,
  type GroundTruthFile,
  isTier,
  type Tier,
} from "../src/calibration.js";
import { prisma } from "../src/db.js";

interface CliArgs {
  user: string;
  windowDays: number;
  groundTruth?: string;
  out?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const map = new Map<string, string>();
  for (const raw of argv) {
    const m = raw.match(/^--([\w-]+)=(.+)$/);
    if (m) map.set(m[1], m[2]);
  }
  const user = map.get("user");
  if (!user) throw new Error("--user=<email> is required");
  const windowDays = Number(map.get("window-days") ?? "7");
  if (!Number.isFinite(windowDays) || windowDays < 1 || windowDays > 90) {
    throw new Error("--window-days must be between 1 and 90");
  }
  return {
    user,
    windowDays,
    groundTruth: map.get("ground-truth"),
    out: map.get("out"),
  };
}

async function resolveUserId(email: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) throw new Error(`No user found for email=${email}`);
  return user.id;
}

async function fetchAttentionItems(
  userId: string,
  since: Date,
  until: Date,
): Promise<AttentionRow[]> {
  // schema.tier is String? (not enum) — unknown-cast so Prisma's generated
  // types don't narrow it away.
  const rows = await (
    prisma.attentionItem as unknown as {
      findMany: (args: unknown) => Promise<AttentionRow[]>;
    }
  ).findMany({
    where: {
      userId,
      createdAt: { gte: since, lt: until },
    },
    select: {
      id: true,
      source: true,
      sourceId: true,
      tier: true,
      confidence: true,
      createdAt: true,
    },
  });
  return rows;
}

async function fetchOverrideEventIds(
  userId: string,
  since: Date,
  until: Date,
): Promise<Set<string>> {
  const events = await prisma.feedbackEvent.findMany({
    where: {
      userId,
      source: "ATTENTION_ITEM",
      signal: { in: ["DISMISSED", "IGNORED"] },
      createdAt: { gte: since, lt: until },
    },
    select: { sourceId: true },
  });
  return new Set(events.map((e) => e.sourceId));
}

function loadGroundTruth(path: string): Map<string, Tier> {
  const abs = resolve(path);
  const raw = readFileSync(abs, "utf-8");
  const parsed = JSON.parse(raw) as GroundTruthFile;
  const map = new Map<string, Tier>();
  for (const item of parsed.items) {
    if (item.label && isTier(item.label)) {
      map.set(item.id, item.label);
    }
  }
  return map;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const userId = await resolveUserId(args.user);

  const now = new Date();
  const windowMs = args.windowDays * 24 * 60 * 60 * 1000;
  const windowStart = new Date(now.getTime() - windowMs);
  const previousStart = new Date(now.getTime() - 2 * windowMs);

  const [thisRows, previousRows, overrideIds] = await Promise.all([
    fetchAttentionItems(userId, windowStart, now),
    fetchAttentionItems(userId, previousStart, windowStart),
    fetchOverrideEventIds(userId, windowStart, now),
  ]);

  const truth = args.groundTruth ? loadGroundTruth(args.groundTruth) : null;

  const report: CalibrationReport = {
    windowDays: args.windowDays,
    user: args.user,
    windowStart: windowStart.toISOString(),
    windowEnd: now.toISOString(),
    totalItems: thisRows.length,
    perTier: computePerTier(thisRows),
    overrideRate: computeOverrideRate(thisRows, overrideIds),
    driftSignal: computeDriftSignal(thisRows, previousRows),
  };

  if (truth) {
    report.groundTruthAccuracy = computeGroundTruthAccuracy(thisRows, truth);
  }

  const json = JSON.stringify(report, null, 2);
  if (args.out) {
    writeFileSync(resolve(args.out), json);
    console.error(`[calibration] wrote ${args.out}`);
  }
  console.log(json);

  // Non-zero exit when the window has no items at all — the most likely
  // cause is a disconnected Google account (PR #466 corruption scenario),
  // which a cron caller should escalate, not silently file as "0% accuracy".
  return thisRows.length === 0 ? 2 : 0;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (err) => {
    await prisma.$disconnect();
    console.error("[calibration] FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
