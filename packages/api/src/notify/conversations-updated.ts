import { logDbFailure } from "../report-db-failure.js";
import { pushNotification } from "../websocket.js";

/**
 * Tell every open client (web tabs, the desktop app) to refetch its mail
 * surfaces NOW. `conversations-updated` is the app-wide refresh signal the
 * web NotificationBell bridges to a window event and the desktop
 * RealtimeClient treats as a wake.
 *
 * Throttled per user — leading emit immediately (latency is the whole
 * point), repeats within the window coalesce into one trailing emit. A
 * backfill sweep judging 30 stranded emails must produce 2 refetches, not 30.
 */
const THROTTLE_MS = 2_000;

const inFlight = new Map<string, { timer: NodeJS.Timeout; again: boolean }>();

export function notifyConversationsUpdated(userId: string): void {
  const entry = inFlight.get(userId);
  if (entry) {
    entry.again = true;
    return;
  }
  send(userId);
  const timer = setTimeout(() => {
    const e = inFlight.get(userId);
    inFlight.delete(userId);
    if (e?.again) notifyConversationsUpdated(userId);
  }, THROTTLE_MS);
  timer.unref?.();
  inFlight.set(userId, { timer, again: false });
}

function send(userId: string): void {
  // Best-effort by CONTRACT, enforced here: this fires inside the judge tail
  // and scheduler ticks, where a socket-level throw would abort the PUSH
  // interrupt (or a whole user's tick) over a lost repaint signal.
  try {
    // Same envelope gmail-push always sent (fixed id so the web bell dedups
    // instead of stacking a row per sync tick).
    pushNotification(userId, {
      id: "mail-sync",
      type: "system",
      title: "conversations-updated",
      message: "",
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    logDbFailure("[WS] conversations-updated emit failed", err, { ids: { userId } });
  }
}
