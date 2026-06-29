import { mintReceipt, sendEmailPayloadHash } from "./attention-floor.js";
import { executeToolCall } from "./tool-executor.js";

// A single RFC-ish email address: no whitespace, comma, semicolon, or angle
// brackets, exactly one "@", and a dotted domain. Rejects a crafted From header
// that smuggles multiple recipients (e.g. "a@x.com, b@evil.com") into an
// autonomous send.
const SINGLE_EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

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
 */
export async function sendAutoReplyViaFloor(
  userId: string,
  to: string,
  subject: string,
  body: string,
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
  await executeToolCall(userId, "send_email", { to: recipient, subject, body }, receipt);
}
