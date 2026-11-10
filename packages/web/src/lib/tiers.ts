/**
 * The lane names, in one place.
 *
 * There was no canonical list in the web package, so each surface carried its
 * own and they had drifted apart: the playground offered the pre-MEETING set
 * `["PUSH","QUEUE","SILENT","AUTO"]`, the firewall board three lanes, and the
 * privacy policy told users their mail was sorted into "PUSH / QUEUE / SILENT /
 * AUTO" — a sentence that stopped being true when MEETING and INFO shipped.
 *
 * The API's `TIERS` (packages/api/src/judge/tiers.ts) is the real source of
 * truth. This mirrors its core order for display; anything that renders a lane
 * list or states how many lanes there are should read it from here rather than
 * writing the names out again.
 */

import type { LiveTier } from "@klorn/contract";

/** User-visible lanes, in the order they are shown. AUTO is a classification
 *  state rather than a lane and is deliberately not in this list. */
export const CORE_TIERS = ["PUSH", "MEETING", "QUEUE", "INFO", "SILENT"] as const;

export type CoreTier = (typeof CORE_TIERS)[number];

/**
 * Compile-time completeness against the wire contract.
 *
 * `CoreTier` above is derived from CORE_TIERS itself, so it is self-consistent
 * by construction and cannot notice a lane added to `@klorn/contract`. This
 * Record can: `LiveTier` is `Exclude<Tier, "AUTO">` from the contract, so a new
 * lane there fails this line until CORE_TIERS names it too. That is the check a
 * hand-maintained list otherwise never gets — every list this file replaced was
 * internally consistent right up until the vocabulary moved underneath it.
 */
const _allLanesListed: Record<LiveTier, true> = {
  PUSH: true,
  MEETING: true,
  QUEUE: true,
  INFO: true,
  SILENT: true,
};
void _allLanesListed;

/** "PUSH / MEETING / QUEUE / INFO / SILENT" — for prose that names the lanes. */
export const TIER_NAMES = CORE_TIERS.join(" / ");

/** How many lanes there are, for prose that states a count. Never hard-code
 *  the number: it said "four" above a list of five for weeks. */
export const TIER_COUNT = CORE_TIERS.length;

/**
 * Fold any recorded lane value into one a person may see. Mirrors the API's
 * `toLiveTier` (packages/api/src/judge/tiers.ts): the retired v1 values never
 * render — CALL reads as PUSH, AUTO as QUEUE — and an unrecognised value
 * reads as QUEUE, the visible default. Callers that have NO recorded lane
 * should render no chip rather than call this (a missing lane is not QUEUE).
 */
export function toLiveTier(value: string): LiveTier {
  if (value === "CALL") return "PUSH";
  return (CORE_TIERS as readonly string[]).includes(value) ? (value as LiveTier) : "QUEUE";
}
