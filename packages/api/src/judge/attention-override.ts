/**
 * Manual tier override — shared by the firewall API and the Telegram
 * webhook's inline buttons so the ground-truth convention can't fork.
 *
 * Override stamps tierReason as 'Manual override — user moved to X' (display)
 * AND sets isManualOverride: true (the actual trust signal — this is the only
 * call site allowed to set it, GHSA-cxc5-fmqv-pxv6) so the row is identifiable
 * as a human-labelled ground-truth example for poc-judge (Day 7 bar = 80%
 * agreement between auto-tier and user-override-tier).
 */

import { randomUUID } from "node:crypto";
import type { LiveTier } from "@klorn/contract";
import { Prisma } from "@prisma/client";
import { keyboardTriageEnabled } from "../config.js";
import { prisma } from "../db.js";
import { CLEAR_AGENT_TIER } from "./agent-tier.js";
import type { AttentionSourceName } from "./decision-label.js";
import { manualOverrideReason, normalizeTier, type Tier, toLiveTier } from "./tiers.js";

/** Handle for reversing an override. Present only while KEYBOARD_TRIAGE is on. */
export interface AttentionOverrideUndoHandle {
  token: string;
  /** ISO time after which the server refuses the undo. */
  expiresAt: string;
}

export type AttentionOverrideResult =
  | { ok: true; tier: Tier; undo?: AttentionOverrideUndoHandle }
  // "conflict" only from a reversible override: the row kept changing under it.
  | { ok: false; reason: "not_found" | "conflict" };

export interface AttentionOverrideOptions {
  /**
   * Record an undo snapshot and return an undo handle (needs KEYBOARD_TRIAGE).
   * Only the web's own lane routes ask. Telegram buttons, the notification
   * capability link and Gmail label correction have no undo affordance, so they
   * leave it off and never write a snapshot.
   */
  reversible?: boolean;
}

/** `data` fragment: drop any undo snapshot. Json columns need DbNull for SQL NULL. */
export const CLEAR_OVERRIDE_UNDO = {
  overrideUndoToken: null,
  overrideUndo: Prisma.DbNull,
} as const;

/** How often a reversible override re-reads when the row changed under it. */
const OVERRIDE_ATTEMPTS = 3;
export type AttentionConfirmResult = { ok: true; tier: Tier } | { ok: false; reason: "not_found" };

/** Apply a manual tier override to an attention item the user owns. */
export async function overrideAttentionTier(
  userId: string,
  itemId: string,
  tier: Tier,
  options: AttentionOverrideOptions = {},
): Promise<AttentionOverrideResult> {
  // With KEYBOARD_TRIAGE off this function reads and writes exactly what it did
  // before the flag existed, whatever the caller asks.
  const flagOn = keyboardTriageEnabled();
  const reversible = flagOn && options.reversible === true;
  if (!reversible) return applyOverride(userId, itemId, tier, false, flagOn);

  // A reversible override snapshots the row it read, so the write is guarded on
  // that row still being there (see applyOverride). If another write got in
  // between, read again: the snapshot must describe what THIS override replaces.
  for (let attempt = 1; attempt <= OVERRIDE_ATTEMPTS; attempt += 1) {
    try {
      return await applyOverride(userId, itemId, tier, true, flagOn);
    } catch (err) {
      if (!isRecordNotFound(err)) throw err;
    }
  }
  return { ok: false, reason: "conflict" };
}

