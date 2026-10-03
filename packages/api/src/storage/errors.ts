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
  cause?: unknown;
}

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly status: number | undefined;
  readonly upstreamCode: string | undefined;

  constructor(code: StorageErrorCode, message: string, details: StorageErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "StorageError";
    this.code = code;
    this.status = details.status;
    this.upstreamCode = details.upstreamCode;
  }
}
