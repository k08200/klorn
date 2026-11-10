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
  /**
   * The firewall lane of the mail (decision N1). Set by the firewall PUSH /
   * MEETING ring and the one-mail urgent sweep. A MEETING mail takes the
   * meeting action set (Later); absent = the mail action set, as before.
   */
  lane?: "PUSH" | "MEETING";
}

/**
 * APNs `aps.category` of a mail push: lock-screen action sets the app
 * registers (apps/mobile AppDelegate.swift). Decision N1 order:
 *   KLORN_PUSH_MAIL_DRAFT — Send draft · Later · Not urgent · Done
 *   KLORN_PUSH_MAIL       — Reply · Later · Not urgent · Done
 *   KLORN_PUSH_MEETING    — Later (Join needs a verified meeting link; a mail has none)
 */
export type ApnsMailCategory = "KLORN_PUSH_MAIL" | "KLORN_PUSH_MAIL_DRAFT" | "KLORN_PUSH_MEETING";

/**
 * The `alert` tag on a real-time websocket `notification` frame. Set by
 * packages/api notify/desktop-alert.ts only for PUSH-lane mail ("push") and a
 * meeting starting soon ("meeting"), and only when the user's notification
 * preferences and quiet hours allow that category. The Windows desktop shell
 * turns tagged frames — and nothing else — into OS banners
 * (packages/web lib/native/desktop-alerts.ts).
 */
export type DesktopAlertKind = "push" | "meeting";

/**
 * The toast for one mail in the Windows desktop shell (decision N1 shape,
 * notify/mail-push-content.ts): title = the sender, body = the subject plus
 * the judge's one-line reason. Clicking it opens `/email/:emailId`. Carried as
 * `mail` on a tagged live `notification` frame and by every item of
 * GET /api/notifications/desktop-catchup.
 */
export interface DesktopMailToast {
  /** EmailMessage.id the toast opens. */
  emailId: string;
  title: string;
  body: string;
}

/** One urgent mail the desktop shell missed while it was closed or asleep. */
export interface DesktopMissedMail extends DesktopMailToast {
  /** The bell row id: the id the live frame carried (one ledger for both). */
  id: string;
  createdAt: string;
}

/**
 * GET /api/notifications/desktop-catchup?ids=… (decision N6). Of the bell rows
 * the shell asks about, the PUSH mails from the last 72h that are still open.
 * `held` is true while the user's quiet hours suppress urgent-mail alerts: the
 * shell then shows nothing and asks again later. `summaryTitle` is the
 * "N urgent emails while Klorn was closed" title in the user's notification
 * language, with `{count}` standing for N.
 */
export interface DesktopCatchUpResponse {
  held: boolean;
  summaryTitle: string;
  items: DesktopMissedMail[];
}
