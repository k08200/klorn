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

// Wording deliberately avoids the notification-policy noise keywords
// ("verify your", "confirm your", "deal", "sale") so the system push is
// never vetoed by the inbound-mail heuristic.
// Per-provider label/slug (Phase 3B): OUTLOOK rows reuse this whole module —
// only the product name and the dedupe-key slug differ. GOOGLE stays the
// default so every existing caller is byte-identical.
const PROVIDER_COPY = {
  GOOGLE: { slug: "google", label: "Gmail" },
  OUTLOOK: { slug: "outlook", label: "Outlook" },
} as const;
export type ReconnectProvider = keyof typeof PROVIDER_COPY;

function reconnectTitle(label: string): string {
  return `${label} disconnected — 1 click to reconnect`;
}
function reconnectMessage(label: string): string {
  return `Klorn lost access to your ${label}, so the firewall is paused. Reconnect in Settings to resume.`;
}
const RECONNECT_LINK = "/settings/accounts";

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
  opts?: { linkedInboxAccountId?: string; provider?: ReconnectProvider },
): Promise<{ id: string; createdAt: Date } | null> {
  const { slug, label } = PROVIDER_COPY[opts?.provider ?? "GOOGLE"];
  const title = reconnectTitle(label);
  const message = reconnectMessage(label);
  const dayKey = gmailReconnectDayKey();
  const dedupeKey = opts?.linkedInboxAccountId
    ? `reconnect:${slug}:${opts.linkedInboxAccountId}:${dayKey}`
    : `reconnect:${slug}:${dayKey}`;

  let notification: { id: string; createdAt: Date };
  try {
    notification = await prisma.notification.create({
      data: {
        userId,
        type: "email",
        dedupeKey,
        title,
        message,
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
    title,
    message,
    createdAt: notification.createdAt.toISOString(),
    link: RECONNECT_LINK,
  });

  await sendPushNotification(
    userId,
    {
      title,
      body: message,
      url: RECONNECT_LINK,
      notificationId: notification.id,
    },
    "system",
  );

  return notification;
}
