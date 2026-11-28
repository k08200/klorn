/**
 * requireResendAccepted: which Resend refusals are permanent (the same mail
 * would be refused again) and which are worth retrying, the bound on one call,
 * and the idempotency key it forwards.
 *
 * Permanent means the recipient: Resend refused the `to` address itself.
 * Everything else is retried — Klorn's own account or request (a bad key, an
 * unverified domain, a bad FROM or reply-to env value, an empty field from a
 * Klorn bug), a quota, a rate limit, a 5xx, no answer — because nothing about
 * the recipient is wrong, and the mail goes out once the cause clears. Error names and statuses are Resend's
 * documented ones (resend.com/docs/api-reference/errors, read 2026-11-18) and
 * the SDK's RESEND_ERROR_CODE_KEY (resend 6.38.1).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RESEND_SEND_TIMEOUT_MS,
  type ResendRequestOptions,
  ResendSendError,
  requireResendAccepted,
} from "../mail/resend-send.js";

type Refusal = { name: string; statusCode: number | null; message: string };

function refusedWith(refusal: Refusal) {
  return async () => ({ data: null, error: refusal as never });
}

async function failureOf(refusal: Refusal): Promise<ResendSendError> {
  const failure = await requireResendAccepted(refusedWith(refusal)).catch((err: unknown) => err);
  expect(failure).toBeInstanceOf(ResendSendError);
  return failure as ResendSendError;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("which refusals are permanent", () => {
  const PERMANENT: ReadonlyArray<Refusal> = [
    {
      name: "validation_error",
      statusCode: 422,
      message:
        "Invalid `to` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.",
    },
    { name: "validation_error", statusCode: 400, message: "The `to` field is invalid." },
  ];

  it.each(PERMANENT)("$name ($statusCode) is permanent", async (refusal) => {
    const error = await failureOf(refusal);
    expect(error.permanent).toBe(true);
  });

  const RETRYABLE: ReadonlyArray<Refusal & { why: string }> = [
    {
      why: "FROM env value",
      name: "validation_error",
      statusCode: 422,
      message: "Invalid `from` field. The email address needs to follow the format.",
    },
    {
      why: "reply-to env value",
      name: "validation_error",
      statusCode: 422,
      message: "Invalid `reply_to` field.",
    },
    { why: "message names no field", name: "validation_error", statusCode: 422, message: "x" },
    { why: "Klorn's request", name: "invalid_parameter", statusCode: 422, message: "x" },
    { why: "Klorn's request", name: "missing_required_field", statusCode: 422, message: "x" },
    { why: "Klorn's request", name: "missing_required_parameter", statusCode: 422, message: "x" },
    { why: "Klorn's request", name: "invalid_attachment", statusCode: 422, message: "x" },
    { why: "Klorn's key", name: "invalid_idempotency_key", statusCode: 400, message: "x" },
    {
      why: "to-field wording on a 403",
      name: "validation_error",
      statusCode: 403,
      message: "Invalid `to` field.",
    },
    { why: "rate limit", name: "rate_limit_exceeded", statusCode: 429, message: "x" },
    { why: "daily quota", name: "daily_quota_exceeded", statusCode: 429, message: "x" },
    { why: "monthly quota", name: "monthly_quota_exceeded", statusCode: 429, message: "x" },
    { why: "server error", name: "application_error", statusCode: 500, message: "x" },
    { why: "server error", name: "internal_server_error", statusCode: 500, message: "x" },
    { why: "unavailable", name: "service_unavailable", statusCode: 503, message: "x" },
    { why: "network failure (SDK)", name: "application_error", statusCode: null, message: "x" },
    {
      why: "unverified domain",
      name: "validation_error",
      statusCode: 403,
      message: "The example.com domain is not verified.",
    },
    {
      why: "testing-mode account",
      name: "validation_error",
      statusCode: 403,
      message: "You can only send testing emails to your own email address.",
    },
    { why: "inactive key", name: "validation_error", statusCode: 401, message: "x" },
    {
      why: "invalid key answered as a 400",
      name: "validation_error",
      statusCode: 400,
      message: "API key is invalid",
    },
    { why: "missing key", name: "missing_api_key", statusCode: 401, message: "x" },
    { why: "restricted key", name: "restricted_api_key", statusCode: 401, message: "x" },
    { why: "invalid key", name: "invalid_api_key", statusCode: 403, message: "x" },
    { why: "suspended key", name: "suspended_api_key", statusCode: 403, message: "x" },
    { why: "FROM_EMAIL not allowed", name: "invalid_from_address", statusCode: 422, message: "x" },
    { why: "wrong endpoint", name: "not_found", statusCode: 404, message: "x" },
    { why: "wrong method", name: "method_not_allowed", statusCode: 405, message: "x" },
    {
      why: "same key in flight",
      name: "concurrent_idempotent_requests",
      statusCode: 409,
      message: "x",
    },
    { why: "key reused", name: "invalid_idempotent_request", statusCode: 409, message: "x" },
    { why: "an unknown name", name: "some_future_error", statusCode: 422, message: "x" },
  ];

  it.each(RETRYABLE)("$name ($statusCode, $why) is retried", async (refusal) => {
    const error = await failureOf(refusal);
    expect(error.permanent).toBe(false);
  });

  it("an answer with no data and no error is retried", async () => {
    const failure = (await requireResendAccepted(async () => ({ data: null, error: null })).catch(
      (err: unknown) => err,
    )) as ResendSendError;
    expect(failure.code).toBe("RESEND_NO_DATA");
    expect(failure.permanent).toBe(false);
  });
});

describe("the bound on one send", () => {
  it("is ten seconds, the Klorn mailbox's per-call budget", () => {
    expect(RESEND_SEND_TIMEOUT_MS).toBe(10_000);
  });

  it("gives up on a send that never answers: a retryable RESEND_TIMEOUT, and the request is aborted", async () => {
    vi.useFakeTimers();
    let seen: ResendRequestOptions | undefined;
    const pending = requireResendAccepted((options) => {
      seen = options;
      return new Promise(() => {});
    }).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(RESEND_SEND_TIMEOUT_MS - 1);
    expect(seen?.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const failure = (await pending) as ResendSendError;

    expect(failure).toBeInstanceOf(ResendSendError);
    expect(failure.code).toBe("RESEND_TIMEOUT");
    expect(failure.statusCode).toBeNull();
    expect(failure.permanent).toBe(false);
    expect(seen?.signal.aborted).toBe(true);
  });

  it("reports a timeout even when the SDK answers the abort with its network error", async () => {
    // resend 6.38.1 catches the aborted fetch and resolves
    // { error: { name: "application_error", statusCode: null } }.
    vi.useFakeTimers();
    const pending = requireResendAccepted(
      (options) =>
        new Promise((resolve) => {
          options.signal.addEventListener("abort", () =>
            resolve({
              data: null,
              error: { name: "application_error", statusCode: null, message: "x" } as never,
            }),
          );
        }),
    ).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(RESEND_SEND_TIMEOUT_MS);
    const failure = (await pending) as ResendSendError;

    expect(failure.code).toBe("RESEND_TIMEOUT");
  });

  it("leaves no timer behind once Resend answers", async () => {
    vi.useFakeTimers();
    await expect(
      requireResendAccepted(async () => ({ data: { id: "m1" }, error: null })),
    ).resolves.toEqual({ id: "m1" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no timer behind when the send throws", async () => {
    vi.useFakeTimers();
    await expect(
      requireResendAccepted(async () => {
        throw new TypeError("sdk bug");
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the idempotency key", () => {
  it("is forwarded to Resend with the abort signal", async () => {
    let seen: ResendRequestOptions | undefined;
    await requireResendAccepted(
      async (options) => {
        seen = options;
        return { data: { id: "m1" }, error: null };
      },
      { idempotencyKey: "daily-digest/u1/2026-11-18" },
    );
    expect(seen?.idempotencyKey).toBe("daily-digest/u1/2026-11-18");
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });

  it("is left out when the sender has none", async () => {
    let seen: ResendRequestOptions | undefined;
    await requireResendAccepted(async (options) => {
      seen = options;
      return { data: { id: "m1" }, error: null };
    });
    expect(seen && "idempotencyKey" in seen).toBe(false);
  });
});
