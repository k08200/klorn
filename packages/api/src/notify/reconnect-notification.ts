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
 *
 * One exception, the stop of an IMAP poll (mail/imap-accounts.ts, after the
 * 4th refused login): founder decision LOCKED 2026-11-17, it alerts once per
 * stop under its own key, "reconnect:<slug>:<account>:stopped:<epoch ms>", so
 * a stop on the same UTC day as the 1st refusal's alert is no longer
 * swallowed by the daily key. The push still passes every gate of
 * sendPushNotification, quiet hours included.
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
  // IMAP mailboxes: flagged by the poll when the provider refuses the stored
  // app password (mail/imap-accounts.ts).
  ICLOUD: { slug: "icloud", label: "iCloud Mail" },
  NAVER: { slug: "naver", label: "Naver Mail" },
  IMAP: { slug: "imap", label: "IMAP mailbox" },
  // App-password presets (provider phase 2): the same IMAP poll flags them.
  DAUM: { slug: "daum", label: "Daum Mail" },
  KAKAO: { slug: "kakao", label: "Kakao Mail" },
  YAHOO: { slug: "yahoo", label: "Yahoo Mail" },
  AOL: { slug: "aol", label: "AOL Mail" },
  FASTMAIL: { slug: "fastmail", label: "Fastmail" },
  ZOHO: { slug: "zoho", label: "Zoho Mail" },
  ZOHOPRO: { slug: "zohopro", label: "Zoho Mail" },
} as const;
export type ReconnectProvider = keyof typeof PROVIDER_COPY;

/** The product name the reconnect alert speaks for this provider. */
export function reconnectProviderLabel(provider: ReconnectProvider): string {
  return PROVIDER_COPY[provider].label;
}

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

export interface ReconnectAlertOptions {
  linkedInboxAccountId?: string;
  provider?: ReconnectProvider;
  /**
   * The instant an IMAP poll stopped for this linked account (its 4th refused
   * login): the alert is keyed by that stop instead of the UTC day. Ignored
   * without linkedInboxAccountId.
   */
  stoppedAt?: Date;
}

function reconnectDedupeKey(slug: string, opts: ReconnectAlertOptions | undefined): string {
  const accountId = opts?.linkedInboxAccountId;
  if (!accountId) return `reconnect:${slug}:${gmailReconnectDayKey()}`;
  if (opts?.stoppedAt) return `reconnect:${slug}:${accountId}:stopped:${opts.stoppedAt.getTime()}`;
  return `reconnect:${slug}:${accountId}:${gmailReconnectDayKey()}`;
}

/**
 * Create + broadcast + web-push the reconnect alert. Returns the created
 * notification, or null when the alert under this key already exists (today's
 * for this account, or this stop's: the P2002 loser — no duplicate push on any
 * channel). Non-P2002 failures propagate; call sites treat the whole alert as
 * best-effort and log.
 */
export async function ensureGmailReconnectNotification(
  userId: string,
  opts?: ReconnectAlertOptions,
): Promise<{ id: string; createdAt: Date } | null> {
  const { slug, label } = PROVIDER_COPY[opts?.provider ?? "GOOGLE"];
  const title = reconnectTitle(label);
  const message = reconnectMessage(label);
  const dedupeKey = reconnectDedupeKey(slug, opts);

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
    // Already alerted under this key (today, or this stop) — the winner pushed; stay silent.
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
