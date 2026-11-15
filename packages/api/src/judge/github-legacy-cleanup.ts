/**
 * One-shot cleanup for the removed GitHub notifications integration.
 *
 * The poller is gone, but the AttentionItems it already wrote are not — and
 * nothing auto-resolves them, so without this they would sit on the firewall
 * board forever competing with real mail for its recency window (the exact
 * starvation that froze the board in 2026-08). The old disconnect route used
 * to do this, but only for users who clicked disconnect.
 *
 * Idempotent and self-retiring: after the first successful pass every
 * subsequent boot updates zero rows. Runs once per process at startup,
 * fire-and-forget. The Prisma enum keeps its GITHUB member on purpose —
 * Postgres cannot drop an enum value while rows reference it, and the
 * historical DecisionLabel ledger still does.
 */

import { prisma } from "../db.js";
import { captureDbFailure, logDbFailure } from "../report-db-failure.js";

export async function purgeLegacyGitHubAttention(): Promise<number> {
  try {
    const { count } = await prisma.attentionItem.updateMany({
      where: { source: "GITHUB", status: { in: ["OPEN", "SNOOZED"] } },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
    if (count > 0) {
      console.log(`[GITHUB-PURGE] resolved ${count} legacy GitHub attention item(s)`);
    }
    return count;
  } catch (err) {
    // Never blocks boot: a failed pass simply retries on the next restart.
    logDbFailure("[GITHUB-PURGE] cleanup failed", err);
    captureDbFailure("[GITHUB-PURGE] cleanup failed", err, {
      tags: { scope: "github.legacy-purge" },
    });
    return 0;
  }
}
