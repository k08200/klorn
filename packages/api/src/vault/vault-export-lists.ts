/**
 * Klorn Vault: the sender notes and the commitment lists (vault-export.ts runs
 * them after the mail notes). Every query is scoped to the exporting user;
 * links point only at notes this export emitted (vault-export-state.ts).
 */

import type { CommitmentStatus, SenderTraitStatus } from "@prisma/client";
import { prisma } from "../db.js";
import { validateTraitValue } from "../learning/sender-trait-policy.js";
import { isConfirmedCommitment } from "../pim/commitment-confirmation.js";
import { appendTo, type Emit, type ExportState } from "./vault-export-state.js";
import { renderSenderNote, type VaultCommitment, type VaultTrait } from "./vault-index-notes.js";
import { localDate } from "./vault-mail-rows.js";
import type { VaultMailRef } from "./vault-notes.js";
import { senderKeyOf, senderNotePath } from "./vault-paths.js";

const TRAIT_STATUSES: SenderTraitStatus[] = ["active", "conflicted"];
const ACTIVE_COMMITMENT_STATUSES: CommitmentStatus[] = ["OPEN", "SNOOZED"];
const DONE_COMMITMENT_STATUSES: CommitmentStatus[] = ["DONE", "DISMISSED"];

const TRAIT_SELECT = {
  sender: true,
  factKind: true,
  factValue: true,
  confidence: true,
  observedCount: true,
  evidenceText: true,
  status: true,
} as const;

const COMMITMENT_SELECT = {
  id: true,
  title: true,
  status: true,
  owner: true,
  counterpartyName: true,
  counterpartyEmail: true,
  dueAt: true,
  dueText: true,
  sourceType: true,
  sourceId: true,
  threadId: true,
  confidence: true,
  confirmedAt: true,
  completedAt: true,
} as const;

async function loadTraits(state: ExportState): Promise<Map<string, VaultTrait[]>> {
  const { userId, limits } = state.input;
  const rows = await prisma.senderTrait.findMany({
    where: { userId, status: { in: TRAIT_STATUSES } },
    orderBy: { lastSeenAt: "desc" },
    take: limits.maxSenderTraits + 1,
    select: TRAIT_SELECT,
  });
  if (rows.length > limits.maxSenderTraits) state.partial.senderTraits = true;
  const traitsBy = new Map<string, VaultTrait[]>();
  for (const row of rows.slice(0, limits.maxSenderTraits)) {
    // Defense in depth: only a value the policy allows is exported.
    const value = validateTraitValue(row.factKind, row.factValue);
    if (!value) continue;
    appendTo(traitsBy, senderKeyOf(row.sender), {
      address: row.sender,
      kind: row.factKind,
      value,
      confidence: row.confidence,
      observedCount: row.observedCount,
      status: row.status,
      evidence: row.evidenceText,
    });
  }
  return traitsBy;
}

/** One note per sender of an emitted mail or with something Klorn learned. Returns the count. */
export async function* senderNotes(state: ExportState, emit: Emit): AsyncGenerator<Buffer, number> {
  const traitsBy = await loadTraits(state);
  const refsBy = new Map<string, VaultMailRef[]>();
  for (const ref of state.refs) appendTo(refsBy, ref.senderKey, ref);

  const keys = [...new Set([...refsBy.keys(), ...traitsBy.keys()])].sort();
  for (const key of keys) {
    const path = senderNotePath(key, state.paths);
    const note = renderSenderNote({
      key,
      path,
      mails: refsBy.get(key) ?? [],
      traits: traitsBy.get(key) ?? [],
    });
    yield emit(path, note);
    state.senderPathByKey.set(key, path);
  }
  return keys.length;
}

type CommitmentRow = Awaited<
  ReturnType<typeof prisma.commitment.findMany<{ select: typeof COMMITMENT_SELECT }>>
>[number];

/** [active (open, snoozed), done (done, dismissed)], each capped. */
export async function loadCommitments(
  state: ExportState,
): Promise<[VaultCommitment[], VaultCommitment[]]> {
  const { userId, limits } = state.input;
  const [active, done] = await Promise.all([
    prisma.commitment.findMany({
      where: { userId, status: { in: ACTIVE_COMMITMENT_STATUSES } },
      orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
      take: limits.maxCommitments + 1,
      select: COMMITMENT_SELECT,
    }),
    prisma.commitment.findMany({
      where: { userId, status: { in: DONE_COMMITMENT_STATUSES } },
      orderBy: [{ updatedAt: "desc" }],
      take: limits.maxCommitments + 1,
      select: COMMITMENT_SELECT,
    }),
  ]);
  if (active.length > limits.maxCommitments || done.length > limits.maxCommitments) {
    state.partial.commitments = true;
  }
  const shape = (rows: CommitmentRow[]) =>
    rows.slice(0, limits.maxCommitments).map((c) => toCommitment(state, c));
  return [shape(active), shape(done)];
}

function toCommitment(state: ExportState, c: CommitmentRow): VaultCommitment {
  const { timeZone } = state.input;
  const fromMail = c.sourceType === "EMAIL";
  const sourcePath =
    (fromMail && c.sourceId ? state.pathByGmailId.get(c.sourceId) : undefined) ??
    (fromMail && c.threadId ? state.pathByThread.get(c.threadId) : undefined) ??
    null;
  const email = c.counterpartyEmail?.trim() || null;
  return {
    id: c.id,
    title: c.title,
    status: c.status,
    owner: c.owner,
    counterparty: c.counterpartyName?.trim() || email,
    counterpartyPath: email ? (state.senderPathByKey.get(senderKeyOf(email)) ?? null) : null,
    due: c.dueAt ? localDate(c.dueAt, timeZone) : null,
    dueText: c.dueText,
    sourcePath,
    sourceSubject: sourcePath ? (state.subjectByPath.get(sourcePath) ?? null) : null,
    confirmedAt: c.confirmedAt ? localDate(c.confirmedAt, timeZone) : null,
    completedAt: c.completedAt ? localDate(c.completedAt, timeZone) : null,
    suggested: !isConfirmedCommitment(c),
  };
}
