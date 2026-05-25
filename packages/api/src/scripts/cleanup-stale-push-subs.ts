/**
 * Delete PushSubscription rows that the backend can no longer safely deliver to:
 *   - origin IS NULL (pre-migration rows of unknown provenance)
 *   - origin is not in PUSH_ALLOWED_ORIGINS / WEB_URL
 *
 * Users with deleted subs re-subscribe automatically on their next visit to
 * an allowed origin.
 *
 * Usage:
 *   cd packages/api && pnpm tsx src/scripts/cleanup-stale-push-subs.ts            # dry run
 *   cd packages/api && pnpm tsx src/scripts/cleanup-stale-push-subs.ts --apply    # actually delete
 */

import { prisma } from "../db.js";
import { getAllowedPushOrigins, isAllowedPushOrigin } from "../push-origin-allowlist.js";

async function main() {
  const apply = process.argv.includes("--apply");
  const allowed = getAllowedPushOrigins();

  console.log(`Allowed origins: ${allowed.join(", ") || "(none — refusing to run)"}`);
  if (allowed.length === 0) {
    console.error("PUSH_ALLOWED_ORIGINS / WEB_URL not set. Aborting to avoid wiping all subs.");
    process.exit(1);
  }

  const subs = await prisma.pushSubscription.findMany({
    select: { id: true, userId: true, origin: true, endpoint: true, createdAt: true },
  });
  const stale = subs.filter((s) => !isAllowedPushOrigin(s.origin));

  console.log(`Total subs: ${subs.length}. Stale: ${stale.length}.`);
  const byOrigin = new Map<string, number>();
  for (const s of stale) {
    const key = s.origin ?? "(null)";
    byOrigin.set(key, (byOrigin.get(key) ?? 0) + 1);
  }
  for (const [origin, count] of byOrigin) {
    console.log(`  ${origin}: ${count}`);
  }

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to delete.");
    await prisma.$disconnect();
    return;
  }

  const result = await prisma.pushSubscription.deleteMany({
    where: { id: { in: stale.map((s) => s.id) } },
  });
  console.log(`\nDeleted ${result.count} subscription(s).`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Cleanup failed:", err);
  process.exit(1);
});
