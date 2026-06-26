import { prisma } from "./db.js";
import type { CandidateTrait } from "./sender-trait-policy.js";

export interface IncumbentTrait {
  factValue: string;
  observedCount: number;
  status: "active" | "superseded" | "conflicted";
}

export type UpsertAction =
  | { type: "create"; sourceSig: string }
  | { type: "strengthen"; observedCount: number; sourceSig: string }
  | { type: "conflict"; keepValue: string; conflictValue: string };

/**
 * Pure conflict resolver. Never silently overwrites: a contradicting value
 * flips the row to `conflicted`, keeps the incumbent value, and stashes the
 * challenger (the AutoBE detectDecisionConflicts pattern). Resolution (who
 * wins) is deferred to the fast-follow.
 */
export function resolveTraitUpsert(
  incumbent: IncumbentTrait | null,
  challenger: CandidateTrait,
  sourceSig: string,
): UpsertAction {
  if (incumbent === null) return { type: "create", sourceSig };
  if (incumbent.factValue === challenger.factValue) {
    return { type: "strengthen", observedCount: incumbent.observedCount + 1, sourceSig };
  }
  return { type: "conflict", keepValue: incumbent.factValue, conflictValue: challenger.factValue };
}

/**
 * Apply one candidate trait for (userId, sender, kind). The read-decide-write is
 * wrapped in a transaction so it is atomic: a concurrent run (e.g. a leaked
 * scheduler lock + a manual extraction) cannot both read "no incumbent" and
 * both create — the unique constraint would otherwise reject the second write
 * and mark an innocent sender as failed.
 */
export async function upsertSenderTrait(props: {
  userId: string;
  sender: string;
  candidate: CandidateTrait;
  sourceSig: string;
}): Promise<UpsertAction["type"]> {
  const { userId, sender, candidate, sourceSig } = props;
  return prisma.$transaction(async (tx) => {
    const existing = await tx.senderTrait.findUnique({
      where: {
        userId_sender_factKind: { userId, sender, factKind: candidate.factKind },
      },
    });

    const action = resolveTraitUpsert(
      existing
        ? { factValue: existing.factValue, observedCount: existing.observedCount, status: existing.status }
        : null,
      candidate,
      sourceSig,
    );

    if (action.type === "create") {
      await tx.senderTrait.create({
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
      await tx.senderTrait.update({
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
      await tx.senderTrait.update({
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
  });
}
