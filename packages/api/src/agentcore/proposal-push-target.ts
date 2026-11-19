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
import { boundedFromValue, extractEmailAddress } from "../mail/email-address.js";
import { agentDraftPushCopy } from "../notify/kind-push-copy.js";
import { kindPushCopy } from "../notify/kind-push-strings.js";
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
  /** The old text when title / body are NT0 copy: what the push noise policy judges (push.ts). */
  policyText?: { title: string; body: string };
}

/** How much of a `to` value is read, and how many recipients at most. */
const TO_SCAN = 2000;
const TO_MAX = 50;

/** The draft's recipients as bare lowercased addresses (a string list or an array). */
function recipientsOf(toolArgs: Record<string, unknown>): Set<string> {
  const raw = toolArgs.to;
  const parts = Array.isArray(raw)
    ? raw.filter((part): part is string => typeof part === "string")
    : typeof raw === "string"
      ? raw.slice(0, TO_SCAN).split(/[,;]/)
      : [];
  return new Set(
    parts
      .slice(0, TO_MAX)
      .map((part) => extractEmailAddress(part.slice(0, TO_SCAN)))
      .filter(Boolean),
  );
}

/** Text shown instead of `fallback`, with `fallback` kept for the noise policy when they differ. */
function shownAs(
  fallback: { title: string; body: string },
  shown: { title: string; body: string },
): Pick<ProposalPushContent, "title" | "body" | "policyText"> {
  const same = shown.title === fallback.title && shown.body === fallback.body;
  return { ...shown, ...(same ? {} : { policyText: fallback }) };
}

/**
 * The whole device push of an approval. NOTIFY_PUSH_PRESENTATION closed to the
 * user: `fallback` and the native deep link, exactly as before. Open:
 *   - a reply draft to one of their stored mails, addressed to that mail's
 *     sender: the NT0 agent copy — "답장 초안 준비됨 · <person>" / the draft's
 *     first line in quotes — plus the thread and the sender's display name;
 *   - any other send_email proposal: `fallback`, with the deep link when it
 *     names a stored mail (a draft whose recipient is not the mail's sender
 *     does not name that sender);
 *   - while NOTIFY_PUSH_QUOTE is closed, no send_email push carries model text
 *     as its body (the draft or a restatement of it is message content through
 *     Apple's and Google's push services): a fixed line instead;
 *   - every other tool: `fallback`.
 * Whatever is shown, the noise policy judges the old text (policyText), so the
 * copy flag never changes whether a push rings.
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
  if (toolName !== "send_email" || !toolArgs || typeof toolArgs !== "object") {
    return { ...fallback };
  }
  const args = toolArgs as Record<string, unknown>;
  const language = await getUserNotificationLanguage(userId);
  const allowQuote = pushQuoteOpenTo(userId);
  const plain = shownAs(
    fallback,
    allowQuote ? fallback : { title: fallback.title, body: kindPushCopy(language).draftReadyLine },
  );
  const replyTo = replyTargetOf(toolName, toolArgs);
  if (!replyTo) return plain;
  try {
    const email = await prisma.emailMessage.findFirst({
      where: { userId, OR: [{ id: replyTo }, { gmailId: replyTo }] },
      select: { id: true, from: true, threadId: true },
    });
    if (!email) return plain;
    const link = { emailId: email.id, pendingActionId };
    const sender = extractEmailAddress(boundedFromValue(email.from ?? ""));
    if (!sender || !recipientsOf(args).has(sender)) return { ...plain, ...link };
    const copy = agentDraftPushCopy({
      from: email.from,
      draft: typeof args.body === "string" ? args.body : null,
      allowQuote,
      language,
    });
    const name = presentedDisplayName(email.from);
    return {
      ...shownAs(fallback, copy),
      ...link,
      presentation: {
        kind: "agent",
        ...(name ? { senderDisplayName: name } : {}),
        ...(email.threadId ? { threadId: email.threadId } : {}),
      },
    };
  } catch (err) {
    // As proposalPushMailFields: the push still goes out, as it did before.
    logDbFailure("[AGENT] proposal push mail link failed", err);
    return plain;
  }
}
