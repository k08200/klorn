import { mintReceipt, sendEmailPayloadHash } from "../judge/attention-floor.js";
import { executeToolCall } from "./tool-executor.js";

// A single RFC-ish email address: no whitespace, comma, semicolon, or angle
// brackets, exactly one "@", and a dotted domain. Rejects a crafted From header
// that smuggles multiple recipients (e.g. "a@x.com, b@evil.com") into an
// autonomous send.
const SINGLE_EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/**
 * Why an auto-reply was not sent:
 *  - "error": the send ran and the provider/executor refused it ({ error }).
 *  - "unsupported": the mailbox has no send surface yet ({ unsupported: true }).
 *  - "unrecognized": the executor's answer was not a provable success (not JSON,
 *    wrong shape, truncated) — unproven is treated as not sent.
 */
export type AutoReplyNotSentReason = "error" | "unsupported" | "unrecognized";

/**
 * Thrown by sendAutoReplyViaFloor when the send did not provably succeed.
 * executeToolCall reports a provider failure as a RETURNED result, not a throw,
 * so without this a caller cannot tell "sent" from "refused" and would record a
 * reply that never left.
 */
export class AutoReplyNotSentError extends Error {
  // The message carries the reason code ONLY. The provider's error text can
  // contain the recipient address or host details, and this error is logged
  // and sent to Sentry.
  constructor(public readonly reason: AutoReplyNotSentReason) {
    super(`auto-reply was not sent (${reason})`);
    this.name = "AutoReplyNotSentError";
  }
}

/**
 * Classify executeToolCall("send_email")'s result string against the provider
 * SendMailResult union (mail/providers/types.ts):
 *   { success: true, … } | { error } | { unsupported: true, error }
 * plus the executor's own catch, which folds a thrown provider error into
 * { error }. Only `success === true` with no `error` and no `unsupported` is a
 * sent reply; everything else throws.
 */
function assertSendSucceeded(raw: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AutoReplyNotSentError("unrecognized");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AutoReplyNotSentError("unrecognized");
  }
  const result = parsed as Record<string, unknown>;
  if ("unsupported" in result) throw new AutoReplyNotSentError("unsupported");
  if ("error" in result) throw new AutoReplyNotSentError("error");
  if (result.success !== true) throw new AutoReplyNotSentError("unrecognized");
}

/**
 * Whether `to` is a single, sendable address. Exported so callers that write
 * a ledger BEFORE sending (auto-mode sweep) can refuse a malformed recipient
 * up front instead of recording a send that the guard below will reject.
 */
export function isSingleRecipient(to: string): boolean {
  return SINGLE_EMAIL_RE.test(to.trim());
}

/**
 * Send an autonomous AUTO_REPLY through the deterministic floor instead of
 * calling gmail.sendEmail directly.
 *
 * A user-configured AUTO_REPLY rule firing IS the authorization for the send,
 * but the body is LLM-authored and the send is irreversible — so it must take
 * the same gated path every other send does. We mint an ActionReceipt that
 * binds the exact bytes (payloadHash) and route through executeToolCall, whose
 * central guard re-verifies that hash before anything leaves Gmail. This closes
 * the floor bypass (W1) where a matched rule sent LLM-authored mail with no
 * receipt, no payloadHash check, and no audit trail.
 *
 * Resolves ONLY when the provider accepted the send; otherwise rejects with
 * AutoReplyNotSentError (see assertSendSucceeded). Floor refusals thrown by the
 * executor propagate unchanged.
 */
export async function sendAutoReplyViaFloor(
  userId: string,
  to: string,
  subject: string,
  body: string,
  // The EmailMessage id being replied to. The executor resolves the source row
  // server-side and sends from THAT account (per-account routing, Phase 1) —
  // routing metadata only, deliberately outside the hashed payload bytes.
  inReplyToEmailId?: string,
): Promise<void> {
  const recipient = to.trim();
  if (!SINGLE_EMAIL_RE.test(recipient)) {
    // Refuse rather than send: a non-single-address recipient means the From
    // header it was derived from is malformed or crafted (multi-recipient
    // smuggling). The caller's try/catch logs the skip.
    throw new Error(`auto-reply recipient is not a single valid address: ${to}`);
  }
  const receipt = mintReceipt({
    action: "send_email",
    // Metadata-only for autonomous sends — verifyReceipt checks payloadHash,
    // not inputHash (same as legacy/manual approval flows).
    inputHash: "",
    payloadHash: sendEmailPayloadHash({ to: recipient, subject, body }),
    target: recipient.toLowerCase(),
    approvedAt: new Date(),
    approvedBy: userId,
  });
  const result = await executeToolCall(
    userId,
    "send_email",
    {
      to: recipient,
      subject,
      body,
      ...(inReplyToEmailId ? { in_reply_to_email_id: inReplyToEmailId } : {}),
    },
    receipt,
  );
  assertSendSucceeded(result);
}
