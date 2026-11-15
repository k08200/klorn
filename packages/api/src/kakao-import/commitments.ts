/**
 * Commitments from an imported KakaoTalk chat (docs/providers/kakaotalk-import.md
 * §4): the existing ledger ingestion with sourceType KAKAO. Always suggested,
 * never confirmed on its own (capped below the 0.7 line in
 * pim/commitment-ingestion.ts, like Slack). Every derived row carries the
 * threadId of the latest import whose messages produced it, so deleting that
 * import deletes it, and the orphan sweep deletes what a deleted import left.
 */

import { createHash } from "node:crypto";
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
const KAKAO_THREAD_PREFIX = "kakao-import:";
const MINUTE_MS = 60_000;
const IDENTITY_HEX_LEN = 32;

export function kakaoImportThreadId(importId: string): string {
  return `${KAKAO_THREAD_PREFIX}${importId}`;
}

function identityPart(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * One chat message's identity for one user, whichever upload carried it: who
 * said it, in which minute (a PC .csv export has seconds, a .txt export does
 * not) and what, as one digest that also covers the user's id (two people
 * holding the same chat get unrelated digests). Two uploads of the same chat
 * give a message the same identity, so the ledger's dedup key folds a
 * re-import onto the commitments already made. Only the digest is kept, never
 * the words or the name.
 */
export function kakaoMessageIdentity(
  userId: string,
  message: { readonly speaker: string; readonly sentAt: Date; readonly text: string },
): string {
  const minute = Math.floor(message.sentAt.getTime() / MINUTE_MS);
  const digest = createHash("sha256")
    .update(`${userId}\n${identityPart(message.speaker)}\n${minute}\n`)
    .update(identityPart(message.text))
    .digest("hex")
    .slice(0, IDENTITY_HEX_LEN);
  return `kakao-message:${digest}`;
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
    // same message dedups, and so does the same message in a later upload of
    // the chat: the row moves to that upload (threadId) and keeps everything
    // else, user edits included, with no LLM call.
    dedupScope: kakaoMessageIdentity(input.userId, input),
    onDuplicate: "reattach",
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

/**
 * Delete what imports that no longer exist made. "Delete this import" deletes
 * an import's commitments before its row, and a processing pass that finds
 * its import gone deletes what it made; but a pass that dies after writing a
 * commitment and before it notices the deletion leaves that commitment with
 * no import to claim it. Runs with the retention purge (scheduler.ts) whatever
 * KAKAO_IMPORT_ENABLED says. Idempotent: a second run finds nothing to delete.
 */
export async function sweepOrphanKakaoCommitments(): Promise<{
  imports: number;
  commitments: number;
}> {
  const threads = await prisma.commitment.groupBy({
    by: ["userId", "threadId"],
    where: { sourceType: "KAKAO", threadId: { startsWith: KAKAO_THREAD_PREFIX } },
  });
  if (threads.length === 0) return { imports: 0, commitments: 0 };
  const owned = threads.map(({ userId, threadId }) => ({
    userId,
    importId: (threadId ?? "").slice(KAKAO_THREAD_PREFIX.length),
  }));
  const live = await prisma.kakaoImport.findMany({
    where: { id: { in: [...new Set(owned.map((row) => row.importId))] } },
    select: { id: true },
  });
  const liveIds = new Set(live.map((row) => row.id));
  const orphans = owned.filter((row) => !liveIds.has(row.importId));
  let commitments = 0;
  for (const orphan of orphans) {
    commitments += await deleteKakaoImportCommitments(orphan.userId, orphan.importId);
  }
  return { imports: orphans.length, commitments };
}