async function applyOverride(
  userId: string,
  itemId: string,
  tier: Tier,
  reversible: boolean,
  flagOn: boolean,
): Promise<AttentionOverrideResult> {
  // Ownership check before mutating
  const existing = await (
    prisma.attentionItem as unknown as {
      findFirst: (args: unknown) => Promise<OverridePriorRow | null>;
    }
  ).findFirst({
    where: { id: itemId, userId },
    select: reversible
      ? { id: true, source: true, sourceId: true, ...OVERRIDE_PRIOR_SELECT }
      : { id: true, source: true, sourceId: true },
  });

  if (!existing) return { ok: false, reason: "not_found" };

  // One instant for the ledger stamp and the snapshot: the undo recognises the
  // stamp THIS override wrote by its exact outcomeAt.
  const at = new Date();
  const undoToken = reversible ? randomUUID() : null;
  // Reversible: record what is being replaced. Not reversible, flag on: this
  // override still supersedes any earlier reversible one on the row, so its
  // token and snapshot go (otherwise a same-lane move from Telegram would leave
  // the web's older token able to undo it). Flag off: the columns are untouched.
  const undoData = undoToken
    ? { overrideUndoToken: undoToken, overrideUndo: snapshotOf(existing, tier, undoToken, at) }
    : flagOn
      ? CLEAR_OVERRIDE_UNDO
      : {};
  // Optimistic guard for the reversible path: two quick overrides must not both
  // snapshot the same prior row (the second undo would then drop the row to
  // the judge's state while the first override's stamp stayed on the ledger).
  // The loser's update throws P2025, the batch rolls back, and the caller
  // re-reads.
  const where =
    reversible && existing.updatedAt
      ? { id: itemId, updatedAt: existing.updatedAt }
      : { id: itemId };

  // Atomic: the visible tier write and the ground-truth ledger stamp land in ONE
  // transaction. Previously they were two separate awaits — a crash or DB blip
  // between them left AttentionItem.tier corrected but DecisionLabel.outcome
  // null, silently dropping the override from every recall/over-suppression/
  // proposal metric. That undercount grows with volume and skews all downstream
  // numbers optimistically. Now either both land or neither does; a non-EMAIL
  // source simply matches 0 ledger rows (not an error) and commits cleanly. A
  // stamp failure now rolls back the tier write and surfaces (caller retries)
  // rather than being swallowed into a silent ledger loss.
  //
  // BATCH form, not the interactive callback, deliberately: an interactive
  // $transaction must acquire a DEDICATED connection within Prisma's maxWait
  // (default 2s). On the small prod pool, concurrent firewall/sync reads hold
  // every connection for seconds, so every override died with P2028 → HTTP 500
  // while plain queries (which queue up to the 10s pool timeout) survived
  // (prod outage, 2026-07-16). The two writes don't depend on each other's
  // results, so the batch form gives the same atomicity while queueing for a
  // connection like any other query.
  await prisma.$transaction([
    prisma.attentionItem.update({
      where,
      // manualOverrideReason keeps the MANUAL_OVERRIDE_PREFIX marker that
      // judge-context.ts mines from ever drifting. isManualOverride is the
      // actual trust boundary (GHSA-cxc5-fmqv-pxv6) — this is the only call
      // site in the codebase allowed to set it true.
      // CLEAR_AGENT_TIER: the tier is now human-authored, so an MCP agent's stamp
      // (step A2b) must not survive on it.
      data: {
        tier,
        tierReason: manualOverrideReason(tier),
        isManualOverride: true,
        ...CLEAR_AGENT_TIER,
        ...undoData,
      },
    }),
    prisma.decisionLabel.updateMany({
      // userId scopes the stamp to the acting user's own row; outcome:null makes
      // the first action win (only an unstamped row is touched).
      where: {
        userId,
        source: existing.source as AttentionSourceName,
        sourceId: existing.sourceId,
        outcome: null,
      },
      data: { outcome: `OVERRIDE:${tier}`, outcomeAt: at },
    }),
  ]);

  if (!undoToken) return { ok: true, tier };
  return {
    ok: true,
    tier,
    undo: {
      token: undoToken,
      expiresAt: new Date(at.getTime() + OVERRIDE_UNDO_WINDOW_MS).toISOString(),
    },
  };
}

/**
 * How long after an override the server will still reverse it. The client
 * shows its undo affordance for 6s; the rest is slack for a slow round trip.
 * Kept short on purpose: every second an override stays reversible is a second
 * in which the judge may already have learned from it (see the note on
 * undoAttentionOverride).
 */
export const OVERRIDE_UNDO_WINDOW_MS = 30_000;

/** The columns an override replaces, read before it writes. */
const OVERRIDE_PRIOR_SELECT = {
  tier: true,
  tierReason: true,
  isManualOverride: true,
  agentTierSetAt: true,
  agentTierKeyId: true,
  updatedAt: true,
} as const;

interface OverridePriorRow {
  id: string;
  source: string;
  sourceId: string;
  tier?: string | null;
  tierReason?: string | null;
  isManualOverride?: boolean;
  agentTierSetAt?: Date | null;
  agentTierKeyId?: string | null;
  updatedAt?: Date;
}

/**
 * What an override replaced, stored on the row (AttentionItem.overrideUndo).
 * Server-written and server-read only: a client supplies nothing but the
 * token, so it can never choose what an undo restores (in particular it cannot
 * set isManualOverride, the human ground-truth boundary, GHSA-cxc5-fmqv-pxv6).
 */
