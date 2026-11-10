/**
 * The deterministic floor for USER-INITIATED sends — POST /api/email/send and
 * POST /api/email/:id/reply — behind MANUAL_SEND_RECEIPTS_ENABLED (OFF).
 *
 * CLAUDE.md: "the 3 real-world actions (send / delete / forward) always produce
 * an ActionReceipt with a payload hash", and the OAuth limited-use disclosure
 * tells Google every send executes against a receipt of the approved bytes. The
 * agent path does that (receipt minted at /approve, stored on PendingAction /
 * ActionOutbox, verified by tool-executor). The two manual routes called the
 * provider directly and left no receipt.
 *
 * For a manual send the user's confirm is the approval and the request carries
 * the approved bytes, so there is no approve/execute gap to bridge across
 * requests. What the floor still owes here is (a) the receipt itself — the same
 * ActionReceipt shape and the same sendEmailPayloadHash, so a client that hashes
 * what it showed the user (the mobile confirm sheet does) gets the same hex — (b)
 * written durably BEFORE anything leaves, so no send exists without one, and (c)
 * the bytes handed to the provider verified against it, so a later edit that
 * changes them between confirm and send (a signature, a rewrite) is refused
 * instead of sent unsigned.
 *
 * The hash is v1 over { to, subject, body } exactly as the agent path's: the
 * reply's threading (thread id, In-Reply-To) is server-resolved from the user's
 * own row, not supplied by an agent, so the plan's rule for agent-supplied reply
 * context (docs/providers/unified-platform-plan.md, A4) does not apply and
 * RECEIPT_SCHEMA_VERSION is not bumped. The source email id and the account are
 * stored beside the receipt for audit. Attachments are not covered by the v1 hash,
 * which is why POST /compose (multipart attachments) is not wired here.
 */

import type { SendReceiptWire } from "@klorn/contract";
import { manualSendReceiptsEnabled } from "../config.js";
import { prisma } from "../db.js";
import {
  type ActionReceipt,
  mintReceipt,
  sendEmailPayloadHash,
  verifyReceipt,
} from "../judge/attention-floor.js";
import { captureError } from "../sentry.js";

export interface SendReceiptInput {
  userId: string;
  route: "send" | "reply";
  to: string;
  subject: string;
  body: string;
  /** "primary" or the LinkedInboxAccount id the mail leaves from. */
  inbox: string;
  /** The EmailMessage being answered: reply, or send with `inReplyToEmailId`. */
  emailId?: string | null;
}

export interface SendReceiptHandle {
  id: string;
  receipt: ActionReceipt;
}

/** The 503 a route answers when the receipt cannot be written (nothing was sent). */
export const SEND_RECEIPT_UNAVAILABLE_MESSAGE =
  "Could not record the send receipt, so nothing was sent. Please try again.";

/** The receipt outcome a provider's send result stands for. */
export function outcomeOfSend(result: unknown): SendReceiptOutcome {
  if (result && typeof result === "object" && "success" in result && result.success === true) {
    const messageId = (result as { messageId?: unknown }).messageId;
    return { status: "SENT", providerMessageId: typeof messageId === "string" ? messageId : null };
  }
  return { status: "REFUSED" };
}

export type SendReceiptOutcome =
  | { status: "SENT"; providerMessageId?: string | null }
  | { status: "REFUSED" }
  | { status: "UNKNOWN" };

/**
 * Mint and persist the receipt for a send that is about to happen. null while
 * the flag is off (nothing written). Throws when the write fails — the caller
 * must then refuse the send: a receipt that does not exist cannot be the floor.
 */
export async function openSendReceipt(input: SendReceiptInput): Promise<SendReceiptHandle | null> {
  if (!manualSendReceiptsEnabled()) return null;
  const payloadHash = sendEmailPayloadHash({
    to: input.to,
    subject: input.subject,
    body: input.body,
  });
  const receipt = mintReceipt({
    action: "send_email",
    // Metadata only (verifyReceipt checks payloadHash): a manual send is not
    // classifier-driven, as for the legacy approval and auto-reply paths.
    inputHash: "",
    payloadHash,
    target: input.to.trim().toLowerCase(),
    approvedAt: new Date(),
    approvedBy: input.userId,
  });
  const row = await prisma.sendReceipt.create({
    data: {
      userId: input.userId,
      route: input.route,
      action: receipt.action,
      payloadHash,
      receipt: receipt as unknown as object,
      inbox: input.inbox,
      emailId: input.emailId ?? null,
      status: "PENDING",
    },
    select: { id: true },
  });
  return { id: row.id, receipt };
}

/**
 * Verify the bytes about to be handed to the provider against the receipt.
 * Throws ActionReceiptMismatchError on any difference — the send is refused.
 */
export function assertSendMatchesReceipt(
  handle: SendReceiptHandle,
  payload: { to: string; subject: string; body: string },
): void {
  verifyReceipt(handle.receipt, {
    action: "send_email",
    currentPayloadHash: sendEmailPayloadHash(payload),
  });
}

/**
 * The route-side check, right before the provider call: on a mismatch the
 * receipt is settled REFUSED (nothing left) and the error propagates, so the
 * request fails loud and nothing is sent.
 */
export async function verifySendOrRefuse(
  handle: SendReceiptHandle,
  userId: string,
  payload: { to: string; subject: string; body: string },
): Promise<void> {
  try {
    assertSendMatchesReceipt(handle, payload);
  } catch (err) {
    await settleSendReceipt(handle, userId, { status: "REFUSED" });
    throw err;
  }
}

/**
 * Record the outcome. Fail-soft: by now the provider has answered (or the mail
 * may have gone out), so a bookkeeping miss must never turn into a failed
 * response — the row then stays PENDING, which reads as "may have gone out".
 * Scoped by owner and to a PENDING row, so a settle never rewrites a settled one.
 */
export async function settleSendReceipt(
  handle: SendReceiptHandle,
  userId: string,
  outcome: SendReceiptOutcome,
): Promise<void> {
  try {
    await prisma.sendReceipt.updateMany({
      where: { id: handle.id, userId, status: "PENDING" },
      data: {
        status: outcome.status,
        ...(outcome.status === "SENT"
          ? { providerMessageId: outcome.providerMessageId ?? null }
          : {}),
        completedAt: new Date(),
      },
    });
  } catch (err) {
    captureError(err, {
      tags: { scope: "send-receipt.settle" },
      extra: { userId, receiptId: handle.id },
    });
  }
}

export function sendReceiptWire(handle: SendReceiptHandle): SendReceiptWire {
  return {
    id: handle.id,
    v: handle.receipt.v,
    action: "send_email",
    payloadHash: handle.receipt.payloadHash,
    approvedAt: handle.receipt.approvedAt,
  };
}
