/**
 * Notification center wire contract (NC1): the bell row shape of
 * `GET /api/notifications` with the optional fields the notification center
 * adds, the optional interrupt budget on that list, and the lazy
 * `GET /api/notifications/:id/delivery` read. Built by packages/api
 * background.ts (getNotifications) and notify/notification-center.ts. The web
 * bell, the Mac notification center (its banner composition mirrors
 * notify/mail-push-content.ts) and the mobile shell read these shapes.
 *
 * Every field on NotificationCenterFields, and `budget`, is OPTIONAL and
 * additive: a client that ignores them sees the list exactly as before, and a
 * row the server cannot enrich (no mail behind it, or the enrichment read
 * failed) simply lacks them.
 */

import type { LiveTier } from "./firewall.js";

/**
 * Why a mail rang, as plain text (never HTML or markdown; render it as a text
 * node).
 *
 *  - `verified: true` only when `quote` is a verbatim sentence from the mail
 *    that the server re-checked as a substring of the mail's subject or body
 *    (judge/v3/evidence.ts verifyEvidence) on this read. Only users under the
 *    attention-engine v3 policy have stored evidence to check.
 *  - Otherwise `verified: false` and `text` is the judge's short reason
 *    (AttentionItem.tierReason resolved in the reader's language). That text
 *    may be model-written: it is Klorn's call, not evidence.
 *
 * `quote` and `quoteIn` are present only when `verified` is true. `quote`
 * carries no quotation marks; the client adds its own.
 */
export interface NotificationReason {
  text: string;
  verified: boolean;
  quote?: string;
  quoteIn?: "subject" | "body";
}

/**
 * Where a bell row sits in the notification center. Server-computed; the
 * first rule that matches wins:
 *
 *  1. `done`  — the row is read; or its mail's item is RESOLVED / DISMISSED;
 *               or its approval is no longer PENDING.
 *  2. `later` — its mail's item is SNOOZED (the user said "later").
 *  3. `reply` — its mail needs a reply that has not been sent through Klorn
 *               (EmailMessage.needsReply and no repliedAt).
 *  4. `now`   — its mail is in the PUSH lane and inside Today's 72-hour PUSH
 *               window (received in the last 72h; judge/today-push-window.ts,
 *               LOCKED 2026-10-23).
 *  5. `today` — in the user's local calendar day (AutomationConfig.timezone):
 *               a MEETING mail whose row was written today, a mail whose v3
 *               ask is due today, or a meeting / calendar / reminder row
 *               written today; or an approval still PENDING.
 *  6. `later` — everything else.
 */
export type NotificationGroup = "now" | "today" | "reply" | "later" | "done";

/** The optional fields on each `GET /api/notifications` row. */
export interface NotificationCenterFields {
  /**
   * The firewall lane of the row's mail: one of the five live lanes only
   * (retired AUTO / CALL are folded by normalizeTier on read, never sent).
   * Absent when the row has no mail or the mail has no lane yet.
   */
  lane?: LiveTier;
  /** Absent when there is neither a reason nor a verified quote. */
  reason?: NotificationReason;
  /** The daily interrupt budget held this mail in QUEUE (shown while the hold is live). Present for mail rows. */
  held?: boolean;
  group?: NotificationGroup;
}

/** One bell row of `GET /api/notifications`. */
export interface NotificationRow extends NotificationCenterFields {
  id: string;
  /** "email" | "reminder" | "calendar" | "meeting" | "briefing" | "agent_proposal" | … */
  type: string;
  title: string;
  message: string;
  isRead: boolean;
  /** App path a click opens (e.g. "/email/<id>"). */
  link: string | null;
  conversationId: string | null;
  /** EmailMessage.id of a row about one mail. */
  sourceEmailId: string | null;
  pendingActionId: string | null;
  /** The linked approval's status ("PENDING", "APPROVED", …), when there is one. */
  pendingActionStatus: string | null;
  /** ISO 8601. */
  createdAt: string;
}

/**
 * The day's interrupt budget (attention engine v3): PUSH notifications rung
 * today against the daily limit. Sent only when the budget applies to the
 * user (policy v3 on and a finite limit); omitted otherwise.
 */
export interface NotificationBudget {
  used: number;
  limit: number;
}

/** `GET /api/notifications` */
export interface NotificationListResponse {
  notifications: NotificationRow[];
  count: number;
  unread: number;
  budget?: NotificationBudget;
}

/**
 * A channel name in a delivery read: the device or app the alert reached.
 * Web push is named by its push service (a Chromium browser on FCM is
 * "chrome"; "web" when the service is not one of the four).
 */
export type DeliveryChannelName =
  | "mac"
  | "windows"
  | "ios"
  | "android"
  | "telegram"
  | "chrome"
  | "edge"
  | "firefox"
  | "safari"
  | "web";

/** The furthest observed stage of one channel (notify/delivery-lifecycle.ts). */
export type DeliveredState = "sent" | "device_received" | "opened" | "actioned";

/**
 * `GET /api/notifications/:id/delivery`: where this bell row's alert landed.
 * 404 for a row that is not the caller's (or does not exist).
 *
 *  - `deliveredTo`: channel names (DeliveryChannelName; typed string so a new
 *    name never breaks a client) that reached at least `sent`, furthest stage
 *    first, each named once. The canonical field.
 *  - `channels`: the same names with their furthest stage. A stage is listed
 *    only when it was observed: FCM / APNs / Telegram never report past
 *    `sent`; desktop apps report from `device_received`.
 */
export interface NotificationDelivery {
  deliveredTo: string[];
  channels?: Array<{ name: string; state: DeliveredState }>;
}
