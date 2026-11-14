/**
 * The one threaded-reply send path for a user's own stored mail: POST
 * /api/email/:id/reply and the smart action's Send (POST
 * /api/smart-actions/emails/:id/reply) both run through `sendReplyToEmail`, so
 * the recipient, the subject, the threading and the deterministic floor
 * (send-receipt.ts) can never drift between them.
 *
 * The recipient and subject are derived from the user's own row, never taken
 * from the request. With `expectedPayloadHash` (the smart action), the caller
 * proves which bytes the user saw: the hash of { to, subject, body } the client
 * showed must equal the hash of what would go out, or nothing is written and
 * nothing leaves. With `receipt: "required"` a receipt is minted whatever
 * MANUAL_SEND_RECEIPTS_ENABLED says, before the provider is called.
 */

import { prisma } from "../db.js";
import { sendEmailPayloadHash } from "../judge/attention-floor.js";
import { noteEmailOutcome } from "../judge/user-outcome.js";
import { recordContactEngagement } from "../learning/contact-engagement.js";
import { captureError } from "../sentry.js";
import { parseAddress } from "./email-address.js";
import { mailActionsFor } from "./providers/dispatch.js";
import { SendOutcomeUnknownError } from "./providers/send-outcome-unknown.js";
import type { MailProviderActions, SendMailResult } from "./providers/types.js";
import { pickInReplyTo } from "./reply-headers.js";
import { markEmailReplied } from "./reply-state.js";
import { type ReplyThreading, resolveReplyThreading } from "./reply-threading.js";
import { claimSend, releaseSend, type SendClaim } from "./send-claim.js";
import {
  openSendReceipt,
  outcomeOfSend,
  recordSendReceipt,
  type SendReceiptHandle,
  type SendReceiptInput,
  sendReceiptWire,
  settleSendReceipt,
  verifySendOrRefuse,
} from "./send-receipt.js";
import { recordSentMessage } from "./sent-messages.js";

export const SEND_OUTCOME_UNKNOWN_MESSAGE =
  "The reply may already have been sent. Check Sent Items before retrying.";

