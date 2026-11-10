/**
 * The Klorn mailbox's calls to Resend, and what their failures mean (step E1b of
 * docs/providers/unified-platform-plan.md).
 *
 * - `auth`: 401/403, a key that cannot read received mail. Retry, and report.
 * - `account`: a quota or a sender Resend refuses for this account
 *   (daily_quota_exceeded, monthly_quota_exceeded, invalid_from_address).
 *   Retry, and report: nothing about the message is wrong.
 * - `missing`: 404. Retried while the event is young (Resend may not serve a
 *   message it has just announced), then dropped and reported.
 * - `permanent`: any other 4xx except 408, 409 and 429. Dropped and reported.
 * - `transient`: no status (the SDK's network failure), 408, 409, 429, 5xx.
 *   Retry.
 * - `timeout`: no answer within the call's budget. Retry.
 * - `unexpected`: the client threw. The SDK catches network errors itself and
 *   returns them as an error without a status, so a throw is a bug or an SDK
 *   change. Retry, and report its class.
 */

import type {
  CreateEmailOptions,
  CreateEmailRequestOptions,
  CreateEmailResponse,
  ErrorResponse,
  GetReceivingEmailOptions,
  GetReceivingEmailResponse,
  Resend,
} from "resend";

/**
 * The two Resend calls the mailbox makes. There is no forward: the SDK's forward
 * re-sends the sender's subject (and content) from Klorn's own domain, and
 * downloads the raw message with no abort; system mail gets a notice instead.
 */
export interface InboundResendApi {
  get(id: string, options?: GetReceivingEmailOptions): Promise<GetReceivingEmailResponse>;
  send(
    payload: CreateEmailOptions,
    options?: CreateEmailRequestOptions,
  ): Promise<CreateEmailResponse>;
}

export function inboundResendApi(resend: Resend): InboundResendApi {
  return {
    get: (id, options) => resend.emails.receiving.get(id, options),
    send: (payload, options) => resend.emails.send(payload, options),
  };
}

export type ResendFailure =
  | "auth"
  | "account"
  | "missing"
  | "permanent"
  | "transient"
  | "timeout"
  | "unexpected";

const AUTH_STATUSES: ReadonlySet<number> = new Set([401, 403]);
const RETRYABLE_4XX: ReadonlySet<number> = new Set([408, 409, 429]);
const ACCOUNT_ERRORS: ReadonlySet<string> = new Set([
  "daily_quota_exceeded",
  "monthly_quota_exceeded",
  "invalid_from_address",
]);
const HTTP_NOT_FOUND = 404;
const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_SERVER_ERROR_MIN = 500;

export function classifyResendError(error: ErrorResponse | null): ResendFailure {
  const status = error?.statusCode;
  if (typeof status === "number" && AUTH_STATUSES.has(status)) return "auth";
  if (error && ACCOUNT_ERRORS.has(error.name)) return "account";
  if (status === HTTP_NOT_FOUND) return "missing";
  const clientError =
    typeof status === "number" && status >= HTTP_CLIENT_ERROR_MIN && status < HTTP_SERVER_ERROR_MIN;
  return clientError && !RETRYABLE_4XX.has(status) ? "permanent" : "transient";
}

/** The class of an error, never its message (which may echo mail data). */
export function errorClass(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

export class ResendTimeoutError extends Error {
  constructor() {
    super("Resend did not answer in time");
    this.name = "ResendTimeoutError";
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ResendTimeoutError()), Math.max(0, ms));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export type ResendResult<T> =
  | { ok: true; data: T }
  | { ok: false; failure: ResendFailure; status: number | null; kind: string };

/** One call, bounded by `ms`; every outcome is a value, never a throw. */
export async function callResend<T>(
  call: () => Promise<{ data: T | null; error: ErrorResponse | null }>,
  ms: number,
): Promise<ResendResult<T>> {
  if (ms <= 0) return { ok: false, failure: "timeout", status: null, kind: "deadline" };
  try {
    const response = await withTimeout(call(), ms);
    if (response.data) return { ok: true, data: response.data };
    const status = response.error?.statusCode ?? null;
    const failure = classifyResendError(response.error);
    return { ok: false, failure, status, kind: response.error?.name ?? "no-error" };
  } catch (err) {
    if (err instanceof ResendTimeoutError) {
      return { ok: false, failure: "timeout", status: null, kind: "timeout" };
    }
    return { ok: false, failure: "unexpected", status: null, kind: errorClass(err) };
  }
}