type OverrideUndoSnapshot = {
  token: string;
  /** Override time = the outcomeAt this override stamped on the ledger. */
  at: string;
  appliedTier: string;
  prevTier: string | null;
  prevTierReason: string | null;
  prevIsManualOverride: boolean;
  prevAgentTierSetAt: string | null;
  prevAgentTierKeyId: string | null;
  prevUpdatedAt: string;
  /** Set once the undo ran, with the lane it restored, for idempotent replays. */
  undoneAt?: string;
  restoredTier?: LiveTier | null;
};

function snapshotOf(
  prior: OverridePriorRow,
  appliedTier: Tier,
  token: string,
  at: Date,
): OverrideUndoSnapshot {
  return {
    token,
    at: at.toISOString(),
    appliedTier,
    prevTier: prior.tier ?? null,
    prevTierReason: prior.tierReason ?? null,
    prevIsManualOverride: prior.isManualOverride === true,
    prevAgentTierSetAt: prior.agentTierSetAt?.toISOString() ?? null,
    prevAgentTierKeyId: prior.agentTierKeyId ?? null,
    prevUpdatedAt: (prior.updatedAt ?? at).toISOString(),
  };
}

const isNullableString = (v: unknown): v is string | null => v === null || typeof v === "string";
const isIsoDate = (v: unknown): v is string =>
  typeof v === "string" && !Number.isNaN(Date.parse(v));

/** Validate the stored JSON; anything malformed reads as "no snapshot". */
function parseSnapshot(value: unknown): OverrideUndoSnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const valid =
    typeof v.token === "string" &&
    isIsoDate(v.at) &&
    typeof v.appliedTier === "string" &&
    isNullableString(v.prevTier) &&
    isNullableString(v.prevTierReason) &&
    typeof v.prevIsManualOverride === "boolean" &&
    (v.prevAgentTierSetAt === null || isIsoDate(v.prevAgentTierSetAt)) &&
    isNullableString(v.prevAgentTierKeyId) &&
    isIsoDate(v.prevUpdatedAt);
  return valid ? (v as unknown as OverrideUndoSnapshot) : null;
}

export type AttentionUndoResult =
  | { ok: true; tier: LiveTier | null; alreadyUndone: boolean }
  | { ok: false; reason: "not_found" | "expired" | "conflict" };

interface UndoCandidateRow {
  id: string;
  source: string;
  sourceId: string;
  tier: string | null;
  isManualOverride: boolean;
  overrideUndoToken: string | null;
  overrideUndo: unknown;
}

async function readUndoCandidate(userId: string, itemId: string): Promise<UndoCandidateRow | null> {
  return (
    prisma.attentionItem as unknown as {
      findFirst: (args: unknown) => Promise<UndoCandidateRow | null>;
    }
  ).findFirst({
    where: { id: itemId, userId },
    select: {
      id: true,
      source: true,
      sourceId: true,
      tier: true,
      isManualOverride: true,
      overrideUndoToken: true,
      overrideUndo: true,
    },
  });
}

/** A completed undo answering its own token again: report it, change nothing. */
function replayOf(
  snapshot: OverrideUndoSnapshot | null,
  token: string,
): AttentionUndoResult | null {
  if (!snapshot || snapshot.token !== token || !snapshot.undoneAt) return null;
  return { ok: true, tier: snapshot.restoredTier ?? null, alreadyUndone: true };
}

const isRecordNotFound = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2025";

/**
 * Reverse the user's most recent manual override on an item, as if it never
 * happened: the lane, its reason, isManualOverride, any agent stamp and
 * updatedAt go back to what the override replaced, and the decision-ledger
 * stamp that override wrote is removed (so first-stamp-wins is open again).
 *
 * The sender prior needs no write of its own: it is derived at judge time from
 * isManualOverride + updatedAt on these rows (judge-context.buildPrior), so
 * restoring them IS the demotion, including when this override was the second
 * identical one that promoted the prior.
 *
 * Refusals:
 *  - not_found: no such item for this user.
 *  - conflict: the token is not the row's current one (a later override
 *    replaced it, or nothing was recorded), or the row no longer holds what the
 *    override wrote (the judge re-decided it). Nothing is changed.
 *  - expired: past OVERRIDE_UNDO_WINDOW_MS.
 *
 * Idempotent: repeating a completed undo returns ok with alreadyUndone.
 *
 * The row is restored with a guarded `update` (unique id + the override's own
 * token, lane and manual flag) in the same BATCH transaction as the ledger
 * write: if the row changed after the check above, the update throws P2025 and
 * the ledger write rolls back with it, so there is never a half-undo. Batch
 * form for the reason given in overrideAttentionTier.
 *
 * A retired lane is never written back: a legacy AUTO / CALL row is restored
 * folded (toLiveTier), the same fold every read applies.
 *
 * What an undo cannot take back: mail from the same sender that the judge
 * classified while the override stood. The window is short to keep that rare.
 */
