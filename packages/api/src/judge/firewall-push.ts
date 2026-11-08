/**
 * The firewall's PUSH and MEETING notification for one judged email
 * (extracted from email-firewall.ts). The v2 path calls pushForFirewallEmail
 * after writing the item. The v3 live decision (v3/live-judge.ts) runs the
 * same gates before writing, claims a budget slot with the bell row, and then
 * delivers through deliverFirewallPush.
 *
 * push/websocket/attention-override are lazy-imported to avoid a top-level
 * cycle.
 */

import { HIDDEN_CLAIM_TYPE } from "../agentcore/auto-reply-ledger-keys.js";
import { prisma } from "../db.js";
import { escapeLikePattern } from "../db-like.js";
import { findReingestedHistory } from "../mail/imap-history.js";
import { isImapMessageId } from "../mail/imap-message-id.js";
import type { JudgeableEmailRow } from "./email-firewall.js";
import type { BellRow } from "./v3/push-budget-gate.js";

// A push for a PUSH-tier email only fires for genuinely recent mail. The
// backfill sweep re-judges emails that arrived while the dyno slept; tiering
// a days-old email in the firewall is right, but firing a stale "urgent" push
// for it is not.
const FIREWALL_PUSH_RECENCY_MS = 6 * 60 * 60 * 1000;
const PUSH_DEDUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// Shared notification title with the urgent-priority sweep
// (automation-scheduler.ts) so the two dedup against each other: whichever
// fires first writes "Urgent email" + "[gmailId]", and the other skips. An
// email that is both keyword-URGENT and judge-PUSH gets exactly one push.
const FIREWALL_PUSH_TITLE = "Urgent email";

function senderDisplayName(from: string): string {
  const angle = from.indexOf("<");
  const name = angle > 0 ? from.slice(0, angle).trim().replace(/^"|"$/g, "") : from.trim();
  return name || from;
}

/**
 * The earliest notification that may count as "already pushed" for this email. The
 * 7-day window for every id. For an IMAP id also not before the row was created: a
 * repair (step B2b, imap-uidvalidity-reset.ts) re-keys the old row and a NEW message
 * can then arrive under the same id, which the old row's `[id]` marker must not
 * silence. The urgent sweep applies the same rule (notify/urgent-dedup.ts). Gmail ids
 * read nothing more and get exactly the window they had.
 */
async function pushDedupeFloor(email: JudgeableEmailRow): Promise<Date> {
  const windowStart = new Date(Date.now() - PUSH_DEDUP_WINDOW_MS);
  if (!isImapMessageId(email.gmailId)) return windowStart;
  const row = await prisma.emailMessage.findUnique({
    where: { id: email.id },
    select: { createdAt: true },
  });
  return row && row.createdAt.getTime() > windowStart.getTime() ? row.createdAt : windowStart;
}

/**
 * The gates every firewall push passes first, spending no budget: the 6h
 * recency rule, the IMAP re-ingest skip and the 7-day dedupe. `policyUser`:
 * for a user under policy v3, a cleared bell hides interrupt-budget slot rows
 * (type "claim") instead of deleting them, and they still mark the mail as
 * already pushed. For everyone else the dedupe query is exactly as it was.
 */
