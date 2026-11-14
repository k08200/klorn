/**
 * Meeting prep for the surfaces that show it alongside something else (the
 * briefing payload, the evening review): the flag, cohort-aware, and a
 * fail-open build — a prep failure never breaks the surface that carries it.
 */

import type { MeetingPrepBlock } from "@klorn/contract";
import { CONTEXT_MEETING_PREP_FLAGS, featureOpenTo } from "../config.js";
import { buildMeetingPrep } from "./meeting-prep.js";

/** Whether the caller gets meeting prep at all (CONTEXT_MEETING_PREP_ENABLED: off / cohort / on). */
export function meetingPrepOpenTo(userId: string): boolean {
  return featureOpenTo(userId, CONTEXT_MEETING_PREP_FLAGS);
}

/**
 * The block, or null when the flag is closed to the user, when there is
 * nothing to prep, or on any error (logged without user data).
 */
export async function meetingPrepForUser(
  userId: string,
  now: Date,
): Promise<MeetingPrepBlock | null> {
  if (!meetingPrepOpenTo(userId)) return null;
  try {
    return await buildMeetingPrep(userId, now);
  } catch (err) {
    console.warn(`[MEETING_PREP] build failed: ${err instanceof Error ? err.name : typeof err}`);
    return null;
  }
}
