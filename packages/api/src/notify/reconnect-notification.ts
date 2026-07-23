/**
 * "Gmail disconnected" reconnect alert — active, at most once per day.
 *
 * Why this exists: in Google OAuth Testing mode the refresh token dies after
 * 7 days. invalidateGoogleToken empties the token row and logs, but the only
 * user-facing signal used to be a websocket broadcast on the calendar sync
 * path — unreachable for anyone with the app closed. This module gives token
 * death an ACTIVE voice: an in-app bell Notification row plus a web push that
 * deep-links to /settings, where the one-click reconnect banner already lives.
 *
 * Dedup is WINNER-ONLY and atomic: a `(userId, dedupeKey)` unique on
 * Notification (dedupeKey = "reconnect:google:<dayKey>", per-account suffix
 * for linked inboxes) plus the create-catch-P2002 idiom shared with
 * briefing.ts / automation-scheduler.ts — concurrent failing syncs can never
 * double-alert; at most one alert per account per UTC day.
 */

import { prisma } from "../db.js";
import { pushNotification } from "../websocket.js";
import { sendPushNotification } from "./push.js";

const RECONNECT_TITLE = "Gmail disconnected — 1 click to reconnect";
// Wording deliberately avoids the notification-policy noise keywords
// ("verify your", "confirm your", "deal", "sale") so the system push is
// never vetoed by the inbound-mail heuristic.
const RECONNECT_MESSAGE =
  "Klorn lost access to your Gmail, so the firewall is paused. Reconnect in Settings to resume.";
const RECONNECT_LINK = "/settings";

/** UTC calendar day (YYYY-MM-DD) the reconnect alert dedupes on. */
export function gmailReconnectDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Create + broadcast + web-push the reconnect alert. Returns the created
 * notification, or null when today's alert for this account already exists
 * (the P2002 loser — no duplicate push on any channel). Non-P2002 failures
 * propagate; call sites treat the whole alert as best-effort and log.
 */
export async function ensureGmailReconnectNotification(
  userId: string,
  opts?: { linkedInboxAccountId?: string },
): Promise<{ id: string; createdAt: Date } | null> {
  const dayKey = gmailReconnectDayKey();
  const dedupeKey = opts?.linkedInboxAccountId
    ? `reconnect:google:${opts.linkedInboxAccountId}:${dayKey}`
    : `reconnect:google:${dayKey}`;

  let notification: { id: string; createdAt: Date };
  try {
    notification = await prisma.notification.create({
      data: {
        userId,
        type: "email",
        dedupeKey,
        title: RECONNECT_TITLE,
        message: RECONNECT_MESSAGE,
        link: RECONNECT_LINK,
      },
      select: { id: true, createdAt: true },
    });
  } catch (err) {
    // Already alerted for this account today — the winner pushed; stay silent.
    if ((err as { code?: string })?.code === "P2002") return null;
    throw err;
  }

  pushNotification(userId, {
    id: notification.id,
    type: "email",
    title: RECONNECT_TITLE,
    message: RECONNECT_MESSAGE,
    createdAt: notification.createdAt.toISOString(),
    link: RECONNECT_LINK,
  });

  await sendPushNotification(
    userId,
    {
      title: RECONNECT_TITLE,
      body: RECONNECT_MESSAGE,
      url: RECONNECT_LINK,
      notificationId: notification.id,
    },
    "system",
  );

  return notification;
}
