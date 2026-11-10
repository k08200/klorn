/**
 * Ontology-v2 flip backfill: legacy AUTO attention items → QUEUE + autoEligible.
 *
 * Run ONCE, right after TIER_V2_ENABLED flips (docs/design/tier-ontology-v2.md):
 *
 *   pnpm exec tsx scripts/backfill-tier-v2.ts            # dry-run (default)
 *   pnpm exec tsx scripts/backfill-tier-v2.ts --apply    # write
 *
 * Scope: OPEN and SNOOZED rows only — the surfaces users see. Terminal rows
 * (RESOLVED/DISMISSED) keep their historical tier="AUTO": they feed per-tier
 * decision metrics, and rewriting history would silently move those numbers.
 * normalizeTier keeps "AUTO" a valid storage value forever, so nothing breaks.
 *
 * isManualOverride rows are excluded — a human explicitly chose AUTO for
 * those, and the flip must not overrule a manual decision.
 */

import { prisma } from "../src/db.js";

const APPLY = process.argv.includes("--apply");

const where = {
  tier: "AUTO",
  status: { in: ["OPEN", "SNOOZED"] },
  isManualOverride: false,
} as const;

async function main() {
  const candidates = await prisma.attentionItem.count({ where });
  const terminal = await prisma.attentionItem.count({
    where: { tier: "AUTO", status: { notIn: ["OPEN", "SNOOZED"] } },
  });
  const manual = await prisma.attentionItem.count({
    where: { tier: "AUTO", status: { in: ["OPEN", "SNOOZED"] }, isManualOverride: true },
  });
  console.log(`AUTO rows — backfill candidates: ${candidates}`);
  console.log(`            left as history (terminal): ${terminal}`);
  console.log(`            left alone (manual override): ${manual}`);

  if (!APPLY) {
    console.log("\nDry-run only. Re-run with --apply to write.");
    return;
  }
  const res = await prisma.attentionItem.updateMany({
    where,
    data: {
      tier: "QUEUE",
      autoEligible: true,
      tierReason: "Ontology v2 backfill — was AUTO; now QUEUE + auto-eligible",
    },
  });
  console.log(`\nBackfilled ${res.count} rows to QUEUE + autoEligible.`);
}

main()
  .catch((err) => {
    console.error("backfill failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
