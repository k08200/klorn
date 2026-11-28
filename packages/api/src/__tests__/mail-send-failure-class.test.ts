/**
 * What each mail sender tells its caller about a send that did not go out,
 * now that requireResendAccepted (mail/resend-send.ts) separates a permanent
 * refusal from a failure worth retrying:
 *
 * - the welcome and the daily digest answer "failed" (retry) or "rejected"
 *   (Resend refused this mail for good), so the welcome stops re-sending to an
 *   address Resend will never take, and the digest retries only what can land;
 * - the beta invite answers with Resend's code, so the admin who approved the
 *   applicant sees that no mail went out;
 * - the verification mail states the lifetime the route stamps on the link.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const resendMock = vi.hoisted(() => ({
  next: { data: { id: "msg-1" }, error: null } as unknown,
  hang: false,
  throws: false,
  calls: [] as Array<{ payload: { html?: string }; options: Record<string, unknown> | undefined }>,
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: vi.fn(async (payload: { html?: string }, options?: Record<string, unknown>) => {
        resendMock.calls.push({ payload, options });
        if (resendMock.throws) throw new TypeError("sdk bug");
        if (resendMock.hang) return new Promise(() => {});
        return resendMock.next;
      }),
    };
  },
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const ORIGINAL = { key: process.env.RESEND_API_KEY, webUrl: process.env.WEB_URL };
const RECIPIENT = "class-recipient@example.com";

afterEach(() => {
  resendMock.next = { data: { id: "msg-1" }, error: null };
  resendMock.hang = false;
  resendMock.throws = false;
  resendMock.calls = [];
  vi.doUnmock("../one-time-token.js");
  if (ORIGINAL.key === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = ORIGINAL.key;
  if (ORIGINAL.webUrl === undefined) delete process.env.WEB_URL;
  else process.env.WEB_URL = ORIGINAL.webUrl;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

function quietConsole(): void {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
}

async function loadEmail(withKey = true) {
  if (withKey) process.env.RESEND_API_KEY = "re_test_key";
  else delete process.env.RESEND_API_KEY;
  process.env.WEB_URL = "https://app.klorn.ai";
  vi.resetModules();
  return import("../mail/email.js");
}

function refuse(name: string, statusCode: number | null, message = "quoted text"): void {
  resendMock.next = { data: null, error: { name, statusCode, message } };
}

const sendDigest = (email: Awaited<ReturnType<typeof loadEmail>>, idempotencyKey?: string) =>
  email.sendDigestEmail(RECIPIENT, "Subject", "body", {
    webUrl: "https://app.klorn.ai",
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });

describe("sendWelcomeEmail", () => {
  it("is 'rejected' when Resend refuses the recipient for good", async () => {
    quietConsole();
    refuse("validation_error", 422, "Invalid `to` field.");
    const email = await loadEmail();
    await expect(email.sendWelcomeEmail(RECIPIENT, "New")).resolves.toBe("rejected");
  });

  it("is 'failed' (retry later) when Resend refuses Klorn's own FROM, not the recipient", async () => {
    quietConsole();
    refuse("validation_error", 422, "Invalid `from` field.");
    const email = await loadEmail();
    await expect(email.sendWelcomeEmail(RECIPIENT, "New")).resolves.toBe("failed");
  });

  it("is 'failed' (retry later) on a rate limit", async () => {
    quietConsole();
    refuse("rate_limit_exceeded", 429);
    const email = await loadEmail();
    await expect(email.sendWelcomeEmail(RECIPIENT, "New")).resolves.toBe("failed");
  });

  it("is 'failed' (retry later) when Resend does not answer in time", async () => {
    quietConsole();
    resendMock.hang = true;
    const email = await loadEmail();
    vi.useFakeTimers();
    const pending = email.sendWelcomeEmail(RECIPIENT, "New");
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toBe("failed");
  });

  it("forwards the caller's idempotency key to Resend", async () => {
    quietConsole();
    const email = await loadEmail();
    await email.sendWelcomeEmail(RECIPIENT, "New", { idempotencyKey: "welcome-email/u1" });
    expect(resendMock.calls[0]?.options).toMatchObject({ idempotencyKey: "welcome-email/u1" });
  });
});

describe("sendDigestEmail", () => {
  it("is 'sent' when Resend accepted it", async () => {
    quietConsole();
    const email = await loadEmail();
    await expect(sendDigest(email)).resolves.toBe("sent");
  });

  it("is 'rejected' on a permanent refusal", async () => {
    quietConsole();
    refuse("validation_error", 422, "Invalid `to` field.");
    const email = await loadEmail();
    await expect(sendDigest(email)).resolves.toBe("rejected");
  });

  it("is 'failed' on a server error", async () => {
    quietConsole();
    refuse("internal_server_error", 500);
    const email = await loadEmail();
    await expect(sendDigest(email)).resolves.toBe("failed");
  });

  it("is 'failed' when the SDK throws", async () => {
    quietConsole();
    resendMock.throws = true;
    const email = await loadEmail();
    await expect(sendDigest(email)).resolves.toBe("failed");
  });

  it("is 'skipped' with no Resend key, and calls nothing", async () => {
    quietConsole();
    const email = await loadEmail(false);
    await expect(sendDigest(email)).resolves.toBe("skipped");
    expect(resendMock.calls).toHaveLength(0);
  });

  it("forwards the caller's idempotency key to Resend", async () => {
    quietConsole();
    const email = await loadEmail();
    await sendDigest(email, "daily-digest/u1/2026-11-18");
    expect(resendMock.calls[0]?.options).toMatchObject({
      idempotencyKey: "daily-digest/u1/2026-11-18",
    });
  });
});

describe("sendBetaInviteEmail", () => {
  it("is { sent: true } when Resend accepted it", async () => {
    quietConsole();
    const email = await loadEmail();
    await expect(email.sendBetaInviteEmail(RECIPIENT, "Applicant")).resolves.toEqual({
      sent: true,
    });
  });

  it("carries Resend's code, not its message, when Resend refuses", async () => {
    quietConsole();
    refuse("validation_error", 422, `Invalid to: ${RECIPIENT}`);
    const email = await loadEmail();
    const report = await email.sendBetaInviteEmail(RECIPIENT, "Applicant");
    expect(report).toEqual({ sent: false, code: "VALIDATION_ERROR" });
    expect(JSON.stringify(report)).not.toContain(RECIPIENT);
  });

  it("says RESEND_TIMEOUT when Resend does not answer in time", async () => {
    quietConsole();
    resendMock.hang = true;
    const email = await loadEmail();
    vi.useFakeTimers();
    const pending = email.sendBetaInviteEmail(RECIPIENT, "Applicant");
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toEqual({ sent: false, code: "RESEND_TIMEOUT" });
  });

  it("says SEND_FAILED when the SDK throws", async () => {
    quietConsole();
    resendMock.throws = true;
    const email = await loadEmail();
    await expect(email.sendBetaInviteEmail(RECIPIENT, "Applicant")).resolves.toEqual({
      sent: false,
      code: "SEND_FAILED",
    });
  });

  it("says RESEND_NOT_CONFIGURED with no Resend key, instead of claiming a mail went out", async () => {
    quietConsole();
    const email = await loadEmail(false);
    await expect(email.sendBetaInviteEmail(RECIPIENT, "Applicant")).resolves.toEqual({
      sent: false,
      code: "RESEND_NOT_CONFIGURED",
    });
    expect(resendMock.calls).toHaveLength(0);
  });
});

describe("the verification mail's stated lifetime", () => {
  it("is the token TTL the route stamps on the link (24 hours today)", async () => {
    quietConsole();
    const { EMAIL_VERIFY_TOKEN_TTL_MS } = await import("../one-time-token.js");
    expect(EMAIL_VERIFY_TOKEN_TTL_MS).toBe(24 * 60 * 60 * 1000);
    const email = await loadEmail();
    await email.sendVerificationEmail(RECIPIENT, "v".repeat(64));
    expect(resendMock.calls[0]?.payload.html).toContain("This link expires in 24 hours.");
  });

  it("follows EMAIL_VERIFY_TOKEN_TTL_MS when it changes", async () => {
    quietConsole();
    vi.doMock("../one-time-token.js", async (importActual) => ({
      ...(await importActual<typeof import("../one-time-token.js")>()),
      EMAIL_VERIFY_TOKEN_TTL_MS: 2 * 60 * 60 * 1000,
    }));
    const email = await loadEmail();
    await email.sendVerificationEmail(RECIPIENT, "v".repeat(64));
    expect(resendMock.calls[0]?.payload.html).toContain("This link expires in 2 hours.");
    expect(resendMock.calls[0]?.payload.html).not.toContain("24 hours");
  });
});
