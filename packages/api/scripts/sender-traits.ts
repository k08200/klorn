/**
 * Sender-trait CLI — read the SenderTrait store from the terminal.
 *
 * The same read path as GET /api/admin/sender-traits, but against the DB
 * directly (no running server, no admin JWT) so the dogfood account can eyeball
 * its own extracted traits today. Read-only, no LLM, safe to run against prod.
 *
 * Prints the Phase 3/B2 "measure" surface: coverage / conflict-rate / confidence
 * buckets, then an evidence inspector (sender -> trait + the quoted evidence that
 * justified it). The evidence eyeball is the gate to the judge-injection
 * fast-follow.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/sender-traits.ts [userId]
 *
 * Omit userId to read across all users.
 */

import { prisma } from "../src/db.js";
import { getTraitMetrics } from "../src/learning/sender-trait-metrics.js";

async function main(): Promise<void> {
  const userId = process.argv[2];
  const metrics = await getTraitMetrics(prisma, userId);
  console.log("Sender-trait metrics:", JSON.stringify(metrics, null, 2));

  const rows = await prisma.senderTrait.findMany({
    where: userId ? { userId } : {},
    orderBy: [{ sender: "asc" }, { factKind: "asc" }],
    take: 100,
    select: {
      sender: true,
      factKind: true,
      factValue: true,
      status: true,
      confidence: true,
      evidenceText: true,
    },
  });

  console.log("\nEvidence inspector:");
  for (const r of rows) {
    const flag = r.status === "conflicted" ? " [CONFLICT]" : "";
    console.log(`  ${r.sender} | ${r.factKind}=${r.factValue} (${r.confidence.toFixed(2)})${flag}`);
    console.log(`    ↳ "${r.evidenceText}"`);
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
