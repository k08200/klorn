/**
 * Commitment ledger service — CRUD around the canonical promise record.
 *
 * The ledger is the source of truth for every "내일까지 보내드릴게요" type of
 * statement Eve detects. AttentionItem only projects "currently relevant"
 * commitments via the producer in attention-mirror.ts.
 */

import type { Commitment, CommitmentKind, CommitmentOwner, CommitmentSource } from "@prisma/client";
import { deleteAttentionForCommitments, upsertAttentionForCommitment } from "./attention-mirror.js";
import { prisma } from "./db.js";

export interface CommitmentInput {
  title: string;
  description?: string | null;
  kind?: CommitmentKind;
  owner?: CommitmentOwner;
  counterpartyName?: string | null;
  counterpartyEmail?: string | null;
  contactId?: string | null;
  dueAt?: Date | null;
  dueText?: string | null;
  sourceType?: CommitmentSource;
  sourceId?: string | null;
  threadId?: string | null;
  evidenceText?: string | null;
  confidence?: number;
  dedupKey?: string | null;
}

export interface CommitmentUpdate {
  title?: string;
  description?: string | null;
  status?: "OPEN" | "DONE" | "DISMISSED" | "SNOOZED";
  kind?: CommitmentKind;
  owner?: CommitmentOwner;
  counterpartyName?: string | null;
  contactId?: string | null;
  dueAt?: Date | null;
  dueText?: string | null;
}

export async function listCommitments(
  userId: string,
  opts?: { status?: "OPEN" | "DONE" | "DISMISSED" | "SNOOZED"; limit?: number },
): Promise<Commitment[]> {
  return prisma.commitment.findMany({
    where: { userId, ...(opts?.status ? { status: opts.status } : {}) },
    orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }],
    take: opts?.limit ?? 100,
  });
}

export async function getCommitment(id: string): Promise<Commitment | null> {
  return prisma.commitment.findUnique({ where: { id } });
}

/**
 * Create or refresh a commitment, deduping by (userId, dedupKey) when a
 * dedupKey is provided. Useful for extractors that may run multiple times
 * over the same thread.
 */
export async function upsertCommitment(
  userId: string,
  input: CommitmentInput,
): Promise<Commitment> {
  let commitment: Commitment;
  if (input.dedupKey) {
    const existing = await prisma.commitment.findUnique({
      where: { userId_dedupKey: { userId, dedupKey: input.dedupKey } },
    });
    if (existing) {
      commitment = await prisma.commitment.update({
        where: { id: existing.id },
        data: {
          title: input.title,
          description: input.description ?? existing.description,
          dueAt: input.dueAt ?? existing.dueAt,
          dueText: input.dueText ?? existing.dueText,
          confidence: input.confidence ?? existing.confidence,
          evidenceText: input.evidenceText ?? existing.evidenceText,
        },
      });
      await upsertAttentionForCommitment(commitment);
      return commitment;
    }
  }
  commitment = await (prisma.commitment.create as unknown as (args: unknown) => Promise<Commitment>)({
    data: {
      userId,
      title: input.title,
      description: input.description ?? null,
      kind: input.kind ?? "DELIVERABLE",
      owner: input.owner ?? "USER",
      counterpartyName: input.counterpartyName ?? null,
      counterpartyEmail: input.counterpartyEmail ?? null,
      contactId: input.contactId ?? null,
      dueAt: input.dueAt ?? null,
      dueText: input.dueText ?? null,
      sourceType: input.sourceType ?? "EMAIL",
      sourceId: input.sourceId ?? null,
      threadId: input.threadId ?? null,
      evidenceText: input.evidenceText ?? null,
      confidence: input.confidence ?? 1.0,
      dedupKey: input.dedupKey ?? null,
    },
  });
  await upsertAttentionForCommitment(commitment);
  return commitment;
}

export async function updateCommitment(id: string, patch: CommitmentUpdate): Promise<Commitment> {
  const data: Record<string, unknown> = { ...patch };
  if (patch.status === "DONE") data.completedAt = new Date();
  const commitment = await prisma.commitment.update({ where: { id }, data });
  await upsertAttentionForCommitment(commitment);
  return commitment;
}

export async function deleteCommitment(id: string): Promise<void> {
  await prisma.commitment.delete({ where: { id } });
  await deleteAttentionForCommitments([id]);
}
