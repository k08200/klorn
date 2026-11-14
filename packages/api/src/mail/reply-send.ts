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
import type { SendMailResult } from "./providers/types.js";
import { pickInReplyTo } from "./reply-headers.js";
import { markEmailReplied } from "./reply-state.js";
import { resolveReplyThreading } from "./reply-threading.js";
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

/**
 * Why the same bytes to the same mail were not sent again: an earlier send of
 * them is still going out, went out, or could not tell whether it went.
 */
export type RepeatState = "in_progress" | "sent" | "outcome_unknown";

export type ReplySendOutcome =
  | { kind: "not_found" }
  | { kind: "payload_mismatch" }
  | { kind: "repeat"; state: RepeatState }
  | { kind: "receipt_unavailable" }
  | { kind: "outcome_unknown" }
  | { kind: "unsupported"; error: string }
  | { kind: "refused"; result: SendMailResult }
  | { kind: "sent"; response: Record<string, unknown> };

/** How long the same reply to the same mail counts as a repeat, not a new send. */
export const REPEAT_SEND_WINDOW_MS = 10 * 60_000;

/**
 * How long a PENDING receipt counts as a send still in flight. Its provider call
 * runs between the receipt insert and the settle; one still PENDING after this
 * never settled (the settle failed, or the process died after the provider
 * call) and reads as "may have gone out" (send-receipt.ts settleSendReceipt).
 */
export const PENDING_IN_FLIGHT_MS = 2 * 60_000;

/**
 * A receipt as a repeat: only SENT is "sent". PENDING is in flight while young,
 * then unknown; UNKNOWN is a send the provider could not confirm either way.
 */
function repeatStateOf(prior: { status: string; createdAt: Date }): RepeatState {
  if (prior.status === "SENT") return "sent";
  if (prior.status !== "PENDING") return "outcome_unknown";
  const inFlight = Date.now() - prior.createdAt.getTime() < PENDING_IN_FLIGHT_MS;
  return inFlight ? "in_progress" : "outcome_unknown";
}

/**
 * The latest receipt for these exact bytes to this mail, not refused, within
 * the window, as a repeat state; null when there is none.
 */
async function priorSendMomentsAgo(
  userId: string,
  emailId: string,
  payloadHash: string,
): Promise<RepeatState | null> {
  const prior = await prisma.sendReceipt.findFirst({
    where: {
      userId,
      emailId,
      payloadHash,
      status: { in: ["PENDING", "SENT", "UNKNOWN"] },
      createdAt: { gte: new Date(Date.now() - REPEAT_SEND_WINDOW_MS) },
    },
    orderBy: { createdAt: "desc" },
    select: { status: true, createdAt: true },
  });
  return prior ? repeatStateOf(prior) : null;
}

async function openReceipt(
  input: ReplySendInput,
  receiptInput: SendReceiptInput,
): Promise<SendReceiptHandle | null> {
  return input.receipt === "required"
    ? recordSendReceipt(receiptInput)
    : openSendReceipt(receiptInput);
}

type ReceiptStep = { receipt: SendReceiptHandle | null } | ReplySendOutcome;

/**
 * Deterministic floor: the receipt binds the recipient and subject derived from
 * the user's row and the body the user confirmed, and is written before
 * anything leaves. No receipt, no send. null only in "if-enabled" mode with the
 * flag off — then nothing after it changes.
 */
async function writeReceipt(
  input: ReplySendInput,
  receiptInput: SendReceiptInput,
): Promise<ReceiptStep> {
  try {
    return { receipt: await openReceipt(input, receiptInput) };
  } catch (err) {
    captureError(err, {
      tags: { scope: "email-replies.receipt" },
      extra: { userId: input.userId, emailId: receiptInput.emailId, route: input.route },
    });
    return { kind: "receipt_unavailable" };
  }
}

/**
 * The repeat check and the receipt write, under the send claim (send-claim.ts):
 * of two requests for the same bytes to the same mail, only the one holding the
 * claim runs them, so they cannot both find "nothing sent yet". The claim is
 * released once the receipt is written or refused; from then on that receipt
 * is what the next request's check finds. No provider call runs under it.
 */
async function writeClaimedReceipt(
  input: ReplySendInput,
  receiptInput: SendReceiptInput & { emailId: string },
  payloadHash: string,
): Promise<ReceiptStep> {
  const key = { userId: input.userId, emailId: receiptInput.emailId, payloadHash };
  let claim: SendClaim | null;
  try {
    claim = await claimSend(key);
  } catch (err) {
    // Nothing was written, so nothing can go out: the answer for a receipt that
    // cannot be written.
    captureError(err, {
      tags: { scope: "email-replies.send-claim" },
      extra: { userId: input.userId, emailId: key.emailId, route: input.route },
    });
    return { kind: "receipt_unavailable" };
  }
  // Another request holds the claim for these bytes to this mail: nothing of
  // theirs has gone out yet, so this is "still sending", never "already sent".
  // (A holder that died reads the same until its claim goes stale,
  // SEND_CLAIM_STALE_MS; nothing was sent then either.)
  if (!claim) return { kind: "repeat", state: "in_progress" };
  try {
    const prior = await priorSendMomentsAgo(input.userId, key.emailId, payloadHash);
    if (prior) return { kind: "repeat", state: prior };
    return await writeReceipt(input, receiptInput);
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
  // With a receipt on every send, the same bytes to the same mail moments ago
  // (a double tap, a second tab, a retry after "may have been sent") are a repeat.
  // This early read skips the provider calls below; the decisive check runs
  // again under the claim, right before the receipt is written.
  if (input.receipt === "required") {
    const prior = await priorSendMomentsAgo(uid, dbEmail.id, payloadHash);
    if (prior) return { kind: "repeat", state: prior };
  }

  // RFC822 Message-ID isn't stored — fetch it live so In-Reply-To/References
  // are correct (reply-threading.ts). A message from a linked secondary inbox
  // lives on THAT account (#757).
  const actions = await mailActionsFor(uid, dbEmail.linkedInboxAccountId);
  const threading = await resolveReplyThreading(actions, uid, dbEmail);

  const receiptInput = {
    userId: uid,
    route: input.route,
    to,
    subject,
    body,
    inbox: dbEmail.linkedInboxAccountId ?? "primary",
    emailId: dbEmail.id,
  };
  // "required" (the smart action): check and write atomically, under the claim.
  // "if-enabled" (POST /api/email/:id/reply): no repeat check, no claim, as before.
  const step =
    input.receipt === "required"
      ? await writeClaimedReceipt(input, receiptInput, payloadHash)
      : await writeReceipt(input, receiptInput);
  if ("kind" in step) return step;
  const { receipt } = step;

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
