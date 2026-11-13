/**
 * Should a re-read message have its attachments listed (and their text
 * extracted) now? The IMAP poll re-reads its whole window every cycle and a
 * Graph delta re-delivers a message whenever a flag changes, while Gmail lists
 * a message's attachments once, when it first fetches it. Answering "yes" only
 * when the message has no row yet, or a row without attachment rows, keeps
 * extraction to once per message (rows synced before attachments were read are
 * backfilled once) and keeps a re-read from rewriting attachment rows.
 */

import { prisma } from "../db.js";

export async function needsAttachmentScan(userId: string, gmailId: string): Promise<boolean> {
  const row = await prisma.emailMessage.findUnique({
    where: { userId_gmailId: { userId, gmailId } },
    select: { _count: { select: { attachments: true } } },
  });
  return !row || row._count.attachments === 0;
}

/**
 * Messages this process has already listed (or found nothing to list in). The IMAP
 * poll re-reads its window every five minutes; without this a message with no
 * attachment rows (none to find, or only parts Gmail's rule drops) would be walked
 * and looked up on every cycle. Per process and bounded: a restart, or eviction
 * past the cap, only costs one more walk.
 */
const MAX_REMEMBERED_SCANS = 20_000;
const scanned = new Set<string>();

const scanKey = (userId: string, gmailId: string) => `${userId}\u0000${gmailId}`;

export function wasAttachmentScanned(userId: string, gmailId: string): boolean {
  return scanned.has(scanKey(userId, gmailId));
}

export function rememberAttachmentScan(userId: string, gmailId: string): void {
  if (scanned.size >= MAX_REMEMBERED_SCANS) {
    const oldest = scanned.values().next().value;
    if (oldest !== undefined) scanned.delete(oldest);
  }
  scanned.add(scanKey(userId, gmailId));
}

/** Test hook. */
export function resetAttachmentScanMemo(): void {
  scanned.clear();
}
