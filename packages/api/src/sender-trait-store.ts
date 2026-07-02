import { prisma } from "./db.js";
import type { CandidateTrait } from "./sender-trait-policy.js";

export interface IncumbentTrait {
  factValue: string;
  observedCount: number;
  status: "active" | "superseded" | "conflicted";
  /** Signature of the sample that last produced this trait, if recorded. */
  sourceSig?: string | null;
}

export type UpsertAction =
  | { type: "create"; sourceSig: string }
  | { type: "strengthen"; observedCount: number; sourceSig: string }
  | { type: "unchanged" }
  | { type: "conflict"; keepValue: string; conflictValue: string };

/**
 * Pure conflict resolver. Never silently overwrites: a contradicting value
 * flips the row to `conflicted`, keeps the incumbent value, and stashes the
 * challenger (the AutoBE detectDecisionConflicts pattern). Resolution (who
 * wins) is deferred to the fast-follow.
 *
 * Idempotency: when the incumbent value AND its recorded sourceSig both match,
 * the evidence is unchanged since the last run — a no-op, so re-processing the
 * same sample never re-increments observedCount.
 */
export function resolveTraitUpsert(
  incumbent: IncumbentTrait | null,
  challenger: CandidateTrait,
  sourceSig: string,
): UpsertAction {
  if (incumbent === null) return { type: "create", sourceSig };
  if (incumbent.factValue === challenger.factValue) {
    if (incumbent.sourceSig != null && incumbent.sourceSig === sourceSig) {
      return { type: "unchanged" };
    }
    return { type: "strengthen", observedCount: incumbent.observedCount + 1, sourceSig };
  }
  return { type: "conflict", keepValue: incumbent.factValue, conflictValue: challenger.factValue };
}

/**
 * Apply one candidate trait for (userId, sender, kind). Reads the incumbent,
 * resolves, and writes. Transactional via a single create/update per call.
 */
export async function upsertSenderTrait(props: {
  userId: string;
  sender: string;
  candidate: CandidateTrait;
  sourceSig: string;
}): Promise<UpsertAction["type"]> {
  const { userId, sender, candidate, sourceSig } = props;
  const existing = await prisma.senderTrait.findUnique({
    where: {
      userId_sender_factKind: { userId, sender, factKind: candidate.factKind },
    },
  });

  const action = resolveTraitUpsert(
    existing
      ? {
          factValue: existing.factValue,
          observedCount: existing.observedCount,
          status: existing.status,
          sourceSig: existing.sourceSig,
        }
      : null,
    candidate,
    sourceSig,
  );

  if (action.type === "unchanged") {
    // Same value, same sample signature — nothing to write. This is the
    // idempotency guard that stops repeat runs inflating observedCount.
    return action.type;
  }

  if (action.type === "create") {
    await prisma.senderTrait.create({
      data: {
        userId,
        sender,
        factKind: candidate.factKind,
        factValue: candidate.factValue,
        confidence: candidate.confidence,
        evidenceText: candidate.evidenceText,
        sourceSig,
      },
    });
  } else if (action.type === "strengthen") {
    await prisma.senderTrait.update({
      where: { userId_sender_factKind: { userId, sender, factKind: candidate.factKind } },
      data: {
        observedCount: action.observedCount,
        sourceSig,
        evidenceText: candidate.evidenceText,
        confidence: candidate.confidence,
        lastSeenAt: new Date(),
        status: "active",
      },
    });
  } else {
    await prisma.senderTrait.update({
      where: { userId_sender_factKind: { userId, sender, factKind: candidate.factKind } },
      data: {
        status: "conflicted",
        conflictValue: action.conflictValue,
        conflictEvidence: candidate.evidenceText,
        conflictedAt: new Date(),
        lastSeenAt: new Date(),
      },
    });
  }
  return action.type;
}
