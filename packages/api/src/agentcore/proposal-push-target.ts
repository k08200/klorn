/**
 * The native mail deep link of an approval push (push.ts → push-device.ts /
 * push-apns.ts `mailPushTarget`).
 *
 * An agent proposal that is a REPLY to one stored mail — `send_email` with
 * `in_reply_to_email_id` — is exactly what the mobile app's draft notification
 * (KLORN_PUSH_MAIL_DRAFT: "Send draft" / "Later") is for. So its push carries
 * that mail's `emailId` and the new `pendingActionId` — native channels only:
 * push.ts strips both before web push and Telegram, whose payloads therefore
 * do not change (no `attentionItemId` is added, so no tier-override buttons
 * appear on an approval push). Every other proposal (a brand-new send, a
 * calendar event, an archive, …) returns {} and its push stays byte-identical
 * to before: the "Send draft" button must never appear on something that is
 * not a reply draft.
 *
 * The id is resolved server-side and scoped to the user — the model's value is
 * never echoed: an id that is not one of the user's stored mails yields {}.
 */
import type { NotificationPresentation } from "@klorn/contract";
import { pushPresentationOpenTo, pushQuoteOpenTo } from "../config.js";
import { prisma } from "../db.js";
import { agentDraftPushCopy } from "../notify/kind-push-copy.js";
import { presentedDisplayName } from "../notify/mail-push-content.js";
import { getUserNotificationLanguage } from "../notify/notification-strings.js";
import { logDbFailure } from "../report-db-failure.js";

export interface ProposalPushMailFields {
  emailId?: string;
  pendingActionId?: string;
}

const MAX_ID_LENGTH = 200;

/** The mail id a reply draft names (`send_email` + `in_reply_to_email_id`), as the model wrote it. */
function replyTargetOf(toolName: string, toolArgs: unknown): string | null {
  if (toolName !== "send_email") return null;
  if (!toolArgs || typeof toolArgs !== "object") return null;
  const raw = (toolArgs as Record<string, unknown>).in_reply_to_email_id;
  if (typeof raw !== "string") return null;
  const replyTo = raw.trim();
  return replyTo && replyTo.length <= MAX_ID_LENGTH ? replyTo : null;
}

export async function proposalPushMailFields(
  userId: string,
  toolName: string,
  toolArgs: unknown,
  pendingActionId: string,
): Promise<ProposalPushMailFields> {
  const replyTo = replyTargetOf(toolName, toolArgs);
  if (!replyTo) return {};
  try {
    // Same lookup tool-executor's send_email uses to pick the sending account:
    // the context hands the model either the Klorn row id or the provider id.
    const email = await prisma.emailMessage.findFirst({
      where: { userId, OR: [{ id: replyTo }, { gmailId: replyTo }] },
      select: { id: true },
    });
    if (!email) return {};
    return { emailId: email.id, pendingActionId };
  } catch (err) {
    // A deep link is a convenience: the push still goes out, just as it did
    // before this existed (opening the proposal's chat).
    logDbFailure("[AGENT] proposal push mail link failed", err);
    return {};
  }
}

export interface ProposalPushContent extends ProposalPushMailFields {
  title: string;
  body: string;
  presentation?: NotificationPresentation;
}

/**
 * The whole device push of an approval. NOTIFY_PUSH_PRESENTATION open to the
 * user and the proposal a reply draft to one of their stored mails: the NT0
 * agent copy — "답장 초안 준비됨 · <person>" / the draft's first line in quotes
 * (only while NOTIFY_PUSH_QUOTE is open: it is message text through Apple's and
 * Google's push services), else a fixed line — plus the mail's thread and the
 * sender's display name as fields. Anything else: `fallback` and the native
 * deep link, exactly as before.
 */
export async function proposalPushContent(
  userId: string,
  toolName: string,
  toolArgs: unknown,
  pendingActionId: string,
  fallback: { title: string; body: string },
): Promise<ProposalPushContent> {
  if (!pushPresentationOpenTo(userId)) {
    return {
      ...fallback,
      ...(await proposalPushMailFields(userId, toolName, toolArgs, pendingActionId)),
    };
  }
  const replyTo = replyTargetOf(toolName, toolArgs);
  if (!replyTo) return { ...fallback };
  try {
    const email = await prisma.emailMessage.findFirst({
      where: { userId, OR: [{ id: replyTo }, { gmailId: replyTo }] },
      select: { id: true, from: true, threadId: true },
    });
    if (!email) return { ...fallback };
    const draft = (toolArgs as Record<string, unknown>).body;
    const copy = agentDraftPushCopy({
      from: email.from,
      draft: typeof draft === "string" ? draft : null,
      allowQuote: pushQuoteOpenTo(userId),
      language: await getUserNotificationLanguage(userId),
    });
    const name = presentedDisplayName(email.from);
    return {
      ...copy,
      emailId: email.id,
      pendingActionId,
      presentation: {
        kind: "agent",
        ...(name ? { senderDisplayName: name } : {}),
        ...(email.threadId ? { threadId: email.threadId } : {}),
      },
    };
  } catch (err) {
    // As proposalPushMailFields: the push still goes out, as it did before.
    logDbFailure("[AGENT] proposal push mail link failed", err);
    return { ...fallback };
  }
}
