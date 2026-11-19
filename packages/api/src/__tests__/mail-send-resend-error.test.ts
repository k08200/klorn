/**
 * Every Resend send in mail/email.ts must report a mail that did not go out.
 * Resend's SDK (6.x) answers a refusal, a rate limit, a server error or a
 * network failure with `{ data: null, error }` instead of throwing, so a
 * sender that only awaits and catches calls all of those "sent".
 *
 * The failure is logged as facts (Resend's error name as a code, the HTTP
 * status), never the recipient address or Resend's message text, which can
 * quote the request.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const outcome = vi.hoisted(() => ({
  next: { data: { id: "msg-1" }, error: null } as unknown,
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: vi.fn(async () => outcome.next) };
  },
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const ORIGINAL = {
  key: process.env.RESEND_API_KEY,
  webUrl: process.env.WEB_URL,
};

const RECIPIENT = "refused-recipient@example.com";
const RESEND_MESSAGE = "You can only send testing emails to quoted-address@example.com";

afterEach(() => {
  outcome.next = { data: { id: "msg-1" }, error: null };
  if (ORIGINAL.key === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = ORIGINAL.key;
  if (ORIGINAL.webUrl === undefined) delete process.env.WEB_URL;
  else process.env.WEB_URL = ORIGINAL.webUrl;
  vi.restoreAllMocks();
  vi.resetModules();
});

async function loadEmail() {
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.WEB_URL = "https://app.klorn.ai";
  vi.resetModules();
  return import("../mail/email.js");
}

function refuse(name = "validation_error", statusCode: number | null = 403): void {
  outcome.next = { data: null, error: { name, message: RESEND_MESSAGE, statusCode } };
}

type Email = Awaited<ReturnType<typeof loadEmail>>;

const SENDERS: ReadonlyArray<{
  name: string;
  send: (email: Email) => Promise<unknown>;
  sent: unknown;
  failed: unknown;
}> = [
  {
    name: "sendPasswordResetEmail",
    send: (e) => e.sendPasswordResetEmail(RECIPIENT, "a".repeat(64)),
    sent: true,
    failed: false,
  },
  {
    name: "sendBetaInviteEmail",
    send: (e) => e.sendBetaInviteEmail(RECIPIENT, "Applicant"),
    sent: true,
    failed: false,
  },
  {
    name: "sendOrgInviteEmail",
    send: (e) =>
      e.sendOrgInviteEmail({
        to: RECIPIENT,
        token: "t".repeat(43),
        orgName: "Acme",
        inviterName: "Owner",
      }),
    sent: true,
    failed: false,
  },
  {
    name: "sendVerificationEmail",
    send: (e) => e.sendVerificationEmail(RECIPIENT, "v".repeat(64)),
    sent: true,
    failed: false,
  },
  {
    name: "sendWelcomeEmail",
    send: (e) => e.sendWelcomeEmail(RECIPIENT, "New User"),
    sent: "sent",
    failed: "failed",
  },
  {
    name: "sendDigestEmail",
    send: (e) =>
      e.sendDigestEmail(RECIPIENT, "Subject", "body", { webUrl: "https://app.klorn.ai" }),
    sent: true,
    failed: false,
  },
];

function quietConsole() {
  return {
    log: vi.spyOn(console, "log").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };
}

describe.each(SENDERS)("$name and Resend's { error } answer", ({ send, sent, failed }) => {
  it("reports the mail as sent when Resend accepted it", async () => {
    quietConsole();
    const email = await loadEmail();
    await expect(send(email)).resolves.toBe(sent);
  });

  it("reports a failure when Resend answers with an error instead of throwing", async () => {
    const consoleSpies = quietConsole();
    refuse("rate_limit_exceeded", 429);
    const email = await loadEmail();

    await expect(send(email)).resolves.toBe(failed);

    const logged = JSON.stringify([
      consoleSpies.log.mock.calls,
      consoleSpies.warn.mock.calls,
      consoleSpies.error.mock.calls,
    ]);
    expect(logged).toContain("RATE_LIMIT_EXCEEDED");
    expect(logged).toContain("429");
    expect(logged).not.toContain(RECIPIENT);
    expect(logged).not.toContain("quoted-address@example.com");
    expect(logged).not.toContain("only send testing emails");
  });

  it("reports a failure when Resend answers with no data and no error", async () => {
    quietConsole();
    outcome.next = { data: null, error: null };
    const email = await loadEmail();
    await expect(send(email)).resolves.toBe(failed);
  });
});

describe("requireResendAccepted", () => {
  it("returns the data of an accepted send", async () => {
    const { requireResendAccepted } = await import("../mail/resend-send.js");
    await expect(
      requireResendAccepted(Promise.resolve({ data: { id: "m1" }, error: null })),
    ).resolves.toEqual({ id: "m1" });
  });

  it("throws facts only: an upper-case code and the status, never Resend's message", async () => {
    const { requireResendAccepted, ResendSendError } = await import("../mail/resend-send.js");
    const failure = await requireResendAccepted(
      Promise.resolve({
        data: null,
        error: { name: "invalid_from_address" as const, message: RESEND_MESSAGE, statusCode: 422 },
      }),
    ).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ResendSendError);
    const error = failure as InstanceType<typeof ResendSendError>;
    expect(error.code).toBe("INVALID_FROM_ADDRESS");
    expect(error.statusCode).toBe(422);
    expect(error.message).not.toContain("quoted-address");
    expect(JSON.stringify(error)).not.toContain("quoted-address");
  });

  it("does not copy an error name that is not a plain Resend code", async () => {
    const { requireResendAccepted } = await import("../mail/resend-send.js");
    const failure = (await requireResendAccepted(
      Promise.resolve({
        data: null,
        error: { name: "see me@example.com" as never, message: "x", statusCode: null },
      }),
    ).catch((err: unknown) => err)) as { code: string; statusCode: number | null };

    expect(failure.code).toBe("RESEND_ERROR");
    expect(failure.statusCode).toBeNull();
  });
});
