/**
 * Commitments from an imported KakaoTalk chat (docs/providers/kakaotalk-import.md
 * §4): the existing ledger ingestion with sourceType KAKAO. Always suggested,
 * never confirmed on its own (capped below the 0.7 line in
 * pim/commitment-ingestion.ts, like Slack). Every derived row carries the
 * import's threadId, so deleting an import deletes what it made.
 */

import { prisma } from "../db.js";
import { deleteAttentionForCommitments } from "../judge/attention-mirror.js";
import {
  type CommitmentIngestionResult,
  extractAndUpsertCommitmentsFromText,
} from "../pim/commitment-ingestion.js";
import type { ProviderCredentials } from "../providers/index.js";

/** The usage-ledger label of the import's LLM calls. */
export const KAKAO_LLM_FEATURE = "kakao-import";
const CONTEXT_TITLE = "KakaoTalk";

export function kakaoImportThreadId(importId: string): string {
  return `kakao-import:${importId}`;
}

export interface KakaoCommitmentInput {
  readonly userId: string;
  readonly importId: string;
  readonly seq: number;
  readonly sentAt: Date;
  readonly speaker: string;
  readonly fromMe: boolean;
  readonly text: string;
  readonly timeZone: string;
  readonly credentials: ProviderCredentials;
  readonly maxCandidates: number;
}

export function extractKakaoCommitments(
  input: KakaoCommitmentInput,
): Promise<CommitmentIngestionResult> {
  const sourceId = `${kakaoImportThreadId(input.importId)}:${input.seq}`;
  return extractAndUpsertCommitmentsFromText({
    userId: input.userId,
    sourceType: "KAKAO",
    sourceId,
    threadId: kakaoImportThreadId(input.importId),
    // One commitment per message: the same words from two speakers, or on two
    // days, are two promises (owner and due date differ). A re-run of the
    // same message still dedups.
    dedupScope: sourceId,
    text: input.text,
    // The other speaker's display name tells the card who owes what; the
    // user's own messages need no name.
    contextTitle: input.fromMe ? CONTEXT_TITLE : `${CONTEXT_TITLE} · ${input.speaker}`,
    referenceDate: input.sentAt,
    timeZone: input.timeZone,
    maxCandidates: input.maxCandidates,
    senderIsUser: input.fromMe,
    credentials: input.credentials,
    llmFeature: KAKAO_LLM_FEATURE,
  });
}

/** Everything an import made: its commitments and their queue mirrors. */
export async function deleteKakaoImportCommitments(
  userId: string,
  importId: string,
): Promise<number> {
  const rows = await prisma.commitment.findMany({
    where: { userId, sourceType: "KAKAO", threadId: kakaoImportThreadId(importId) },
    select: { id: true },
  });
  if (rows.length === 0) return 0;
  const ids = rows.map((row) => row.id);
  const { count } = await prisma.commitment.deleteMany({ where: { userId, id: { in: ids } } });
  await deleteAttentionForCommitments(ids, userId);
  return count;
}