export async function firewallPushGatesPass(
  userId: string,
  email: JudgeableEmailRow,
  policyUser: boolean,
): Promise<boolean> {
  const ageMs = Date.now() - email.receivedAt.getTime();
  if (ageMs > FIREWALL_PUSH_RECENCY_MS) {
    // Suppressing a stale PUSH is intentional (dyno slept, or a late manual sync
    // / backfill surfaced old mail), but it must not be silent: this is the
    // first thing to check when a PUSH-tier email fired no alarm. push.ts logs
    // every other suppression reason; this early return is the one blind spot.
    console.log(
      `[PUSH] Firewall PUSH suppressed (stale: ${Math.round(ageMs / 3_600_000)}h old) ` +
        `for email ${email.gmailId} user ${userId}`,
    );
    return false;
  }

  // Step B2b: mail a UIDVALIDITY repair re-ingested is history the user was already
  // told about. It is judged like any row, but it does not push. Gmail ids read nothing.
  const history = await findReingestedHistory(userId, [email]);
  if (history.has(email.id)) {
    console.log(
      `[PUSH] Firewall PUSH suppressed (re-ingested after an IMAP UIDVALIDITY repair) ` +
        `for email ${email.gmailId} user ${userId}`,
    );
    return false;
  }

  const id = email.gmailId;
  const since = await pushDedupeFloor(email);
  const already = await prisma.notification.findFirst({
    where: {
      userId,
      type: policyUser ? { in: ["email", HIDDEN_CLAIM_TYPE] } : "email",
      title: FIREWALL_PUSH_TITLE,
      // Match the gmailId as a COMPLETE token inside a `[id1,id2,…]` marker
      // (a firewall single push or an urgent-sweep batch share this title),
      // bounded by the bracket/comma delimiters. A bare `contains` substring-
      // matched, so a Naver IMAP id like `…:5` falsely deduped against a longer
      // `…:53` already sitting in a marker — silently suppressing a legitimate
      // Naver PUSH. Gmail ids are non-nesting hex, but Naver UIDs are
      // sequential integers, so the substring nesting is real for that source.
      OR: [
        { message: { contains: escapeLikePattern(`[${id}]`) } },
        { message: { contains: escapeLikePattern(`[${id},`) } },
        { message: { contains: escapeLikePattern(`,${id},`) } },
        { message: { contains: escapeLikePattern(`,${id}]`) } },
      ],
      createdAt: { gte: since },
    },
    select: { id: true },
  });
  if (already) {
    console.log(
      `[PUSH] Firewall PUSH deduped (already notified within ${PUSH_DEDUP_WINDOW_MS / 86_400_000}d) ` +
        `for email ${email.gmailId} user ${userId}`,
    );
    return false;
  }
  return true;
}

function pushBody(email: JudgeableEmailRow): { sender: string; body: string } {
  const sender = senderDisplayName(email.from);
  return { sender, body: `${sender}: ${email.subject || "(no subject)"}`.slice(0, 200) };
}

/**
 * The bell row. It carries the [gmailId] dedup marker, read back by both this
 * path and the urgent-priority sweep.
 */
export function firewallBellRow(email: JudgeableEmailRow): BellRow {
  return {
    type: "email",
    title: FIREWALL_PUSH_TITLE,
    message: `${pushBody(email).body} [${email.gmailId}]`,
  };
}

/** Ring for a bell row already written: the open clients, then device push. */
export async function deliverFirewallPush(
  userId: string,
  email: JudgeableEmailRow,
  notification: { id: string; createdAt: Date },
): Promise<void> {
  const { sender, body } = pushBody(email);
  const [
    { pushNotification },
    { sendPushNotification },
    { findOpenEmailAttentionItemId },
    { desktopAlertTag },
  ] = await Promise.all([
    import("../websocket.js"),
    import("../notify/push.js"),
    import("./attention-override.js"),
    import("../notify/desktop-alert.js"),
  ]);

  pushNotification(userId, {
    id: notification.id,
    type: "email",
    title: FIREWALL_PUSH_TITLE,
    message: body,
    createdAt: notification.createdAt.toISOString(),
    // PUSH lane → OS banner in the desktop shell, under the Web Push gate.
    ...(await desktopAlertTag(userId, "push")),
  });

  const attentionItemId = await findOpenEmailAttentionItemId(userId, email.id);
  await sendPushNotification(
    userId,
    {
      title: `Klorn — ${sender}`,
      body: email.subject || "(no subject)",
      url: "/inbox/firewall",
      attentionItemId: attentionItemId ?? undefined,
      // Native deep link (push.ts hands it to FCM / APNs only). No
      // pendingActionId: a reply draft for this mail, if any, is proposed after
      // the judge, so none exists yet at this point.
      emailId: email.id,
    },
    "email_urgent",
  );
}

/**
 * Send a push for an email the judge tiered PUSH or MEETING, outside the
 * interrupt budget: the v2 path, and MEETING on the v3 path. Recency-guarded,
 * re-ingest-guarded and deduped. sendPushNotification applies the quiet-hours
 * / rate-limit / Telegram gates, so they are not re-checked here.
 */
export async function pushForFirewallEmail(
  userId: string,
  email: JudgeableEmailRow,
  policyUser: boolean,
): Promise<"sent" | "skipped"> {
  if (!(await firewallPushGatesPass(userId, email, policyUser))) return "skipped";
  const notification = await prisma.notification.create({
    data: { userId, ...firewallBellRow(email) },
    select: { id: true, createdAt: true },
  });
  await deliverFirewallPush(userId, email, notification);
  return "sent";
}
