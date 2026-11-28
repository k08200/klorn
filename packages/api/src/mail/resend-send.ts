/**
 * Resend's SDK (6.x) does not throw when a send fails. A refusal (4xx), a
 * server error (5xx), a rate limit or a network failure comes back as
 * `{ data: null, error }`, so a sender that only awaits the call inside a
 * try/catch reports every one of those as sent. `requireResendAccepted` turns
 * the answer into the data or a throw, so each sender's existing catch is
 * where every failure lands, whatever its contract (false, "failed", ok:false).
 *
 * The thrown ResendSendError carries facts only, which the failure reporters
 * print (db-failure-facts.ts reads `code` and `statusCode`): Resend's error
 * name as an upper-case code (RATE_LIMIT_EXCEEDED) and the HTTP status. Never
 * Resend's message: it can quote the request, an address included.
 *
 * It also says whether the refusal is permanent, for the callers that retry
 * (notify/welcome-email.ts, pim/daily-digest.ts). Permanent means the
 * recipient: Resend refused the `to` address itself, so the same mail to that
 * address would be refused again. Everything else is retried, because nothing
 * about the recipient is wrong and the mail goes out once the cause clears —
 * including refusals of Klorn's own request (a bad FROM/reply-to env value, an
 * empty field from a Klorn bug), which hit every recipient and end with a fix:
 *
 * | Resend's answer                                              | class     |
 * | ------------------------------------------------------------ | --------- |
 * | validation_error 400/422 whose message names the `to` field  | permanent |
 * | validation_error naming another field or the API key         | retry     |
 * | invalid_parameter, missing_required_field/_parameter,        | retry     |
 * | invalid_attachment, invalid_idempotency_key (Klorn's request)|           |
 * | 401 / 403 (key missing, restricted, invalid, suspended;      | retry     |
 * | unverified domain; testing-mode account)                     |           |
 * | invalid_from_address (FROM_EMAIL), quotas, 429 rate limit    | retry     |
 * | 404 / 405 (endpoint), 409 (idempotency key in flight/reused) | retry     |
 * | 5xx, no status (network), no answer in time, no data         | retry     |
 * | any name not listed above                                    | retry     |
 *
 * Names and statuses are Resend's documented ones
 * (resend.com/docs/api-reference/errors, read 2026-11-18) and the SDK's
 * RESEND_ERROR_CODE_KEY (resend 6.38.1); "Invalid `to` field" is Resend's
 * wording for an address it will not take. Anything unrecognised retries on
 * purpose: a wrong "retry" costs one more attempt (bounded by each caller), a
 * wrong "permanent" stops the mail for good — for every user, when the cause
 * is Klorn's. A bounce or a suppressed address is not an answer to the send:
 * the API accepts the mail and reports the bounce later, so it is not here.
 *
 * The Klorn mailbox's calls (klorn-inbound-resend.ts) classify the same answer
 * for retries through callResend and do not use this.
 */

import type { ErrorResponse } from "resend";

/** Resend's error names are snake_case tokens (rate_limit_exceeded); a code is at most 40 characters. */
const RESEND_ERROR_NAME = /^[a-z][a-z0-9_]{1,39}$/;

/**
 * How long one send may take before it counts as failed (retryable) and its
 * request is aborted. Ten seconds is the Klorn mailbox's per-call budget
 * (routes/klorn-mailbox-inbound.ts RESEND_TIMEOUT_MS): Resend answers an
 * accepted send in well under a second, but on Render Free's 0.1 CPU a cold
 * TLS handshake alone can take seconds, and a tighter bound would turn slow
 * successes into failures (and a retried welcome or digest into a duplicate
 * when the slow send did land). It is also the most a request that awaits a
 * mail (/resend-verification, forgot-password, approving a waitlist entry)
 * waits on Resend.
 *
 * A timeout is ambiguous: Resend may still deliver a mail whose request was
 * aborted. The welcome and the digest retry under an idempotency key for
 * that. The reset, verification and org-invite callers treat it as not sent
 * and put the previous link back (or drop the invite), so a send slower than
 * this that still lands arrives with a dead link and the user asks again.
 * Accepted: past ten seconds Resend is in an incident far more often than
 * merely slow, and before this bound the same request waited on undici's
 * 300-second header timeout, longer than any client holds the page open.
 */
