/**
 * What a Mail v2 row can do, decided once (productization plan §3, P10).
 *
 * Swipe is a shortcut, never the only way: every action a swipe offers is also
 * in the row's actions (hover / keyboard focus / screen reader), and both read
 * their availability and their reason from this one plan, so the two can not
 * drift. The archive rule is the reader's Archive button's rule (demo mail, an
 * account that needs reconnecting); the lane rule is the reader's lane menu's
 * (demo mail, a mail with no lane yet); Later (a reminder, POST
 * /api/email/:id/later) is blocked only on demo mail, like the reader's.
 * Reasons are i18n keys; callers translate them.
 *
 * Directions (mobile redesign PR3, MB1, LOCKED 2026-11-14): right is Done
 * (the archive), left is Later.
 */

import type { LiveTier } from "@klorn/contract";

export type RowActionId = "archive" | "lanes" | "later";

export interface RowAction {
  id: RowActionId;
  /** i18n key for why it cannot run; null when it can. */
  blockedReason: string | null;
}

export interface RowActionPlan {
  archive: RowAction;
  lanes: RowAction;
  later: RowAction;
  /** Finger moving right reveals and runs this one (Done). */
  swipeRight: RowActionId;
  /** Finger moving left reveals and runs this one (Later). */
  swipeLeft: RowActionId;
  /** The row's own actions, in order; a superset of the swipe actions. */
  menu: readonly RowActionId[];
}

export interface RowActionInput {
  isDemo: boolean;
  /** The row's account needs reconnecting before it can write. */
  needsReconnect: boolean;
  /** The recorded lane; null while the judge has not assigned one. */
  tier: LiveTier | null;
}

export const REASON_DEMO = "keys.reason.demo";
export const REASON_RECONNECT = "mailV2.reader.reconnectToArchive";
export const REASON_NOT_CLASSIFIED = "keys.reason.notClassified";

export function archiveBlockedReason(input: Omit<RowActionInput, "tier">): string | null {
  if (input.isDemo) return REASON_DEMO;
  if (input.needsReconnect) return REASON_RECONNECT;
  return null;
}

export function laneBlockedReason(input: Pick<RowActionInput, "isDemo" | "tier">): string | null {
  if (input.isDemo) return REASON_DEMO;
  if (input.tier === null) return REASON_NOT_CLASSIFIED;
  return null;
}

export function laterBlockedReason(input: Pick<RowActionInput, "isDemo">): string | null {
  return input.isDemo ? REASON_DEMO : null;
}

export function rowActionPlan(input: RowActionInput): RowActionPlan {
  return {
    archive: { id: "archive", blockedReason: archiveBlockedReason(input) },
    lanes: { id: "lanes", blockedReason: laneBlockedReason(input) },
    later: { id: "later", blockedReason: laterBlockedReason(input) },
    swipeRight: "archive",
    swipeLeft: "later",
    menu: ["later", "archive", "lanes"],
  };
}

/** One of the plan's actions by id. */
export function planAction(plan: RowActionPlan, id: RowActionId): RowAction {
  return plan[id];
}

/** The action a swipe direction maps to, with its availability. */
export function swipeAction(plan: RowActionPlan, direction: "left" | "right"): RowAction {
  return planAction(plan, direction === "right" ? plan.swipeRight : plan.swipeLeft);
}
