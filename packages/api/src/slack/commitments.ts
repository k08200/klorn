/**
 * Commitments from Slack episodes (docs/providers/slack.md §10): the existing
 * ledger ingestion with sourceType SLACK. Rule-only candidates land below the
 * confirmation line, i.e. suggested, not confirmed — as for mail. Every
 * message in an episode is someone else's (the user's own are never stored),
 * so a first-person promise is the counterparty's.
 */

import { prisma } from "../db.js";
import { deleteAttentionForCommitments } from "../judge/attention-mirror.js";
import {
  type CommitmentIngestionResult,
  extractAndUpsertCommitmentsFromText,
} from "../pim/commitment-ingestion.js";

export function extractSlackCommitments(input: {
  userId: string;
  channel: string;
  firstTs: string;
  threadKey: string;
  text: string;
  referenceDate: Date;
}): Promise<CommitmentIngestionResult> {
  return extractAndUpsertCommitmentsFromText({
    userId: input.userId,
    sourceType: "SLACK",
    sourceId: `${input.channel}:${input.firstTs}`,
    ...(input.threadKey ? { threadId: `${input.channel}:${input.threadKey}` } : {}),
    text: input.text,
    referenceDate: input.referenceDate,
    senderIsUser: false,
  });
}

/** Disconnect: the user's Slack-sourced commitments and their queue mirrors. */
export async function deleteSlackCommitments(userId: string): Promise<number> {
  const rows = await prisma.commitment.findMany({
    where: { userId, sourceType: "SLACK" },
    select: { id: true },
  });
  if (rows.length === 0) return 0;
  const ids = rows.map((row) => row.id);
  const { count } = await prisma.commitment.deleteMany({ where: { userId, id: { in: ids } } });
  await deleteAttentionForCommitments(ids, userId);
  return count;
}
