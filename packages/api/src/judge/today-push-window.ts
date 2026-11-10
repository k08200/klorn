/**
 * Today's "Needs you now" window (founder decision, LOCKED 2026-10-23): the
 * Today PUSH block — on the web and on the Mac — lists only PUSH mail received
 * in the last TODAY_PUSH_WINDOW_HOURS. Older PUSH stays in Mail's lane views
 * untouched: no data or status changes, only what Today asks for.
 *
 * The one definition both readers use: the web through
 * `GET /api/email?window=today` (email-lanes.ts narrows the lane page by
 * receivedAt), the Mac through `todayPush` on `GET /api/inbox/firewall`.
 * Clients never carry the number.
 */

/** How far back Today's PUSH block reaches, in hours. */
export const TODAY_PUSH_WINDOW_HOURS = 72;

/** The only `window` value the mail list accepts; only Today sends it. */
export const TODAY_WINDOW = "today";

const HOUR_MS = 3_600_000;

/** The earliest received time inside the window. */
export function todayPushCutoff(now: Date): Date {
  return new Date(now.getTime() - TODAY_PUSH_WINDOW_HOURS * HOUR_MS);
}

/**
 * Whether an item falls inside the window: its mail's received time, or —
 * only when there is none (no mail behind the item) — the item's createdAt.
 * The cutoff itself is inside. An unparseable time is outside.
 */
export function isInTodayPushWindow(
  receivedAt: Date | string | null | undefined,
  createdAt: Date | string,
  now: Date,
): boolean {
  const at = new Date(receivedAt ?? createdAt).getTime();
  return Number.isFinite(at) && at >= todayPushCutoff(now).getTime();
}