export function extractReplyAddress(raw: string): string {
  return parseAddress(raw)
    .replace(/^["']|["']$/g, "")
    .trim();
}

/** Who a reply to this mail goes to and its subject — what the user is shown and what is hashed. */
export function replyEnvelopeFor(email: { from: string; subject: string }): {
  to: string;
  subject: string;
} {
  return {
    to: extractReplyAddress(email.from),
    subject: email.subject.startsWith("Re:") ? email.subject : `Re: ${email.subject}`,
  };
}

export interface ReplySendInput {
  userId: string;
  /** EmailMessage id or gmailId; only ever looked up inside the user's own rows. */
  emailRef: string;
  body: string;
  /** "if-enabled": MANUAL_SEND_RECEIPTS_ENABLED decides. "required": always minted first. */
  receipt: "if-enabled" | "required";
  route: Extract<SendReceiptInput["route"], "reply" | "smart-reply">;
  /** sendEmailPayloadHash of the { to, subject, body } the client showed the user. */
  expectedPayloadHash?: string;
}

export type ReplySendOutcome =
  | { kind: "not_found" }
  | { kind: "payload_mismatch" }
  | { kind: "repeat" }
  | { kind: "receipt_unavailable" }
  | { kind: "outcome_unknown" }
  | { kind: "unsupported"; error: string }
  | { kind: "refused"; result: SendMailResult }
  | { kind: "sent"; response: Record<string, unknown> };

/** How long the same reply to the same mail counts as a repeat, not a new send. */
export const REPEAT_SEND_WINDOW_MS = 10 * 60_000;

/** A receipt for these exact bytes to this mail, not refused, within the window. */
async function sentMomentsAgo(userId: string, emailId: string, payloadHash: string) {
  const prior = await prisma.sendReceipt.findFirst({
    where: {
      userId,
      emailId,
      payloadHash,
      status: { in: ["PENDING", "SENT", "UNKNOWN"] },
      createdAt: { gte: new Date(Date.now() - REPEAT_SEND_WINDOW_MS) },
    },
    select: { id: true },
  });
  return prior !== null;
}

async function openReceipt(
  input: ReplySendInput,
  receiptInput: SendReceiptInput,
): Promise<SendReceiptHandle | null> {
  return input.receipt === "required"
    ? recordSendReceipt(receiptInput)
    : openSendReceipt(receiptInput);
}

interface ReplyOriginalRow {
  id: string;
  gmailId: string;
  threadId: string | null;
  from: string;
  subject: string;
  linkedInboxAccountId: string | null;
}

interface PreparedSend {
  actions: MailProviderActions;
  threading: ReplyThreading;
  receipt: SendReceiptHandle | null;
}

/** Threading resolved and the receipt written (or not, flag off): all that precedes the provider call. */
async function prepareSend(
  input: ReplySendInput,
  dbEmail: ReplyOriginalRow,
  envelope: { to: string; subject: string },
): Promise<PreparedSend | ReplySendOutcome> {
  const uid = input.userId;
  // RFC822 Message-ID isn't stored — fetch it live so In-Reply-To/References
  // are correct (reply-threading.ts). A message from a linked secondary inbox
  // lives on THAT account (#757).
  const actions = await mailActionsFor(uid, dbEmail.linkedInboxAccountId);
  const threading = await resolveReplyThreading(actions, uid, dbEmail);

  // Deterministic floor: the receipt binds the recipient and subject derived
  // above and the body the user confirmed, and is written before anything
  // leaves. No receipt, no send. null only in "if-enabled" mode with the flag
  // off — then nothing below changes.
  try {
    const receipt = await openReceipt(input, {
      userId: uid,
      route: input.route,
      ...envelope,
      body: input.body,
      inbox: dbEmail.linkedInboxAccountId ?? "primary",
      emailId: dbEmail.id,
    });
    return { actions, threading, receipt };
  } catch (err) {
    captureError(err, {
      tags: { scope: "email-replies.receipt" },
      extra: { userId: uid, emailId: dbEmail.id, route: input.route },
    });
    return { kind: "receipt_unavailable" };
  }
}

/**
 * The repeat check and the receipt write, under the send claim (send-claim.ts):
 * of two requests for the same bytes to the same mail, only the one holding the
 * claim runs them, so they cannot both find "nothing sent yet". The claim is
 * released once the receipt is written or refused; from then on that receipt
 * is what the next request's check finds.
 */
async function prepareClaimedSend(
  input: ReplySendInput,
  dbEmail: ReplyOriginalRow,
  envelope: { to: string; subject: string },
  payloadHash: string,
): Promise<PreparedSend | ReplySendOutcome> {
  const key = { userId: input.userId, emailId: dbEmail.id, payloadHash };
  let claim: SendClaim | null;
  try {
    claim = await claimSend(key, REPEAT_SEND_WINDOW_MS);
  } catch (err) {
    // Nothing was checked or written, so nothing can go out: same answer as a
    // receipt that cannot be written.
    captureError(err, {
      tags: { scope: "email-replies.send-claim" },
      extra: { userId: input.userId, emailId: dbEmail.id, route: input.route },
    });
    return { kind: "receipt_unavailable" };
  }
  // Another request is sending these bytes to this mail right now.
  if (!claim) return { kind: "repeat" };
  try {
    // The same bytes to the same mail moments ago (a double tap, a second tab,
    // a retry after "may have been sent") are a repeat.
    if (await sentMomentsAgo(input.userId, dbEmail.id, payloadHash)) return { kind: "repeat" };
    return await prepareSend(input, dbEmail, envelope);
  } finally {
    await releaseSend(claim);
  }
}

/**
 * Send `body` as a threaded reply to the user's own mail. Throws only what the
 * route should fail loud on: a receipt/payload mismatch at the last check, or a
 * provider error that is not "outcome unknown".
 */
export async function sendReplyToEmail(input: ReplySendInput): Promise<ReplySendOutcome> {
  const { userId: uid, body } = input;
  const dbEmail = await prisma.emailMessage.findFirst({
    where: { userId: uid, OR: [{ id: input.emailRef }, { gmailId: input.emailRef }] },
    select: {
      id: true,
      gmailId: true,
      threadId: true,
      from: true,
      subject: true,
      linkedInboxAccountId: true,
    },
  });
  if (!dbEmail) return { kind: "not_found" };

  const { to, subject } = replyEnvelopeFor(dbEmail);
  const payloadHash = sendEmailPayloadHash({ to, subject, body });
  // The client hashed what it showed. Anything else — a stale card, a recipient
  // the user never saw — is refused before a receipt is written or a byte leaves.
  if (input.expectedPayloadHash !== undefined && payloadHash !== input.expectedPayloadHash) {
    return { kind: "payload_mismatch" };
  }
  // With a receipt on every send, a repeat is refused, and the check is atomic
  // (the claim). The "if-enabled" path (POST /api/email/:id/reply) has no repeat
  // check and takes no claim: it runs exactly as before.
  const prepared =
    input.receipt === "required"
      ? await prepareClaimedSend(input, dbEmail, { to, subject }, payloadHash)
      : await prepareSend(input, dbEmail, { to, subject });
  if ("kind" in prepared) return prepared;
  const { actions, threading, receipt } = prepared;

  // The exact bytes handed to the provider, verified against the receipt.
  if (receipt) await verifySendOrRefuse(receipt, uid, { to, subject, body });
  let result: SendMailResult;
  try {
    // OUTLOOK threads natively from the original's id (step B0b), taken from the
    // row looked up above and never from the URL.
    result = await actions.sendEmail(uid, to, subject, body, [], {
      ...threading,
      linkedInboxAccountId: dbEmail.linkedInboxAccountId,
    });
  } catch (err) {
    // A throw may come after the mail left: the receipt says "unknown", never "refused".
    if (receipt) await settleSendReceipt(receipt, uid, { status: "UNKNOWN" });
    if (!(err instanceof SendOutcomeUnknownError)) throw err;
    // The provider could not say whether the reply went out. Nothing is recorded as
    // answered, and the user is told not to simply retry: that could deliver twice.
    captureError(err, {
      tags: { scope: "email-replies.send-outcome-unknown" },
      extra: { userId: uid, emailId: dbEmail.id, route: input.route },
    });
    return { kind: "outcome_unknown" };
  }
  if (receipt) await settleSendReceipt(receipt, uid, outcomeOfSend(result));
  if ("unsupported" in result) return { kind: "unsupported", error: result.error };
  if ("error" in result) return { kind: "refused", result };

  // Manual reply = genuine engagement with this sender (an importance-graph
  // edge). Only user-initiated routes record this — never the auto-reply path.
  await recordContactEngagement(uid, to, "outbound");
  // The row's reply chip flips to "replied" — a recorded fact.
  await markEmailReplied(uid, dbEmail.id);
  noteEmailOutcome(uid, dbEmail.id, "REPLIED");
  // And the thread joins "waiting on" until they answer (sent-messages.ts).
  if (result.messageId) {
    await recordSentMessage(uid, {
      gmailId: result.messageId,
      threadId: dbEmail.threadId ?? null,
      to,
      subject,
      sentAt: new Date(),
      inbox: dbEmail.linkedInboxAccountId ?? "primary",
      origin: "user",
    });
  }

  // threaded=false means no In-Reply-To was emitted: either no RFC
  // Message-ID was found or none of it parsed as a message id, so the
  // message went by threadId only. Same parser the MIME builder uses, so
  // the flag matches the sent headers. A provider that threaded natively
  // (OUTLOOK, step B0b) says so in its result, and only then. Lets a client
  // tell strict-threaded from best-effort.
  return {
    kind: "sent",
    response: {
      ...result,
      to,
      threaded: result.threaded === true || pickInReplyTo(threading.inReplyTo) !== undefined,
      ...(receipt ? { receipt: sendReceiptWire(receipt) } : {}),
    },
  };
}
