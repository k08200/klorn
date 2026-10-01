/**
 * Step B4 scope decision: a generic IMAP provider has no SMTP endpoint, and no code
 * path may invent one. The transport refuses a provider without an endpoint, so
 * even if a future change wired send to a generic row by mistake it would fail
 * closed instead of connecting anywhere.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("nodemailer", () => ({ createTransport: vi.fn() }));

const { createSmtpTransport, openSmtpSession, smtpTransportOptions } = await import(
  "../mail/smtp-transport.js"
);
const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");

const CREDS = { email: "me@example.com", password: "pw" };

describe("SMTP for a provider without an endpoint", () => {
  it("smtpTransportOptions refuses", () => {
    expect(() => smtpTransportOptions(IMAP_PROVIDERS.IMAP, CREDS)).toThrow("has no SMTP endpoint");
  });

  it("createSmtpTransport refuses", async () => {
    await expect(createSmtpTransport(IMAP_PROVIDERS.IMAP, CREDS)).rejects.toThrow(
      "has no SMTP endpoint",
    );
  });

  it("openSmtpSession refuses before any socket is opened", async () => {
    await expect(openSmtpSession(IMAP_PROVIDERS.IMAP, CREDS)).rejects.toThrow(
      "has no SMTP endpoint",
    );
  });

  it("Naver and iCloud still build their fixed transport options", () => {
    expect(smtpTransportOptions(IMAP_PROVIDERS.NAVER, CREDS)).toMatchObject({
      host: "smtp.naver.com",
      port: 587,
    });
    expect(smtpTransportOptions(IMAP_PROVIDERS.ICLOUD, CREDS)).toMatchObject({
      host: "smtp.mail.me.com",
      port: 587,
    });
  });
});
