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

import type { LiveTier } from "@klorn/contract";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import type { EngagementKind } from "../learning/sender-policy.js";
import { captureError } from "../sentry.js";
import type { TierFeatures } from "./tier-policy.js";
import type { Tier } from "./tiers.js";

/**
 * The 4 features captured at decision time. Aliases the canonical schema in
 * tier-policy.ts so the ledger's stored vector can't drift from the scorer's.
 */
export type DecisionFeatures = TierFeatures;

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
  /**
   * Which learned-engagement grounding fed the judge, if any ("DIRECT" |
   * "PROPAGATED" | null). Rollout instrumentation for CONTACT_ENGAGEMENT_IN_JUDGE.
   */
  engagementKind?: EngagementKind | null;
  /**
   * Gmail's IMPORTANT marker on the inbox mail at this judgement (the IP24
   * baseline; gmail-important-snapshot.ts). Written only when the row is
   * created: a re-judge reads labels Gmail may have changed after the user
   * replied. Null / omitted = unknown (not Gmail mail).
   */
  gmailImportant?: boolean | null;
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
 * label always matches what the user actually saw when they acted. Only a lane
 * judgement (`outcome`) freezes it: engagement columns (openedAt, …) don't, or
 * fallback-rejudge could never repair a keyword-fallback row the user opened.
 */
