/**
 * Act on one stored mail's List-Unsubscribe targets, most automatic first:
 * RFC 8058 one-click POST (server-side, SSRF-guarded in ./list-unsubscribe),
 * else a mailto send from the user's own account — the account the mail came
 * in through, never assumed to be the primary — else the browser link handed
 * back for the user to open.
 *
 * Every method that was tried and did not work is reported in `skipped` with a
 * code (docs/design/mail-cleanup-actions.md, PR1): a failed one-click used to fall
 * through silently, so a "link" answer could not say why nothing automatic
 * worked. The codes are fixed strings, never a provider's or a list's text.
 *
 * The mailto is a send from the user's account, so it takes the send floor of the
 * manual routes (send-receipt.ts): behind MANUAL_SEND_RECEIPTS_ENABLED, a receipt
 * of the exact bytes is written before anything leaves (route "unsubscribe"),
 * verified against what is handed to the provider, and settled with the outcome.
 * No receipt, no send. With the flag off nothing is written, as for those routes.
 *
 * Shared by POST /api/email/:id/unsubscribe and the Subscriptions page's
 * per-sender unsubscribe. User-initiated only: the flag-gated automatic path
 * (AUTO_UNSUBSCRIBE_ENABLED) is separate and one-click-only.
 */

import type { EmailUnsubscribeResponse, EmailUnsubscribeSkip } from "@klorn/contract";
import { captureDbFailure } from "../report-db-failure.js";
import {
  executeOneClickUnsubscribe,
  isKnownOneClickFailure,
  parseMailtoTarget,
} from "./list-unsubscribe.js";
import { mailActionsFor } from "./providers/dispatch.js";
import type { SendMailResult } from "./providers/types.js";
import {
  openSendReceipt,
  outcomeOfSend,
  SEND_RECEIPT_UNAVAILABLE_MESSAGE,
  type SendReceiptHandle,
  settleSendReceipt,
  verifySendOrRefuse,
} from "./send-receipt.js";
import { recordSentMessage } from "./sent-messages.js";

/** The stored columns the action reads. */
export interface UnsubscribableEmail {
  id: string;
  linkedInboxAccountId: string | null;
  listUnsubscribeMailto: string | null;
  listUnsubscribeUrl: string | null;
  listUnsubscribeOneClick: boolean;
}

export type UnsubscribeOutcome =
  | { ok: true; body: EmailUnsubscribeResponse }
  | { ok: false; statusCode: 400 | 502 | 503; error: string };

export const NO_UNSUBSCRIBE_INFO = "This email has no unsubscribe information.";
export const UNSUBSCRIBE_FAILED = "Could not unsubscribe automatically.";

type MailtoSkipCode = Extract<EmailUnsubscribeSkip, { method: "mailto" }>["code"];

/** A one-click failure as reported: a known code, or the generic one (never free text). */
function oneClickSkip(reason: string): EmailUnsubscribeSkip {
  return { method: "one-click", code: isKnownOneClickFailure(reason) ? reason : "request-error" };
}

async function tryOneClick(url: string): Promise<EmailUnsubscribeSkip | null> {
  const result = await executeOneClickUnsubscribe(url);
  if (result.ok) return null;
  const skip = oneClickSkip(result.reason);
  console.warn(`[UNSUBSCRIBE] one-click failed: ${skip.code}`);
  return skip;
}

/** Open the receipt of the mailto bytes. "unavailable" when it cannot be written. */
async function openUnsubscribeReceipt(
  userId: string,
  email: UnsubscribableEmail,
  target: { to: string; subject: string; body: string },
): Promise<SendReceiptHandle | null | "unavailable"> {
  try {
    return await openSendReceipt({
      userId,
      route: "unsubscribe",
      ...target,
      inbox: email.linkedInboxAccountId ?? "primary",
      emailId: email.id,
    });
  } catch (err) {
    captureDbFailure("[UNSUBSCRIBE] send receipt open failed", err, {
      tags: { scope: "email.unsubscribe.receipt" },
      extra: { userId },
    });
    return "unavailable";
  }
}

/** Send the mailto unsubscribe from the mail's own account. null when it went out. */
async function tryMailto(userId: string, email: UnsubscribableEmail, mailto: string) {
  const target = parseMailtoTarget(mailto);
  if (!target) return "invalid-target" satisfies MailtoSkipCode;
  // Resolved before the receipt: a lookup failure then leaves no PENDING receipt
  // ("may have gone out") for a send that never started.
  const actions = await mailActionsFor(userId, email.linkedInboxAccountId);
  const receipt = await openUnsubscribeReceipt(userId, email, target);
  if (receipt === "unavailable") return "receipt-unavailable" satisfies MailtoSkipCode;

  // The exact bytes handed to the provider, verified against the receipt.
  if (receipt) await verifySendOrRefuse(receipt, userId, target);
  let result: SendMailResult;
  try {
    result = await actions.sendEmail(userId, target.to, target.subject, target.body, [], {
      linkedInboxAccountId: email.linkedInboxAccountId,
    });
  } catch (err) {
    // A throw may come after the mail left: the receipt says "unknown", never "refused".
    if (receipt) await settleSendReceipt(receipt, userId, { status: "UNKNOWN" });
    throw err;
  }
  if (receipt) await settleSendReceipt(receipt, userId, outcomeOfSend(result));
  if ("unsupported" in result) return "unsupported" satisfies MailtoSkipCode;
  if ("error" in result) return "send-failed" satisfies MailtoSkipCode;

  // Mark it an unsubscribe: it is not mail the user wrote to that list, and no
  // list answers it, so "waiting on" must skip it.
  if (result.messageId) {
    await recordSentMessage(userId, {
      gmailId: result.messageId,
      threadId: result.threadId ?? null,
      to: target.to,
      subject: target.subject,
      sentAt: new Date(),
      inbox: email.linkedInboxAccountId ?? "primary",
      origin: "unsubscribe",
    });
  }
  return null;
}

const withSkipped = (
  body: EmailUnsubscribeResponse,
  skipped: EmailUnsubscribeSkip[],
): EmailUnsubscribeResponse => (skipped.length > 0 ? { ...body, skipped } : body);

export async function unsubscribeFromEmail(
  userId: string,
  email: UnsubscribableEmail,
): Promise<UnsubscribeOutcome> {
  const url = email.listUnsubscribeUrl;
  const mailto = email.listUnsubscribeMailto;
  if (!url && !mailto) return { ok: false, statusCode: 400, error: NO_UNSUBSCRIBE_INFO };

  const skipped: EmailUnsubscribeSkip[] = [];
  if (email.listUnsubscribeOneClick && url) {
    const skip = await tryOneClick(url);
    if (!skip) return { ok: true, body: { method: "one-click", done: true } };
    // Reported, then on to the next method: the list's POST endpoint being down
    // must not strand the user when a mailto or link target also exists.
    skipped.push(skip);
  }

  if (mailto) {
    const code = await tryMailto(userId, email, mailto);
    if (code === null) {
      return { ok: true, body: withSkipped({ method: "mailto", done: true }, skipped) };
    }
    skipped.push({ method: "mailto", code });
    if (!url && code === "receipt-unavailable") {
      return { ok: false, statusCode: 503, error: SEND_RECEIPT_UNAVAILABLE_MESSAGE };
    }
  }

  if (url) return { ok: true, body: withSkipped({ method: "link", done: false, url }, skipped) };
  return { ok: false, statusCode: 502, error: UNSUBSCRIBE_FAILED };
}
