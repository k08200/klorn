/**
 * Native push payloads (FCM data / APNs JSON) as the bundled mobile app reads
 * them. Built by packages/api notify/push-device.ts (buildFcmMessage) and
 * notify/push-apns.ts (buildApnsBody).
 *
 * Every push carries what it always did: FCM `data` = { url?, notificationId?,
 * category }, APNs = { aps: { alert: { title, body }, sound }, url?,
 * notificationId?, category } (`category` is the Klorn notification category).
 * A MAIL-driven push (firewall PUSH / MEETING, or an urgent sweep about one
 * mail) also carries the fields below; a push without them is not about one
 * email. All values are opaque ids and an in-app route.
 *
 * Android data-only (a device registered with `dataMessages: true`, while the
 * server's ANDROID_DATA_PUSH_ENABLED is on): a mail push has no `notification`
 * block; `data` then also carries `title`, `body` and `sentAt` (epoch ms, as a
 * string) and the app's native service posts it with action buttons.
 */
export interface NativePushMailFields {
  /** The Klorn EmailMessage id (the reader / by-email Done and Later key). */
  emailId: string;
  /** The open firewall attention item, when one exists. */
  attentionItemId?: string;
  /**
   * The approval of a reply draft to this mail — set on the agent's proposal
   * push for `send_email` with `in_reply_to_email_id` (agentcore/
   * proposal-push-target.ts). A firewall push precedes any draft, so it has none.
   */
  pendingActionId?: string;
  /** In-app route: `/mail/<emailId>` (URI-encoded). */
  route: string;
}

/** APNs `aps.category` of a mail push: lock-screen action sets the app registers. */
export type ApnsMailCategory = "KLORN_PUSH_MAIL" | "KLORN_PUSH_MAIL_DRAFT";

/**
 * The `alert` tag on a real-time websocket `notification` frame. Set by
 * packages/api notify/desktop-alert.ts only for PUSH-lane mail ("push") and a
 * meeting starting soon ("meeting"), and only when the user's notification
 * preferences and quiet hours allow that category. The Windows desktop shell
 * turns tagged frames — and nothing else — into OS banners
 * (packages/web lib/native/desktop-alerts.ts).
 */
export type DesktopAlertKind = "push" | "meeting";
