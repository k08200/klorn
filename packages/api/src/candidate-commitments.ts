/**
 * Candidate → Commitment hooks.
 *
 * When a recruiter advances a candidate through the intake pipeline, EVE
 * should automatically open the next promise: e.g. "Send interview
 * request to {name} within 5 business days" the moment the user marks a
 * candidate SHORTLISTED. Without this hook the candidate moves into a
 * status the recruiter has to remember themselves — which is exactly the
 * cognitive load EVE is meant to absorb.
 *
 * Status → commitment mapping (audited 2026-05-19, recruiter wedge round):
 *   CONTACTED   → "Wait for {name}'s reply" (owner: COUNTERPARTY, 7 days)
 *   SHORTLISTED → "Send interview request to {name}" (owner: USER, 5 days)
 *   REVIEWING   → "Decide on {name}" (owner: USER, 7 days)
 *
 * No commitment is opened for NEEDS_INFO / NEEDS_ANALYSIS / READY_TO_REVIEW
 * (those are still inbound work) or REJECTED / ARCHIVED (no future action).
 *
 * Dedup: the dedupKey is `candidate_intake:{candidateId}:{status}` so the
 * same transition cannot create duplicate commitments on repeat clicks.
 */

import { upsertCommitment } from "./commitments.js";

// CandidateIntake.status is a free-form string in the schema (see
// schema.prisma) so we mirror the enumerated set here. Keep this in
// sync with the schema's comment and with normalizeCandidateIntakeStatus
// in email-candidate-intake.ts.
export type CandidateIntakeStatus =
  | "NEEDS_ANALYSIS"
  | "NEEDS_INFO"
  | "READY_TO_REVIEW"
  | "REVIEWING"
  | "CONTACTED"
  | "SHORTLISTED"
  | "REJECTED"
  | "ARCHIVED";

interface CommitmentSpec {
  title: (name: string) => string;
  owner: "USER" | "COUNTERPARTY";
  dueOffsetDays: number;
  dueText: string;
}

const TRANSITIONS: Partial<Record<CandidateIntakeStatus, CommitmentSpec>> = {
  CONTACTED: {
    title: (name) => `Wait for ${name}'s reply`,
    owner: "COUNTERPARTY",
    dueOffsetDays: 7,
    dueText: "within a week",
  },
  SHORTLISTED: {
    title: (name) => `Send interview request to ${name}`,
    owner: "USER",
    dueOffsetDays: 5,
    dueText: "within 5 business days",
  },
  REVIEWING: {
    title: (name) => `Decide on ${name}`,
    owner: "USER",
    dueOffsetDays: 7,
    dueText: "within a week",
  },
};

export interface CandidateForCommitment {
  id: string;
  name: string | null;
  contactEmail: string | null;
  emailId: string;
  threadId: string | null;
}

/**
 * Open the commitment matched to `nextStatus`. No-op when the status has
 * no mapping. Best-effort: a failure logs and returns null but never
 * throws — the recruiter's status update must always succeed.
 */
export async function openCommitmentForCandidateTransition(
  userId: string,
  candidate: CandidateForCommitment,
  nextStatus: CandidateIntakeStatus,
): Promise<{ id: string } | null> {
  const spec = TRANSITIONS[nextStatus];
  if (!spec) return null;

  const displayName = candidate.name?.trim() || "this candidate";
  const dueAt = new Date(Date.now() + spec.dueOffsetDays * 24 * 60 * 60 * 1000);

  try {
    const commitment = await upsertCommitment(userId, {
      title: spec.title(displayName),
      description: `Auto-opened when candidate moved to ${nextStatus}.`,
      kind: "DELIVERABLE",
      owner: spec.owner,
      counterpartyName: candidate.name,
      counterpartyEmail: candidate.contactEmail,
      dueAt,
      dueText: spec.dueText,
      sourceType: "EMAIL",
      sourceId: candidate.emailId,
      threadId: candidate.threadId,
      confidence: 1.0,
      dedupKey: `candidate_intake:${candidate.id}:${nextStatus}`,
      evidenceText: `Candidate intake transition → ${nextStatus}`,
    });
    return { id: commitment.id };
  } catch (err) {
    console.warn(
      `[candidate-commitments] failed to open commitment for candidate=${candidate.id} status=${nextStatus}:`,
      err,
    );
    return null;
  }
}