export async function recordDecision(decision: DecisionInput): Promise<void> {
  const where = {
    userId_source_sourceId: {
      userId: decision.userId,
      source: decision.source,
      sourceId: decision.sourceId,
    },
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
      engagementKind: decision.engagementKind ?? null,
    };
    await prisma.decisionLabel.upsert({
      where,
      create: {
        userId: decision.userId,
        source: decision.source,
        sourceId: decision.sourceId,
        ...fields,
        gmailImportant: decision.gmailImportant ?? null,
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
 * What the user DID with an item, as opposed to an explicit lane judgement
 * (CONFIRM:/OVERRIDE:). Fixed vocabulary — each kind has its own first-wins
 * timestamp column on DecisionLabel.
 */
export const ENGAGEMENT_OUTCOMES = [
  "OPENED",
  "REPLIED",
  "ARCHIVED",
  "DISMISSED",
  "SNOOZED",
  "STARRED",
  "UNSUBSCRIBED",
] as const;
export type EngagementOutcome = (typeof ENGAGEMENT_OUTCOMES)[number];

/** An explicit lane judgement, the only kind written to `outcome`. */
export type LaneOutcome = `OVERRIDE:${LiveTier}` | `CONFIRM:${LiveTier}`;
export type DecisionOutcome = EngagementOutcome | LaneOutcome;

const ENGAGEMENT_COLUMN = {
  OPENED: "openedAt",
  REPLIED: "repliedAt",
  ARCHIVED: "archivedAt",
  DISMISSED: "dismissedAt",
  SNOOZED: "snoozedAt",
  STARRED: "starredAt",
  UNSUBSCRIBED: "unsubscribedAt",
} as const satisfies Record<EngagementOutcome, keyof Prisma.DecisionLabelWhereInput>;
type EngagementColumn = (typeof ENGAGEMENT_COLUMN)[EngagementOutcome];

const ENGAGEMENT_SET: ReadonlySet<string> = new Set(ENGAGEMENT_OUTCOMES);

function isEngagementOutcome(outcome: DecisionOutcome): outcome is EngagementOutcome {
  return ENGAGEMENT_SET.has(outcome);
}

/**
 * The where/data pair for one stamp. Engagement goes to its own column, a lane
 * judgement to `outcome`; either way only an empty slot is written, so the
 * first action of each kind wins.
 */
function stampArgs(outcome: DecisionOutcome, at: Date) {
  if (isEngagementOutcome(outcome)) {
    const column: EngagementColumn = ENGAGEMENT_COLUMN[outcome];
    return {
      unstamped: { [column]: null } as Pick<Prisma.DecisionLabelWhereInput, EngagementColumn>,
      data: { [column]: at } as Pick<Prisma.DecisionLabelUpdateManyMutationInput, EngagementColumn>,
    };
  }
  return { unstamped: { outcome: null }, data: { outcome, outcomeAt: at } };
}

/**
 * Stamp what the user did onto their ledger row. First action wins: an
 * engagement kind only fills its own empty column, and a lane judgement
 * ("OVERRIDE:<tier>" / "CONFIRM:<tier>") only fills an empty `outcome`.
 * Never throws; logs on failure.
 */
export async function stampDecisionOutcome(
  userId: string,
  source: AttentionSourceName,
  sourceId: string,
  outcome: DecisionOutcome,
): Promise<void> {
  try {
    const { unstamped, data } = stampArgs(outcome, new Date());
    // userId is part of the filter so an outcome stamp can only ever touch the
    // acting user's own ledger row — defense-in-depth against a shared sourceId.
    await prisma.decisionLabel.updateMany({
      where: { userId, source, sourceId, ...unstamped },
      data,
    });
  } catch (err) {
    logRecorderError("stamp", sourceId, err);
  }
}

/** Bulk form of stampDecisionOutcome: one query for a multi-select action. */
export async function stampDecisionOutcomes(
  userId: string,
  source: AttentionSourceName,
  sourceIds: readonly string[],
  outcome: DecisionOutcome,
): Promise<void> {
  if (sourceIds.length === 0) return;
  try {
    const { unstamped, data } = stampArgs(outcome, new Date());
    await prisma.decisionLabel.updateMany({
      where: { userId, source, sourceId: { in: [...sourceIds] }, ...unstamped },
      data,
    });
  } catch (err) {
    logRecorderError("stamp-bulk", sourceIds[0], err);
  }
}

/**
 * What the user did to a judged mail in the mail provider itself, as seen by
 * sync (mail/provider-replies.ts, mail/provider-archives.ts) rather than by a
 * Klorn route. Each kind has its own column, apart from the Klorn ones, so the
 * report can tell the two sources apart and neither overwrites the other.
 */
export type ProviderEngagement = "REPLIED" | "ARCHIVED";

const PROVIDER_COLUMN = {
  REPLIED: "providerRepliedAt",
  ARCHIVED: "providerArchivedAt",
} as const satisfies Record<ProviderEngagement, keyof Prisma.DecisionLabelWhereInput>;
type ProviderColumn = (typeof PROVIDER_COLUMN)[ProviderEngagement];

/**
 * Stamp a provider-side action at `at` on the user's EMAIL ledger rows
 * (sourceId = EmailMessage.id). First wins per column. Never before the
 * judgement (judgedAt <= at): a reply sent before Klorn judged the mail is not
 * a reaction to its lane, and a first Sent scan would otherwise stamp the
 * user's pre-Klorn replies. Never throws; logs on failure. Returns the rows
 * written (0 on failure).
 */
export async function stampProviderEngagement(
  userId: string,
  kind: ProviderEngagement,
  sourceIds: readonly string[],
  at: Date,
): Promise<number> {
  if (sourceIds.length === 0) return 0;
  const column: ProviderColumn = PROVIDER_COLUMN[kind];
  try {
    const { count } = await prisma.decisionLabel.updateMany({
      where: {
        userId,
        source: "EMAIL",
        sourceId: { in: [...sourceIds] },
        [column]: null,
        judgedAt: { lte: at },
      },
      data: { [column]: at },
    });
    return count;
  } catch (err) {
    logRecorderError(`stamp-provider-${kind.toLowerCase()}`, sourceIds[0] ?? "", err);
    return 0;
  }
}

/**
 * Stamp when Klorn's interrupt for these mails actually fired: it got past
 * every hold gate and went to the user's channels (sendPushNotification's
 * dispatchedAt). EMAIL rows only (sourceId = EmailMessage.id), scoped to the
 * user, first ring wins. The IP24 denominator (ip24.ts). Never throws; logs
 * on failure.
 */
export async function stampDecisionRang(
  userId: string,
  sourceIds: readonly string[],
  at: Date,
): Promise<void> {
  if (sourceIds.length === 0) return;
  try {
    await prisma.decisionLabel.updateMany({
      where: { userId, source: "EMAIL", sourceId: { in: [...sourceIds] }, rangAt: null },
      data: { rangAt: at },
    });
  } catch (err) {
    logRecorderError("stamp-rang", sourceIds[0] ?? "", err);
  }
}