export async function undoAttentionOverride(
  userId: string,
  itemId: string,
  token: string,
): Promise<AttentionUndoResult> {
  const existing = await readUndoCandidate(userId, itemId);
  if (!existing) return { ok: false, reason: "not_found" };

  const snapshot = parseSnapshot(existing.overrideUndo);
  if (!snapshot || snapshot.token !== token) return { ok: false, reason: "conflict" };
  const replay = replayOf(snapshot, token);
  if (replay) return replay;

  const now = new Date();
  if (now.getTime() - Date.parse(snapshot.at) > OVERRIDE_UNDO_WINDOW_MS) {
    return { ok: false, reason: "expired" };
  }
  const stillOurs =
    existing.overrideUndoToken === token &&
    existing.tier === snapshot.appliedTier &&
    existing.isManualOverride;
  if (!stillOurs) return { ok: false, reason: "conflict" };

  const restoredTier = snapshot.prevTier === null ? null : toLiveTier(snapshot.prevTier);
  const done: OverrideUndoSnapshot = { ...snapshot, undoneAt: now.toISOString(), restoredTier };

  try {
    await prisma.$transaction([
      (
        prisma.attentionItem as unknown as {
          update: (args: unknown) => ReturnType<typeof prisma.attentionItem.update>;
        }
      ).update({
        where: {
          id: itemId,
          userId,
          overrideUndoToken: token,
          tier: snapshot.appliedTier,
          isManualOverride: true,
        },
        data: {
          tier: restoredTier,
          tierReason: snapshot.prevTierReason,
          // Restores the value this module wrote earlier; never client input.
          isManualOverride: snapshot.prevIsManualOverride,
          agentTierSetAt: snapshot.prevAgentTierSetAt
            ? new Date(snapshot.prevAgentTierSetAt)
            : null,
          agentTierKeyId: snapshot.prevAgentTierKeyId,
          // Explicit, so @updatedAt does not make the row look freshly decided.
          updatedAt: new Date(snapshot.prevUpdatedAt),
          overrideUndoToken: null,
          // Kept (with undoneAt) so a repeat of this undo is answered from it;
          // the next override or judge write, or the daily sweep, removes it.
          overrideUndo: done,
        },
      }),
      prisma.decisionLabel.updateMany({
        // Only the stamp this override wrote: same outcome AND the same instant.
        // A stamp that was already there (an earlier confirm or override) has a
        // different outcomeAt and is left alone.
        where: {
          userId,
          source: existing.source as AttentionSourceName,
          sourceId: existing.sourceId,
          outcome: `OVERRIDE:${snapshot.appliedTier}`,
          outcomeAt: new Date(snapshot.at),
        },
        data: { outcome: null, outcomeAt: null },
      }),
    ]);
  } catch (err) {
    if (!isRecordNotFound(err)) throw err;
    // The row moved between the check and the write. If a concurrent call with
    // the same token finished the undo, this one is its replay; otherwise a
    // newer decision owns the row.
    const latest = await readUndoCandidate(userId, itemId);
    return (
      replayOf(parseSnapshot(latest?.overrideUndo), token) ?? { ok: false, reason: "conflict" }
    );
  }

  return { ok: true, tier: restoredTier, alreadyUndone: false };
}

/** The shape Date.prototype.toISOString() writes, as a POSIX regex. */
const ISO_INSTANT_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$";

/** How long a snapshot may sit on a row before the sweep removes it. */
export const OVERRIDE_UNDO_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Remove undo snapshots older than OVERRIDE_UNDO_RETENTION_MS. They are dead
 * weight long before that (the undo window is 30s); the day of slack keeps a
 * repeated undo answerable and the sweep cheap to reason about.
 *
 * Raw SQL on purpose: a Prisma updateMany would bump `updatedAt`, which the
 * judge's sender priors read as "decided just now". This statement touches the
 * two undo columns and nothing else. No index serves it (a partial index is
 * not expressible in the Prisma schema); it is one pass over AttentionItem per
 * run, like the aging sweep next to it.
 */
