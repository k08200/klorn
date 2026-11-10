/**
 * Throughput CLI — how much mail Klorn has judged, and how much of it it kept
 * out of the way.
 *
 * The competitive teardown's one usable observation about social proof: with
 * eight users, user counts are the wrong number to publish and throughput is
 * the right one. Clean Email says "5 billion emails", Mailstrom "400 million",
 * SaneBox "10.5 billion" — none of them says how many customers they have.
 * Throughput is honest at any scale, and it only ever goes up.
 *
 * Read-only: one groupBy over AttentionItem.tier plus two counts. No LLM, no
 * writes, safe against prod.
 *
 * Deliberately NOT an accuracy number. This says how many decisions were made
 * and how many of them stayed quiet — not whether they were right. That is
 * `decision-metrics` (bounded, confirmed-overrides-only) and `eval:real`
 * (the labelled set). Publishing throughput next to either is fine; blending
 * them into one figure is not.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @klorn/api throughput -- \
 *     [--user=admin@example.com] \
 *     [--days=90] \
 *     [--out=./throughput.json]
 *
 * Omit --user for the whole instance, --days for all time.
 * Exits 2 when the window holds no classified rows, so a caller can tell
 * "nothing judged yet" apart from "judged nothing loudly".
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "../src/db.js";
import { normalizeTier } from "../src/judge/tiers.js";

/** Lanes that reach the user by making noise. Everything else stayed quiet. */
const INTERRUPTING = new Set(["PUSH", "MEETING"]);

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
  const since = args.days === undefined ? undefined : new Date(Date.now() - args.days * 86_400_000);

  const where = {
    ...(userId ? { userId } : {}),
    ...(since ? { createdAt: { gte: since } } : {}),
  };

  // Legacy rows carry retired v1 tiers; normalizeTier folds them the same way
  // every read path does, so the lane breakdown here matches what the product
  // shows rather than what the column happens to store.
  const grouped = await prisma.attentionItem.groupBy({
    by: ["tier"],
    where,
    _count: { _all: true },
  });

  const byLane: Record<string, number> = {};
  let unclassified = 0;
  for (const row of grouped) {
    const n = row._count._all;
    if (row.tier === null) {
      unclassified += n;
      continue;
    }
    const lane = normalizeTier(row.tier);
    byLane[lane] = (byLane[lane] ?? 0) + n;
  }

  const classified = Object.values(byLane).reduce((a, b) => a + b, 0);
  const interrupted = Object.entries(byLane)
    .filter(([lane]) => INTERRUPTING.has(lane))
    .reduce((a, [, n]) => a + n, 0);
  const keptQuiet = classified - interrupted;

  const report = {
    window: args.days === undefined ? "all time" : `last ${args.days} days`,
    scope: args.user ?? "all users",
    generatedAt: new Date().toISOString(),
    classified,
    /** Reached the user by making noise: PUSH, and MEETING when a time needs an answer. */
    interrupted,
    /** Judged and filed without interrupting: QUEUE, INFO, SILENT. */
    keptQuiet,
    /**
     * Share of judged mail that never interrupted. A ratio, not an accuracy —
     * it says how quiet the firewall was, not whether it was right to be.
     */
    keptQuietRate: classified === 0 ? null : Number((keptQuiet / classified).toFixed(4)),
    byLane,
    /** Rows that predate classification or never got a tier. Not counted above. */
    unclassified,
  };

  const json = JSON.stringify(report, null, 2);
  if (args.out) {
    writeFileSync(resolve(args.out), json);
    console.error(`[throughput] wrote ${args.out}`);
  }
  console.log(json);

  return classified === 0 ? 2 : 0;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
