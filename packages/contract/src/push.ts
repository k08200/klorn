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
 * What a notification is about (NT0 copy spec, decided 2026-11-17). One copy
 * rule for every kind and device: title = the person (or the event), subtitle
 * = the mail subject, body = the one-line request (a verified quote when one
 * may be shown, else the reason line).
 *   push   — a PUSH-lane mail            meet   — a meeting (or a MEETING-lane mail)
 *   wait   — one mail still owing a reply digest — several mails owing replies
 *   brief  — the daily briefing           agent  — a reply draft / proposal ready
 *   acct   — an account needs reconnecting
 */
export type NotificationKind = "push" | "meet" | "wait" | "digest" | "brief" | "agent" | "acct";

/**
 * The Android notification channel a kind posts to, sent as FCM data
 * `channelId` (the app creates the channels; an unknown id is the app's to
 * map). push → push, meet → meetings, wait / digest / agent → waiting,
 * brief → briefing, acct → account.
 */
export type AndroidNotificationChannel = "push" | "meetings" | "waiting" | "briefing" | "account";

/**
 * Structured fields beside a notification's text (NT0), so a client can lay it
 * out per device instead of parsing `title` / `body`. Every field is optional
 * and additive: a client that does not read them sees exactly what it did.
 * Carried flat, under these names, as APNs top-level custom keys, FCM `data`
 * keys (all values strings there, `attendeeCount` too), Web Push JSON keys and
 * live websocket `notification` frame keys.
 */
export interface NotificationPresentation {
  kind?: NotificationKind;
  /** The sender's display name (cleaned, one line). Absent when the From header has none. */
  senderDisplayName?: string;
  /** The mail subject (cleaned, one line); the subtitle. */
  subject?: string;
  /**
   * A verbatim, verified passage of the mail (NC1), without quotation marks.
   * Only while the server's NOTIFY_PUSH_QUOTE flag is open to the user: it is
   * mail text travelling through Apple's and Google's push services.
   */
  quote?: string;
  /** The one-line request when there is no quote: the judge's short reason, or a wait line. */
  reasonLine?: string;
  /** The provider thread id of the mail (EmailMessage.threadId, as the web reader uses). */
  threadId?: string;
  /**
   * A meeting's join link (https only). Mail and meeting content, so on APNs /
   * FCM only while NOTIFY_PUSH_QUOTE is open to the user; Web Push (end-to-end
   * encrypted) and live frames always carry it.
   */
  joinUrl?: string;
  /** People invited to a meeting (see CalendarEvent.attendeeCount); never their addresses. */
  attendeeCount?: number;
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
 * One Slack PUSH whose live frame the desktop shell held during quiet hours
 * (api slack/notify.ts): the bell row's own title and message, which are the
 * live Slack push's text, nothing more. Clicking it only brings Klorn back,
 * as the live Slack toast does.
 */
export interface DesktopMissedSlack {
  /** The bell row id: the id the live frame carried. */
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

/**
 * GET /api/notifications/desktop-catchup?ids=… (decision N6). Of the bell rows
 * the shell asks about, the PUSH mails from the last 72h that are still open.
 * `held` is true while the user's quiet hours suppress urgent-mail alerts: the
 * shell then shows nothing and asks again later. `summaryTitle` is the
 * "N urgent emails while Klorn was closed" title in the user's notification
 * language, with `{count}` standing for N. `heldSummaryTitle` is the
 * "N urgent emails during quiet hours" title, same shape, used when every
 * mail in the summary rang live while quiet hours held it back (optional: a
 * shell must still toast, with `summaryTitle`, when it is absent).
 *
 * `slack` holds the asked Slack PUSH rows, unread, from the last 72h and not
 * answered in Slack since; a summary that includes one is titled
 * `messagesSummaryTitle` / `heldMessagesSummaryTitle` ("N urgent messages …",
 * same `{count}` shape and the same closed / quiet-hours pick). All three are
 * optional: a server before them sends none.
 */
export interface DesktopCatchUpResponse {
  held: boolean;
  summaryTitle: string;
  heldSummaryTitle?: string;
  messagesSummaryTitle?: string;
  heldMessagesSummaryTitle?: string;
  items: DesktopMissedMail[];
  slack?: DesktopMissedSlack[];
}
