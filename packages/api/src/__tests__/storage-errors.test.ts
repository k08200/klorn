/**
 * StorageError.retryable (step D1): a hint for the caller. Nothing in storage/
 * retries on its own. True for what may pass on a second try (a timeout, an
 * unreachable endpoint, 5xx, 429); false for what will fail the same way again
 * (4xx, configuration, a bad key, a limit).
 */

import { describe, expect, it } from "vitest";
import { StorageError, type StorageErrorCode } from "../storage/errors.js";

describe("StorageError.retryable", () => {
  it("is true when the endpoint did not answer", () => {
    expect(new StorageError("unreachable", "no answer").retryable).toBe(true);
  });

  it.each([500, 502, 503, 504, 429])("is true for HTTP %i", (status) => {
    expect(new StorageError("upstream", "x", { status }).retryable).toBe(true);
  });

  it.each([400, 404, 409, 411, 301])("is false for HTTP %i", (status) => {
    expect(new StorageError("upstream", "x", { status }).retryable).toBe(false);
  });

  it("is false for an upstream fault with no status (a malformed answer)", () => {
    expect(new StorageError("upstream", "not a list result").retryable).toBe(false);
  });

  it.each<StorageErrorCode>([
    "misconfigured",
    "access-denied",
    "bucket-not-found",
    "invalid-key",
    "key-not-owned",
    "invalid-prefix",
    "invalid-size",
    "object-too-large",
    "size-mismatch",
    "invalid-content-type",
    "content-type-refused",
    "invalid-expiry",
    "expiry-too-long",
    "delete-incomplete",
  ])("is false for %s by default", (code) => {
    expect(new StorageError(code, "x", { status: 403 }).retryable).toBe(false);
  });

  it("can be set by the code that knows better", () => {
    expect(new StorageError("delete-incomplete", "deadline", { retryable: true }).retryable).toBe(
      true,
    );
    expect(new StorageError("unreachable", "x", { retryable: false }).retryable).toBe(false);
  });
});
