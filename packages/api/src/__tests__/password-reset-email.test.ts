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
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: vi.fn(async () => {
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
