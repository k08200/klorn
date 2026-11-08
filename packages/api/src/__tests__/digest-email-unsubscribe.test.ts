/**
 * The daily digest is the only mail Klorn sends on a recurring schedule, so it
 * is the only one that needs a way out. These tests pin all three places the
 * opt-out has to appear — the plain-text part, the HTML part, and the
 * `List-Unsubscribe` header Gmail reads — because each one covers a reader the
 * others miss: a text-only client, a normal mail client, and the provider
 * deciding whether Klorn's mail is wanted.
 *
 * They also pin the inverse: the transactional senders carry no opt-out. That
 * is a decision, not an omission, and a test is what keeps someone from
 * "fixing" it later by bolting an unsubscribe link onto a password reset.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => vi.fn());

vi.mock("resend", () => ({
  Resend: class {
    emails = { send };
  },
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

// email.ts reads both of these at module load, so they are set before the
// dynamic import below rather than in a beforeEach.
process.env.RESEND_API_KEY = "test-key";
process.env.WEB_URL = "https://app.klorn.ai";

const { sendDigestEmail, sendPasswordResetEmail, sendVerificationEmail } = await import(
  "../mail/email.js"
);

const UNSUBSCRIBE_URL = "https://app.klorn.ai/settings/notifications#notifyDailyBriefing";
const LABEL_EN = "Unsubscribe — turn off daily briefing emails and alerts";
const LABEL_KO = "수신거부 — 데일리 브리핑 메일·알림 끄기";

/** The single payload handed to Resend by the call under test. */
function sentPayload(): Record<string, unknown> {
  expect(send).toHaveBeenCalledTimes(1);
  return send.mock.calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  send.mockResolvedValue({ data: { id: "mail-1" }, error: null });
});

describe("sendDigestEmail opt-out", () => {
  it("carries a List-Unsubscribe header, bracketed as RFC 2369 requires", async () => {
    await expect(sendDigestEmail("a@example.com", "Subject", "body")).resolves.toBe(true);
    expect(sentPayload().headers).toEqual({ "List-Unsubscribe": `<${UNSUBSCRIBE_URL}>` });
  });

  it("does NOT claim one-click: there is no unauthenticated POST endpoint behind that URL", async () => {
    await sendDigestEmail("a@example.com", "Subject", "body");
    expect(sentPayload().headers).not.toHaveProperty("List-Unsubscribe-Post");
  });

  it("puts the opt-out in the plain-text part, so a text-only client still sees a way out", async () => {
    await sendDigestEmail("a@example.com", "Subject", "what got filed");
    const text = sentPayload().text as string;
    expect(text).toContain("what got filed");
    expect(text).toContain(LABEL_EN);
    expect(text).toContain(UNSUBSCRIBE_URL);
  });

  it("puts the opt-out in the HTML part as a real link", async () => {
    await sendDigestEmail("a@example.com", "Subject", "body");
    const html = sentPayload().html as string;
    expect(html).toContain(`href="${UNSUBSCRIBE_URL}"`);
    expect(html).toContain(LABEL_EN);
  });

  it("speaks Korean when that is the user's notification language", async () => {
    await sendDigestEmail("a@example.com", "제목", "본문", { language: "ko" });
    const payload = sentPayload();
    expect(payload.text as string).toContain(LABEL_KO);
    expect(payload.html as string).toContain(LABEL_KO);
    // The URL is the same either way — only the label is translated.
    expect(payload.headers).toEqual({ "List-Unsubscribe": `<${UNSUBSCRIBE_URL}>` });
  });

  it("falls back to English for a language the digest copy was never written in", async () => {
    await sendDigestEmail("a@example.com", "Subject", "body", { language: "de" });
    expect(sentPayload().text as string).toContain(LABEL_EN);
  });

  it("points at the preference the settings screen already shows, not a parallel opt-out store", async () => {
    await sendDigestEmail("a@example.com", "Subject", "body");
    // The anchor is the notifyDailyBriefing checkbox in
    // settings/_sections/notifications-section.tsx — the switch the digest
    // sweep itself gates on. A second suppression list could disagree with it.
    expect(sentPayload().headers).toEqual({
      "List-Unsubscribe": "<https://app.klorn.ai/settings/notifications#notifyDailyBriefing>",
    });
  });

  it("refuses to send at all when WEB_URL yields no opt-out target", async () => {
    // Fails CLOSED. A recurring mail with no way out is the thing this feature
    // exists to prevent, so a misconfigured WEB_URL costs a skipped digest.
    await expect(
      sendDigestEmail("a@example.com", "Subject", "body", { webUrl: "app.klorn.ai" }),
    ).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("honours the caller's webUrl over this module's env default", async () => {
    await sendDigestEmail("a@example.com", "Subject", "body", {
      webUrl: "https://staging.klorn.ai",
    });
    expect(sentPayload().headers).toEqual({
      "List-Unsubscribe": "<https://staging.klorn.ai/settings/notifications#notifyDailyBriefing>",
    });
  });

  it("emits exactly one URI in the header — a hostile base cannot append a second", async () => {
    await sendDigestEmail("a@example.com", "Subject", "body", {
      webUrl: "https://app.klorn.ai/?x=>, <https://evil.example",
    });
    const header = (sentPayload().headers as Record<string, string>)["List-Unsubscribe"];
    expect(header).toBe(`<${UNSUBSCRIBE_URL}>`);
    expect(header.match(/</g)).toHaveLength(1);
    expect(header).not.toContain("evil.example");
  });

  it("never lets a CR/LF in WEB_URL forge a header line", async () => {
    await sendDigestEmail("a@example.com", "Subject", "body", {
      webUrl: "https://app.klorn.ai\r\nBcc: evil@example.com",
    });
    const header = (sentPayload().headers as Record<string, string>)["List-Unsubscribe"];
    // The host is NOT asserted: URL strips the CR/LF and then parses
    // "app.klorn.ai Bcc: evil@" as userinfo, so the origin legitimately
    // becomes example.com. What must never happen is a second header line or
    // a second URI, and that is what is pinned here.
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).not.toContain("Bcc");
    expect(header.match(/</g)).toHaveLength(1);
    expect(header).toMatch(/^<https?:\/\/[^/]+\/settings\/notifications#notifyDailyBriefing>$/);
  });

  it("HTML-escapes the href and the label, not just the body", async () => {
    await sendDigestEmail("a@example.com", "Subject", "body");
    const html = sentPayload().html as string;
    // The href must be inside its quotes: an unescaped '"' would end the
    // attribute early and let the rest of the URL become markup.
    expect(html).toContain(`href="${UNSUBSCRIBE_URL}"`);
    const anchor = html.slice(html.indexOf("<a "), html.indexOf("</a>"));
    expect(anchor).not.toMatch(/&(?!(?:amp|lt|gt|quot);)/);
  });

  it("still escapes the digest body — an address is attacker-influenced text", async () => {
    await sendDigestEmail("a@example.com", "Subject", "<script>alert(1)</script>@evil.com");
    const html = sentPayload().html as string;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("transactional senders carry no opt-out", () => {
  it("a password reset has no List-Unsubscribe — it is only sent because the user just asked", async () => {
    await sendPasswordResetEmail("a@example.com", "reset-token");
    expect(sentPayload().headers).toBeUndefined();
  });

  it("an address verification has no List-Unsubscribe", async () => {
    await sendVerificationEmail("a@example.com", "verify-token");
    expect(sentPayload().headers).toBeUndefined();
  });
});
