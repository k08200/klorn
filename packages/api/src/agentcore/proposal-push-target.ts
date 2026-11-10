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
import { prisma } from "../db.js";

export interface ProposalPushMailFields {
  emailId?: string;
  pendingActionId?: string;
}

const MAX_ID_LENGTH = 200;

export async function proposalPushMailFields(
  userId: string,
  toolName: string,
  toolArgs: unknown,
  pendingActionId: string,
): Promise<ProposalPushMailFields> {
  if (toolName !== "send_email") return {};
  if (!toolArgs || typeof toolArgs !== "object") return {};
  const raw = (toolArgs as Record<string, unknown>).in_reply_to_email_id;
  if (typeof raw !== "string") return {};
  const replyTo = raw.trim();
  if (!replyTo || replyTo.length > MAX_ID_LENGTH) return {};
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
    console.warn(
      "[AGENT] proposal push mail link failed:",
      err instanceof Error ? err.message : String(err),
    );
    return {};
  }
}
