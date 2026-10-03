/**
 * The one error type the storage module throws (step D1 of
 * docs/providers/unified-platform-plan.md). Callers branch on `code`, never on
 * the message. A message never carries a credential, a response body or a
 * signed URL: it names env variables, HTTP statuses and the vendor's own error
 * code, and nothing else from the wire.
 */

export type StorageErrorCode =
  // Configuration and reachability.
  | "misconfigured"
  | "access-denied"
  | "bucket-not-found"
  | "unreachable"
  | "upstream"
  // Keys and ownership.
  | "invalid-key"
  | "key-not-owned"
  | "invalid-prefix"
  // Limits.
  | "invalid-size"
  | "object-too-large"
  | "size-mismatch"
  | "invalid-content-type"
  | "content-type-refused"
  | "invalid-expiry"
  | "expiry-too-long"
  // Deletion.
  | "delete-incomplete";

export interface StorageErrorDetails {
  /** HTTP status the storage vendor answered with, when there was an answer. */
  status?: number;
  /** The vendor's own error code (`NoSuchBucket`, `AccessDenied`, …). */
  upstreamCode?: string;
  /** Overrides the default below, for the code that knows better. */
  retryable?: boolean;
  cause?: unknown;
}

const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_FLOOR = 500;

/**
 * Whether the same call may pass on a second try: the endpoint did not answer
 * (a timeout, a refused connection), or it answered 5xx or 429. Everything
 * else (4xx, configuration, a bad key, a limit) fails the same way again.
 */
function retryableByDefault(code: StorageErrorCode, status: number | undefined): boolean {
  if (code === "unreachable") return true;
  if (code !== "upstream" || status === undefined) return false;
  return status >= HTTP_SERVER_ERROR_FLOOR || status === HTTP_TOO_MANY_REQUESTS;
}

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly status: number | undefined;
  readonly upstreamCode: string | undefined;
  /**
   * A hint for the caller. Nothing in storage/ retries on its own: a person or
   * a later step's job decides whether to try again.
   */
  readonly retryable: boolean;

  constructor(code: StorageErrorCode, message: string, details: StorageErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "StorageError";
    this.code = code;
    this.status = details.status;
    this.upstreamCode = details.upstreamCode;
    this.retryable = details.retryable ?? retryableByDefault(code, details.status);
  }
}