export async function sweepOverrideUndoSnapshots(now: Date = new Date()): Promise<number> {
  // `at` is always written by toISOString(): fixed width, UTC, so text order
  // IS time order and no cast is needed. A cast would let one malformed row
  // fail the whole statement. Compared as text nothing can raise, and a
  // snapshot whose `at` is missing or not in that shape is swept as well: it
  // could never be undone (parseSnapshot rejects it) and would otherwise stay.
  const cutoff = new Date(now.getTime() - OVERRIDE_UNDO_RETENTION_MS).toISOString();
  return prisma.$executeRaw`
    UPDATE "AttentionItem"
    SET "overrideUndoToken" = NULL, "overrideUndo" = NULL
    WHERE "overrideUndo" IS NOT NULL
      AND (
        COALESCE("overrideUndo"->>'at', '') !~ ${ISO_INSTANT_PATTERN}
        OR ("overrideUndo"->>'at') COLLATE "C" < ${cutoff}
      )`;
}

/**
 * The attention item for an EmailMessage row, whatever its status. The mail
 * list and reader know an email id, not an attention id; this is how their
 * lane keys reach overrideAttentionTier. Scoped by userId, so another user's
 * email id resolves to nothing. null = the mail has not been judged yet.
 */
export async function findEmailAttentionItemId(
  userId: string,
  emailDbId: string,
): Promise<string | null> {
  const row = await (
    prisma.attentionItem as unknown as {
      findFirst: (args: unknown) => Promise<{ id: string } | null>;
    }
  ).findFirst({
    where: { userId, source: "EMAIL", sourceId: emailDbId },
    select: { id: true },
  });
  return row?.id ?? null;
}

/**
 * Record that the user EXPLICITLY agreed with the tier the firewall showed —
 * positive ground truth, the counterpart to overrideAttentionTier's negative
 * signal. Unlike an override it does NOT move the tier and does NOT set
 * isManualOverride: agreement is not a manual move, and judge-context correction
 * mining keys off isManualOverride, so a confirm must never look like a
 * correction. It only stamps the decision ledger (outcome "CONFIRM:<tier>",
 * first-action-wins via the outcome:null guard) so decision-metrics can turn a
 * bounded recall into a point estimate over rows the user actually labelled
 * instead of inferring correctness from silence.
 */
export async function confirmAttentionTier(
  userId: string,
  itemId: string,
): Promise<AttentionConfirmResult> {
  const existing = await (
    prisma.attentionItem as unknown as {
      findFirst: (args: unknown) => Promise<{
        id: string;
        source: string;
        sourceId: string;
        tier: string | null;
        agentTierSetAt: Date | null;
      } | null>;
    }
  ).findFirst({
    where: { id: itemId, userId },
    select: { id: true, source: true, sourceId: true, tier: true, agentTierSetAt: true },
  });

  if (!existing) return { ok: false, reason: "not_found" };

  // Confirm the tier the user actually saw. normalizeTier folds a legacy CALL
  // row into PUSH (its real delivery behaviour) so the label never records a
  // retired tier.
  const tier = normalizeTier(existing.tier);
  // The tier was set by an MCP agent (step A2b), not shown by the judge: agreeing
  // with it is not judge agreement. A CONFIRM:<agent's lane> against the judge's
  // shownTier would be a contradictory label, and first-stamp-wins would then
  // block the user's real later override from reaching the ledger.
  if (existing.agentTierSetAt) return { ok: true, tier };
  // No AttentionItem write: a confirmation leaves the shown tier as-is and must
  // not trip isManualOverride. Only the ground-truth ledger is stamped, guarded
  // by outcome:null so the first explicit action (confirm OR override) wins.
  await prisma.decisionLabel.updateMany({
    where: {
      userId,
      source: existing.source as AttentionSourceName,
      sourceId: existing.sourceId,
      outcome: null,
    },
    data: { outcome: `CONFIRM:${tier}`, outcomeAt: new Date() },
  });

  return { ok: true, tier };
}

/**
 * Best-effort lookup of the OPEN EMAIL-source AttentionItem for an
 * EmailMessage row (sourceId is the EmailMessage.id, set by poc-judge).
 * Used to attach tier-override buttons to outbound Telegram interrupts;
 * returns null on any failure so callers never gain a new failure mode.
 */
export async function findOpenEmailAttentionItemId(
  userId: string,
  emailDbId: string,
): Promise<string | null> {
  try {
    const row = await (
      prisma.attentionItem as unknown as {
        findFirst: (args: unknown) => Promise<{ id: string } | null>;
      }
    ).findFirst({
      where: { userId, source: "EMAIL", sourceId: emailDbId, status: "OPEN" },
      select: { id: true },
    });
    return row?.id ?? null;
  } catch (err) {
    // Don't swallow silently — a DB error here breaks override dedup, and
    // captureError is invisible without a Sentry DSN.
    console.warn(
      "[attention-override] findOpenEmailAttentionItemId failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
