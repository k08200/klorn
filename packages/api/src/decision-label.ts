/**
 * Decision-label recorder.
 *
 * Captures the tier the firewall SHOWED the user for each classified item,
 * immutably, so it survives the in-place AttentionItem.tier overwrite that a
 * manual override performs (attention-override.ts). Without this, the pair
 * {what we showed, what the user revealed they wanted} can't be reconstructed,
 * and per-user PUSH recall / over-suppression can never be measured.
 *
 * This is the free drift tripwire complement to a held-out human audit — NOT
 * the launch gate itself (the gate needs the audit's whole-inbox denominator).
 *
 * Both functions are best-effort: they MUST NOT throw into the firewall path
 * (recording is never worth failing a classification), but they MUST log a
 * signal on failure — console (visible even when Sentry is off) plus
 * captureError. Never a silent swallow.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "./db.js";
import { captureError } from "./sentry.js";
import type { Tier } from "./tiers.js";

/** poc-judge's 4 features at decision time. */
export interface DecisionFeatures {
  confidence: number;
  senderTrust: number;
  reversibility: number;
  urgency: number;
}

export interface EmailDecision {
  userId: string;
  /** EmailMessage.id — the AttentionItem/DecisionLabel sourceId. */
  sourceId: string;
  /** The tier the firewall showed for this email. */
  shownTier: Tier;
  features: DecisionFeatures;
  /** Sender address, for per-sender recall grouping. */
  sender?: string | null;
  /** Which path decided: "fast-path" | "sender-prior" | "llm" | "keyword-fallback". */
  decidedBy?: string | null;
}

/**
 * A decision for any firewall source. EMAIL is the common case; GITHUB (and
 * any future inbound channel) records through the same ledger so per-channel
 * PUSH recall / over-suppression is measurable — not email-only.
 */
export interface DecisionInput extends EmailDecision {
  source: AttentionSourceName;
}

export type AttentionSourceName =
  | "EMAIL"
  | "PENDING_ACTION"
  | "TASK"
  | "CALENDAR_EVENT"
  | "NOTIFICATION"
  | "COMMITMENT"
  | "GITHUB";

function logRecorderError(op: string, sourceId: string, err: unknown): void {
  // console first: captureError is a no-op when Sentry is uninitialized, so a
  // bare captureError would be silent in dev / self-host. (CLAUDE.md rule.)
  console.warn(`[decision-label] ${op} failed for ${sourceId}`, err);
  captureError(err, { tags: { area: "decision-label", op }, extra: { sourceId } });
}

/**
 * Record (or refresh) the shown decision for any firewall source. One row per
 * (source, sourceId): a re-judge while the row is still OPEN refreshes the
 * shown tier/features; once an outcome is stamped the row is frozen so the
 * label always matches what the user actually saw when they acted.
 */
export async function recordDecision(decision: DecisionInput): Promise<void> {
  const where = {
    source_sourceId: { source: decision.source, sourceId: decision.sourceId },
  };
  try {
    const existing = await prisma.decisionLabel.findUnique({
      where,
      select: { outcome: true },
    });
    // Frozen: the user has already acted, so this row is ground truth — a
    // later re-judge must not rewrite the tier they were reacting to.
    if (existing?.outcome) return;

    const fields = {
      shownTier: decision.shownTier,
      // The typed feature vector is stored as JSON; Prisma's Json input type
      // wants an index signature, which the interface intentionally doesn't have.
      features: decision.features as unknown as Prisma.InputJsonValue,
      sender: decision.sender ?? null,
      decidedBy: decision.decidedBy ?? null,
    };
    await prisma.decisionLabel.upsert({
      where,
      create: {
        userId: decision.userId,
        source: decision.source,
        sourceId: decision.sourceId,
        ...fields,
      },
      update: fields,
    });
  } catch (err) {
    logRecorderError("record", decision.sourceId, err);
  }
}

/** Back-compat wrapper for the email firewall path (source = EMAIL). */
export async function recordEmailDecision(decision: EmailDecision): Promise<void> {
  await recordDecision({ ...decision, source: "EMAIL" });
}

/**
 * Stamp the user's eventual outcome onto the open ledger row. First action
 * wins (only rows with a null outcome are touched), so the earliest signal is
 * the user's ground truth. `outcome` is "OVERRIDE:<tier>" for a manual tier
 * move, or a terminal status (e.g. "DISMISSED", "OPENED").
 */
export async function stampDecisionOutcome(
  source: AttentionSourceName,
  sourceId: string,
  outcome: string,
): Promise<void> {
  try {
    await prisma.decisionLabel.updateMany({
      where: { source, sourceId, outcome: null },
      data: { outcome, outcomeAt: new Date() },
    });
  } catch (err) {
    logRecorderError("stamp", sourceId, err);
  }
}
