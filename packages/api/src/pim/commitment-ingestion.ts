/**
 * Ingestion bridge for the Commitment Ledger.
 *
 * Step 3-B intentionally stays rule-based: extract commitment-shaped
 * candidates from newly ingested text and write low-confidence ledger rows.
 * The later LLM pass can refine title/kind/dueAt, but dogfooding needs the
 * signal to start flowing first.
 */

import { createHash } from "node:crypto";
import type { CommitmentKind, CommitmentSource } from "@prisma/client";
import { prisma } from "../db.js";
import { isAutomatedSender } from "../judge/keyword-policy.js";
import { type CommitmentCandidate, extractCommitmentCandidates } from "./commitment-extractor.js";
import {
  type CommitmentRefinement,
  maybeRefineCommitmentCandidateWithLlm,
} from "./commitment-refiner.js";
import { type CommitmentInput, upsertCommitment } from "./commitments.js";

const TITLE_MAX_LEN = 120;
const HASH_LEN = 16;

export interface CommitmentIngestionInput {
  userId: string;
  sourceType: CommitmentSource;
  sourceId: string;
  threadId?: string | null;
  text: string;
  contextTitle?: string | null;
  referenceDate?: Date;
  timeZone?: string;
  maxCandidates?: number;
  senderEmail?: string | null; // email source: set to From address; used for trust score
  senderIsUser?: boolean; // email source: true when the user authored the message themselves
  listUnsubscribe?: boolean; // email source: true when the mail carried a List-Unsubscribe header
}

export interface CommitmentIngestionResult {
  candidatesFound: number;
  commitmentsCreated: number;
  duplicatesSkipped: number;
}

function normalizeForHash(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function hashText(value: string): string {
  return createHash("sha256").update(normalizeForHash(value)).digest("hex").slice(0, HASH_LEN);
}

function buildDedupKey(input: CommitmentIngestionInput, candidate: CommitmentCandidate): string {
  const scope = input.threadId || input.sourceId;
  return `${input.sourceType.toLowerCase()}:${scope}:${hashText(candidate.text)}`;
}

function compactText(value: string, max = TITLE_MAX_LEN): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function kindForCandidate(candidate: CommitmentCandidate): CommitmentKind {
  const text = candidate.text.toLowerCase();
  if (/회신|연락|follow up|get back|reply|respond/.test(text)) return "FOLLOW_UP";
  if (/회의|미팅|논의|meeting|discuss|sync/.test(text)) return "MEETING";
  if (/검토|review/.test(text)) return "REVIEW";
  if (/결정|decide|decision/.test(text)) return "DECISION";
  return "DELIVERABLE";
}

function confidenceForCandidate(candidate: CommitmentCandidate): number {
  // Keep rule-based rows deliberately below LLM/explicit-user confidence.
  // Rows without parsed dueAt become COMMITMENT_UNCONFIRMED in the queue.
  return candidate.dueHint ? 0.55 : 0.45;
}

/**
 * EMAIL text is written by the SENDER: a first-person promise in a received
 * email ("I'll push it back to them now") is the sender's commitment, not the
 * user's — the rule extractor's USER owner is a perspective it cannot know.
 * Only when the user authored the message themselves (senderIsUser) does
 * first-person mean the user. Non-email sources (chat, notes) are the user's
 * own voice, so the candidate owner stands.
 */
function ownerForCandidate(
  input: CommitmentIngestionInput,
  candidate: CommitmentCandidate,
): CommitmentInput["owner"] {
  if (input.sourceType === "EMAIL" && candidate.owner === "USER" && input.senderIsUser !== true) {
    return "COUNTERPARTY";
  }
  return candidate.owner;
}

function buildCommitmentInput(
  input: CommitmentIngestionInput,
  candidate: CommitmentCandidate,
  refinement: CommitmentRefinement | null,
  dedupKey: string,
): CommitmentInput {
  const owner = refinement?.owner ?? ownerForCandidate(input, candidate);
  return {
    title: compactText(refinement?.title ?? candidate.text),
    description: input.contextTitle ? compactText(input.contextTitle, 180) : null,
    kind: refinement?.kind ?? kindForCandidate(candidate),
    owner,
    counterpartyName: refinement?.counterpartyName ?? null,
    // Set counterpartyEmail from the email sender when the counterparty owns the commitment
    counterpartyEmail: owner === "COUNTERPARTY" ? (input.senderEmail ?? null) : null,
    dueAt: refinement?.dueAt ?? null,
    dueText: refinement?.dueText ?? candidate.dueHint,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    threadId: input.threadId ?? null,
    evidenceText: compactText(candidate.text, 500),
    confidence: refinement?.confidence ?? confidenceForCandidate(candidate),
    dedupKey,
  };
}

/**
 * Extract commitment candidates from a source text and upsert them into the
 * ledger. This function is idempotent for a given (source/thread, candidate)
 * because the dedupKey is deterministic.
 */
export async function extractAndUpsertCommitmentsFromText(
  input: CommitmentIngestionInput,
): Promise<CommitmentIngestionResult> {
  // Automated mail doesn't make interpersonal commitments — its "X will
  // deliver/arrive" / "You will not be allowed…" text would otherwise be mined
  // into a fake ledger commitment. Gate on every automated signal we have:
  // no-reply + logistics role + system-notification senders (isAutomatedSender)
  // and the List-Unsubscribe bulk-mail header. Founder decision 2026-07-22:
  // this deliberately REVERSES the earlier carve-out that spared notifications@
  // (GitHub/Jira/Linear relays) — after the appointment-notice leak, keeping
  // automated noise off the ledger outweighs relayed third-party promises.
  if (input.listUnsubscribe === true) {
    return { candidatesFound: 0, commitmentsCreated: 0, duplicatesSkipped: 0 };
  }
  if (input.senderEmail && isAutomatedSender(input.senderEmail)) {
    return { candidatesFound: 0, commitmentsCreated: 0, duplicatesSkipped: 0 };
  }
  const candidates = extractCommitmentCandidates(input.text, {
    maxCandidates: input.maxCandidates ?? 5,
  });

  let commitmentsCreated = 0;
  let duplicatesSkipped = 0;

  for (const candidate of candidates) {
    const refinement = await maybeRefineCommitmentCandidateWithLlm({
      candidate,
      sourceType: input.sourceType,
      sourceText: input.text,
      contextTitle: input.contextTitle,
      referenceDate: input.referenceDate,
      timeZone: input.timeZone,
      userId: input.userId,
    });
    if (refinement?.isCommitment === false) continue;
    const usableRefinement = refinement?.isCommitment === true ? refinement : null;

    const dedupKey = buildDedupKey(input, candidate);
    const existing = await prisma.commitment.findUnique({
      where: { userId_dedupKey: { userId: input.userId, dedupKey } },
      select: { id: true },
    });

    await upsertCommitment(
      input.userId,
      buildCommitmentInput(input, candidate, usableRefinement, dedupKey),
    );

    if (existing) duplicatesSkipped++;
    else commitmentsCreated++;
  }

  return {
    candidatesFound: candidates.length,
    commitmentsCreated,
    duplicatesSkipped,
  };
}
