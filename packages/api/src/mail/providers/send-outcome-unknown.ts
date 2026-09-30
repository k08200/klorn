/**
 * A send that may or may not have reached the recipient: the provider's answer was a
 * 5xx, or never came (timeout, aborted request, network error). Distinct from a
 * rejection, where the provider said no and nothing was sent.
 *
 * Callers must not retry on their own and must tell the user to check the mailbox's
 * Sent folder first: a retry can deliver twice. Today only the Outlook native reply
 * (step B0b) throws it. Gmail has the same gap: a lost answer to its send is reported
 * as a plain failure. That is a follow-up (docs/providers/unified-platform-plan.md).
 *
 * The message carries nothing about the mail; the underlying error is on `cause`.
 */

export class SendOutcomeUnknownError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(
      "The message may already have been sent; the provider's answer was not received.",
      options,
    );
    this.name = "SendOutcomeUnknownError";
  }
}
