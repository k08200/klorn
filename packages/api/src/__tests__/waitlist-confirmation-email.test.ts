import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the Resend payload so we can assert sender, subject, and body copy.
const sendSpy = vi.hoisted(() => vi.fn(async () => ({ data: { id: "email-1" }, error: null })));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendSpy };
  },
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

type SentPayload = { from: string; to: string; subject: string; html: string };

async function importMailModule() {
  vi.resetModules();
  return await import("../mail/email.js");
}

beforeEach(() => {
  sendSpy.mockClear();
  delete process.env.RESEND_API_KEY;
  delete process.env.FROM_EMAIL;
});

describe("sendWaitlistConfirmationEmail", () => {
  it("returns true without sending when RESEND_API_KEY is unset (graceful no-op)", async () => {
    const { sendWaitlistConfirmationEmail } = await importMailModule();
    const ok = await sendWaitlistConfirmationEmail("applicant@example.com");
    expect(ok).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("sends from the standard sender with the expected copy", async () => {
    process.env.RESEND_API_KEY = "test-key";
    process.env.FROM_EMAIL = "Klorn <hello@klorn.test>";
    const { sendWaitlistConfirmationEmail } = await importMailModule();

    const ok = await sendWaitlistConfirmationEmail("applicant@example.com", "Yong");
    expect(ok).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);

    const payload = sendSpy.mock.calls[0]?.[0] as unknown as SentPayload;
    expect(payload.from).toBe("Klorn <hello@klorn.test>");
    expect(payload.to).toBe("applicant@example.com");
    expect(payload.subject).toBe("You're on the Klorn early-access list");
    // Greeting uses the applicant's name.
    expect(payload.html).toContain("Hi Yong,");
    // One-line product intro.
    expect(payload.html).toContain("4-tier attention firewall");
    // Expectation-setting: a human approves, usually within hours (KST daytime).
    expect(payload.html).toMatch(/founder/i);
    expect(payload.html).toMatch(/few hours/i);
    expect(payload.html).toContain("KST");
    // What the approval email will look like.
    expect(payload.html).toContain("You're approved — sign in to Klorn");
  });

  it("neutralizes angle brackets in the applicant name", async () => {
    process.env.RESEND_API_KEY = "test-key";
    const { sendWaitlistConfirmationEmail } = await importMailModule();

    await sendWaitlistConfirmationEmail("applicant@example.com", "<img src=x>Evil");
    const payload = sendSpy.mock.calls[0]?.[0] as unknown as SentPayload;
    expect(payload.html).not.toContain("<img src=x>");
  });

  it("returns false when the send fails", async () => {
    process.env.RESEND_API_KEY = "test-key";
    sendSpy.mockRejectedValueOnce(new Error("resend down"));
    const { sendWaitlistConfirmationEmail } = await importMailModule();

    const ok = await sendWaitlistConfirmationEmail("applicant@example.com");
    expect(ok).toBe(false);
  });
});
