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
 * The Klorn mailbox's calls (klorn-inbound-resend.ts) classify the same answer
 * for retries through callResend and do not use this.
 */

import type { ErrorResponse } from "resend";

/** Resend's error names are snake_case tokens (rate_limit_exceeded); a code is at most 40 characters. */
const RESEND_ERROR_NAME = /^[a-z][a-z0-9_]{1,39}$/;

/** A send Resend did not accept, reduced to its code and status. */
export class ResendSendError extends Error {
  /** Resend's error name, upper-cased (RATE_LIMIT_EXCEEDED); RESEND_NO_DATA or RESEND_ERROR otherwise. */
  readonly code: string;
  /** The HTTP status Resend answered with; null for a network failure. */
  readonly statusCode: number | null;

  constructor(error: ErrorResponse | null) {
    super("Resend did not accept the mail");
    this.name = "ResendSendError";
    this.code = resendErrorCode(error);
    this.statusCode = Number.isInteger(error?.statusCode) ? Number(error?.statusCode) : null;
  }
}

function resendErrorCode(error: ErrorResponse | null): string {
  if (!error) return "RESEND_NO_DATA";
  const name: unknown = error.name;
  return typeof name === "string" && RESEND_ERROR_NAME.test(name)
    ? name.toUpperCase()
    : "RESEND_ERROR";
}

/** The data of an accepted send; throws ResendSendError for anything else. */
export async function requireResendAccepted<T>(
  response: Promise<{ data: T | null; error: ErrorResponse | null }>,
): Promise<T> {
  const { data, error } = await response;
  if (error || !data) throw new ResendSendError(error);
  return data;
}
