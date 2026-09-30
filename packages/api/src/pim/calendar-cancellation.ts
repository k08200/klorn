/**
 * Removing events that were deleted or cancelled upstream (step C2b of
 * docs/providers/unified-platform-plan.md). After a sync has upserted the live
 * window, the provider is asked, in a call of its own, which events were
 * cancelled since the last scan; their rows go, and so do the attention items
 * mirrored from them (calendar-rows.ts owns the removal).
 *
 * Nothing here may fail a sync: the live events are already written, so a failing
 * scan is logged once and the next sync tries again from the last scan that
 * completed. It is deliberately NOT sent to Sentry: a provider outage would
 * otherwise raise one event per account per sync cycle.
 */

import type { CalendarSession, CalendarWindow } from "./calendar-providers/types.js";
import { removeCancelledGoogleEventRows, sourceKeyFor } from "./calendar-rows.js";

/** How far back the first scan of an account looks, and the most any scan ever does. */
export const CANCELLED_LOOKBACK_DAYS = 7;
/** A scan starts this much before the last completed one, so a clock skew or a slow commit loses nothing. */
export const CANCELLED_SCAN_MARGIN_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When each account's last COMPLETE scan began, per process. Not persisted: after
 * a restart an account falls back to the lookback, which only costs a larger
 * (still bounded, still paged) first scan. Keys are `userId:source`, so this
 * grows with the number of synced accounts and no further.
 */
const lastCompleteScan = new Map<string, number>();
/** Accounts whose current trouble (failure or truncation) was already logged. */
const warned = new Set<string>();

/** Test hook: forget every scan time and every logged warning. */
export function _resetCancelledScanStateForTests(): void {
  lastCompleteScan.clear();
  warned.clear();
}

/**
 * The later of (now - lookback) and (this account's last complete scan - margin):
 * small and cheap in steady state, never wider than the lookback after a gap.
 */
export function cancelledScanUpdatedMin(key: string, now: Date): Date {
  const floor = now.getTime() - CANCELLED_LOOKBACK_DAYS * DAY_MS;
  const last = lastCompleteScan.get(key);
  if (last === undefined) return new Date(floor);
  return new Date(Math.max(floor, last - CANCELLED_SCAN_MARGIN_MS));
}

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/**
 * Scan one account for cancelled events and remove their rows. `linkedAccountId`
 * null is the primary calendar. Never throws.
 */
export async function reconcileCancelledEvents(
  session: CalendarSession,
  userId: string,
  linkedAccountId: string | null,
  window: CalendarWindow,
  now: Date,
): Promise<void> {
  if (!session.listCancelledEvents) return;
  const key = `${userId}:${sourceKeyFor(linkedAccountId)}`;
  try {
    const updatedMin = cancelledScanUpdatedMin(key, now).toISOString();
    const { externalIds, truncated } = await session.listCancelledEvents({
      ...window,
      updatedMin,
    });
    await removeCancelledGoogleEventRows(userId, linkedAccountId, externalIds, now);
    if (truncated) {
      // Not advanced: the next scan covers the same ground again, and an old
      // cancellation the cap cut off ages out with the lookback instead.
      warnOnce(
        key,
        `[CALENDAR] cancelled-event scan truncated for ${key}: more cancellations than the page cap, the rest are not removed yet`,
      );
      return;
    }
    lastCompleteScan.set(key, now.getTime());
    warned.delete(key);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warnOnce(
      key,
      `[CALENDAR] cancelled-event scan failed for ${key}, events deleted upstream stay until it succeeds: ${reason}`,
    );
  }
}
