/**
 * PushDeliveryLog retention CLI — batched delete of old delivery logs.
 *
 * The table only shrank on account deletion, so it grows unbounded at fleet
 * scale. This prunes rows older than the retention window in batches.
 *
 * OPS/CRON ONLY. This is NOT wired into the automation scheduler by design —
 * run it from a scheduled job (e.g. daily cron) or by hand:
 *
 *   DATABASE_URL=... pnpm --filter @klorn/api prune:push-logs
 *
 * Read-only aside from the delete, no LLM, safe against prod. Logs counts only
 * (no PII). Exits non-zero on failure so a cron caller can alert.
 */

import { prisma } from "../src/db.js";
import { pruneOldPushDeliveryLogs } from "../src/push-delivery.js";

const RETENTION_DAYS = 90;

async function main(): Promise<void> {
  const deleted = await pruneOldPushDeliveryLogs(RETENTION_DAYS);
  console.log(`[prune-push-logs] done — ${deleted} row(s) older than ${RETENTION_DAYS}d removed`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    await prisma.$disconnect();
    console.error("[prune-push-logs] FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
