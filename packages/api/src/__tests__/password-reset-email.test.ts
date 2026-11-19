/**
 * sendPasswordResetEmail must report a send that did not go out. Resend's SDK
 * answers a refusal, rate limit or network failure with `{ data: null, error }`
 * instead of throwing; forgot-password relies on `false` to put the previous
 * link back (routes/auth.ts).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const outcome = vi.hoisted(() => ({
  next: { data: { id: "msg-1" }, error: null } as unknown,
  throws: false,
  html: "",
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: vi.fn(async (msg: { html: string }) => {
        outcome.html = msg.html;
        if (outcome.throws) throw new Error("socket hang up");
        return outcome.next;
      }),
    };
  },
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const ORIGINAL_KEY = process.env.RESEND_API_KEY;

afterEach(() => {
  outcome.next = { data: { id: "msg-1" }, error: null };
  outcome.throws = false;
  outcome.html = "";
  vi.doUnmock("../security/password-reset-throttle.js");
  if (ORIGINAL_KEY === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = ORIGINAL_KEY;
  vi.restoreAllMocks();
  vi.resetModules();
});

async function send(): Promise<boolean> {
  process.env.RESEND_API_KEY = "re_test_key";
  vi.resetModules();
  const { sendPasswordResetEmail } = await import("../mail/email.js");
  return sendPasswordResetEmail("reset-mail@example.com", "a".repeat(64));
}

describe("sendPasswordResetEmail", () => {
  it("is true when Resend accepted the mail", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(send()).resolves.toBe(true);
  });

  it("is false when Resend answers with an error instead of throwing", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    outcome.next = {
      data: null,
      error: { name: "rate_limit_exceeded", message: "Too many requests", statusCode: 429 },
    };
    await expect(send()).resolves.toBe(false);
    expect(errors).toHaveBeenCalled();
    expect(JSON.stringify(errors.mock.calls)).not.toContain("reset-mail@example.com");
  });

  it("is false when the SDK throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    outcome.throws = true;
    await expect(send()).resolves.toBe(false);
  });
});

describe("the reset mail's stated lifetime", () => {
  it("is the token TTL the route stamps on the link (1 hour today)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { PASSWORD_RESET_TOKEN_TTL_MS } = await import("../security/password-reset-throttle.js");
    expect(PASSWORD_RESET_TOKEN_TTL_MS).toBe(60 * 60 * 1000);
    await send();
    expect(outcome.html).toContain("This link expires in 1 hour.");
  });

  it("follows PASSWORD_RESET_TOKEN_TTL_MS when it changes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.doMock("../security/password-reset-throttle.js", async (importActual) => ({
      ...(await importActual<typeof import("../security/password-reset-throttle.js")>()),
      PASSWORD_RESET_TOKEN_TTL_MS: 30 * 60 * 1000,
    }));
    await send();
    expect(outcome.html).toContain("This link expires in 30 minutes.");
    expect(outcome.html).not.toContain("1 hour");
  });
});

describe("formatLinkLifetime", () => {
  it.each([
    [60 * 60 * 1000, "1 hour"],
    [2 * 60 * 60 * 1000, "2 hours"],
    [24 * 60 * 60 * 1000, "24 hours"],
    [30 * 60 * 1000, "30 minutes"],
    [90 * 60 * 1000, "90 minutes"],
    [60 * 1000, "1 minute"],
    // Never promises longer than the link lives.
    [59 * 60 * 1000 + 59 * 1000, "59 minutes"],
  ])("%d ms reads %s", async (ms, words) => {
    const { formatLinkLifetime } = await import("../mail/email.js");
    expect(formatLinkLifetime(ms)).toBe(words);
  });
});
