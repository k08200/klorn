/**
 * The approval email must only state what is true. The Google OAuth app is in
 * Production, so there is no Google Cloud test-user list to be added to and no
 * "Access blocked" screen to clear — and the email makes no plan promise.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => [] as Array<{ to: string; subject: string; html: string }>);

vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: vi.fn(async (msg: { to: string; subject: string; html: string }) => {
        sent.push(msg);
        return { data: { id: "msg-1" }, error: null };
      }),
    };
  },
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const ORIGINAL_KEY = process.env.RESEND_API_KEY;

afterEach(() => {
  sent.length = 0;
  if (ORIGINAL_KEY === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = ORIGINAL_KEY;
  vi.resetModules();
});

async function sendInvite(): Promise<{ subject: string; html: string }> {
  process.env.RESEND_API_KEY = "re_test_key";
  vi.resetModules();
  const { sendBetaInviteEmail } = await import("../mail/email.js");
  await expect(sendBetaInviteEmail("applicant@example.com", "Applicant")).resolves.toBe(true);
  expect(sent).toHaveLength(1);
  return sent[0];
}

describe("sendBetaInviteEmail", () => {
  it("says the address is approved and to sign in with it", async () => {
    const { html } = await sendInvite();
    expect(html).toMatch(/You're approved/);
    expect(html).toContain("applicant@example.com");
    expect(html).toMatch(/Sign in with this address/i);
  });

  it("never mentions a Google test-user list or an 'Access blocked' screen", async () => {
    const { html } = await sendInvite();
    expect(html).not.toMatch(/test-user list/i);
    expect(html).not.toMatch(/Google Cloud Console/i);
    expect(html).not.toMatch(/Access blocked/i);
  });

  it("makes no plan promise", async () => {
    const { subject, html } = await sendInvite();
    for (const text of [subject, html]) {
      expect(text).not.toMatch(/\bPro\b/);
      expect(text).not.toMatch(/\bplan\b/i);
    }
  });
});