export const RESEND_SEND_TIMEOUT_MS = 10_000;

/** 401/403 validation_error is Klorn's key or domain, not the recipient. */
const RECIPIENT_REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 422]);
/**
 * Resend's message naming the `to` field ("Invalid `to` field. The email
 * address needs to follow…"). The non-word character before "to" keeps
 * "`reply_to` field" out.
 */
const NAMES_TO_FIELD = /(?:^|\W)to`?\s+field\b/i;

function statusOf(error: ErrorResponse | null): number | null {
  return Number.isInteger(error?.statusCode) ? Number(error?.statusCode) : null;
}

function isPermanentRefusal(error: ErrorResponse | null): boolean {
  if (error?.name !== "validation_error") return false;
  const status = statusOf(error);
  if (status === null || !RECIPIENT_REFUSAL_STATUSES.has(status)) return false;
  // Read only to classify; the message never leaves this function.
  return typeof error.message === "string" && NAMES_TO_FIELD.test(error.message);
}

/** A send Resend did not accept, reduced to its code, status and class. */
export class ResendSendError extends Error {
  /**
   * Resend's error name, upper-cased (RATE_LIMIT_EXCEEDED); RESEND_TIMEOUT when
   * no answer came in time, RESEND_NO_DATA or RESEND_ERROR otherwise.
   */
  readonly code: string;
  /** The HTTP status Resend answered with; null for a network failure or a timeout. */
  readonly statusCode: number | null;
  /** True when the same mail would be refused again (see the table above). */
  readonly permanent: boolean;

  constructor(error: ErrorResponse | null, timedOut = false) {
    super(timedOut ? "Resend did not answer in time" : "Resend did not accept the mail");
    this.name = "ResendSendError";
    this.code = timedOut ? "RESEND_TIMEOUT" : resendErrorCode(error);
    this.statusCode = timedOut ? null : statusOf(error);
    this.permanent = !timedOut && isPermanentRefusal(error);
  }
}

function resendErrorCode(error: ErrorResponse | null): string {
  if (!error) return "RESEND_NO_DATA";
  const name: unknown = error.name;
  return typeof name === "string" && RESEND_ERROR_NAME.test(name)
    ? name.toUpperCase()
    : "RESEND_ERROR";
}

/** What a sender passes to `resend.emails.send(payload, options)`. */
export interface ResendRequestOptions {
  signal: AbortSignal;
  idempotencyKey?: string;
}

type ResendAnswer<T> = { data: T | null; error: ErrorResponse | null };

export interface ResendSendOptions {
  /**
   * Resend's Idempotency-Key: a repeat of the same mail under the same key
   * within 24 hours answers with the first send instead of sending again, so a
   * retry after a timed-out send that did land is not a second mail.
   */
  idempotencyKey?: string;
}

/**
 * The data of an accepted send; throws ResendSendError for anything else.
 * `send` gets the abort signal (and the idempotency key) to hand to Resend.
 * The race is the bound even if a send ignores the signal; the SDK answers an
 * aborted fetch with its network error, which is reported as the timeout.
 */
export async function requireResendAccepted<T>(
  send: (options: ResendRequestOptions) => Promise<ResendAnswer<T>>,
  options: ResendSendOptions = {},
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, RESEND_SEND_TIMEOUT_MS);
  });
  const requestOptions: ResendRequestOptions = options.idempotencyKey
    ? { signal: controller.signal, idempotencyKey: options.idempotencyKey }
    : { signal: controller.signal };
  try {
    const answer = await Promise.race([send(requestOptions), timedOut]);
    if (answer === "timeout" || controller.signal.aborted) throw new ResendSendError(null, true);
    if (answer.error || !answer.data) throw new ResendSendError(answer.error);
    return answer.data;
  } finally {
    clearTimeout(timer);
  }
}
