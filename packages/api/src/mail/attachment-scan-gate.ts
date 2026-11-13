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
