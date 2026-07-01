/**
 * Backfill the EmailMessage.fromAddress column (migration
 * 20260702000000_add_emailmessage_from_address) for rows persisted before the
 * column existed.
 *
 * The judge sender-history query only reads fromAddress under
 * SENDER_ADDRESS_INDEX_ENABLED; that flag must stay OFF until this backfill has
 * run, so no correctness window opens (an unbackfilled null row would silently
 * drop from the equality path). Sequence: deploy column + persist → run this →
 * set SENDER_ADDRESS_INDEX_ENABLED=true.
 *
 * Idempotent + resumable: it only ever touches rows WHERE fromAddress IS NULL,
 * walking id-ascending in batches. Interrupt it any time and re-run — already
 * populated rows are skipped by the null filter, so it picks up where it left
 * off. Uses the SAME extractEmailAddress as persist + query so backfilled values
 * match the equality lookup exactly.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/backfill-from-address.ts
 */

import { prisma } from "../src/db.js";
import { extractEmailAddress } from "../src/email-address.js";
import { captureError } from "../src/sentry.js";

const BATCH_SIZE = 1000;

/**
 * Pure per-row transform: EmailMessage.from header → normalized fromAddress
 * value. Empty/whitespace headers map to null so the column never stores "".
 */
export function rowToFromAddress(from: string): string | null {
  return extractEmailAddress(from) || null;
}

async function backfill(): Promise<void> {
  let cursorId: string | undefined;
  let scanned = 0;
  let updated = 0;

  for (;;) {
    const rows = await prisma.emailMessage.findMany({
      where: { fromAddress: null },
      select: { id: true, from: true },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;

    // Per-row update inside a single transaction per batch — bounded work,
    // interruptible between batches (the null filter makes re-runs resume).
    await prisma.$transaction(
      rows.map((row) =>
        prisma.emailMessage.update({
          where: { id: row.id },
          data: { fromAddress: rowToFromAddress(row.from) },
        }),
      ),
    );

    scanned += rows.length;
    updated += rows.length;
    cursorId = rows[rows.length - 1].id;
    console.log(`[backfill:from-address] batch done — scanned=${scanned}, updated=${updated}`);
  }

  console.log(`[backfill:from-address] complete — total rows updated=${updated}`);
}

async function main(): Promise<void> {
  try {
    await backfill();
  } catch (err) {
    console.error("[backfill:from-address] failed:", err);
    captureError(err, { tags: { scope: "backfill.from-address" } });
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
