/**
 * Step B3: the SMTP side of the provider registry and the one place a nodemailer
 * transport is built.
 *
 * Pinned: host, port and security come ONLY from the registry entry of the
 * provider (never from the account row), certificate verification stays on,
 * STARTTLS is mandatory where the registry says STARTTLS (no plaintext
 * fallback), every timeout is an explicit finite constant, nothing that could
 * redirect the connection (proxy, custom socket, sendmail) is set, and the
 * transport logs nothing (SMTP traffic carries the credential and the mail).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ createTransport: vi.fn() }));

vi.mock("nodemailer", () => ({ createTransport: h.createTransport }));

const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");
const {
  SMTP_CONNECTION_TIMEOUT_MS,
  SMTP_DNS_TIMEOUT_MS,
  SMTP_GREETING_TIMEOUT_MS,
  SMTP_SOCKET_TIMEOUT_MS,
  createSmtpTransport,
  isSmtpAuthRejection,
  smtpTransportOptions,
} = await import("../mail/smtp-transport.js");

const CREDS = { email: "me@naver.com", password: "app-pw" };

beforeEach(() => {
  h.createTransport.mockReset();
  h.createTransport.mockReturnValue({ sendMail: vi.fn(), close: vi.fn() });
});

describe("registry: SMTP endpoints", () => {
  it("Naver: smtp.naver.com:587 with mandatory STARTTLS (help.naver.com/service/30029/bookmark/21344)", () => {
    expect(IMAP_PROVIDERS.NAVER.smtp).toEqual({
      host: "smtp.naver.com",
      port: 587,
      security: "starttls",
    });
  });

  it("iCloud: smtp.mail.me.com:587 with mandatory STARTTLS (support.apple.com/102525)", () => {
    expect(IMAP_PROVIDERS.ICLOUD.smtp).toEqual({
      host: "smtp.mail.me.com",
      port: 587,
      security: "starttls",
    });
  });

  it("gives each provider its own webmail URL for draft links", () => {
    expect(IMAP_PROVIDERS.NAVER.webmailUrl).toBe("https://mail.naver.com/");
    expect(IMAP_PROVIDERS.ICLOUD.webmailUrl).toBe("https://www.icloud.com/mail/");
  });
});

describe("smtpTransportOptions", () => {
  it("uses the registry host and port and the account's own credentials", () => {
    const opts = smtpTransportOptions(IMAP_PROVIDERS.NAVER, CREDS);
    expect(opts).toMatchObject({
      host: "smtp.naver.com",
      port: 587,
      auth: { user: "me@naver.com", pass: "app-pw" },
    });
  });

  it("STARTTLS: secure is false and requireTLS is true (no plaintext fallback)", () => {
    const opts = smtpTransportOptions(IMAP_PROVIDERS.ICLOUD, {
      email: "me@icloud.com",
      password: "pw",
    });
    expect(opts.secure).toBe(false);
    expect(opts.requireTLS).toBe(true);
    expect(opts.ignoreTLS).toBeFalsy();
    expect(opts.opportunisticTLS).toBeFalsy();
  });

  it("implicit TLS: secure is true (an entry can be switched to 465 by the registry alone)", () => {
    const implicit = {
      ...IMAP_PROVIDERS.NAVER,
      smtp: { host: "smtp.naver.com", port: 465, security: "implicit-tls" as const },
    };
    const opts = smtpTransportOptions(implicit, CREDS);
    expect(opts).toMatchObject({ host: "smtp.naver.com", port: 465, secure: true });
  });

  it("keeps certificate verification on and pins the SNI name to the registry host", () => {
    const opts = smtpTransportOptions(IMAP_PROVIDERS.NAVER, CREDS);
    expect(opts.tls).toMatchObject({
      rejectUnauthorized: true,
      servername: "smtp.naver.com",
      minVersion: "TLSv1.2",
    });
  });

  it("sets every timeout explicitly to a finite, bounded constant", () => {
    const opts = smtpTransportOptions(IMAP_PROVIDERS.NAVER, CREDS);
    expect(opts).toMatchObject({
      connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
      greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
      socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
      dnsTimeout: SMTP_DNS_TIMEOUT_MS,
    });
    for (const ms of [
      SMTP_CONNECTION_TIMEOUT_MS,
      SMTP_GREETING_TIMEOUT_MS,
      SMTP_SOCKET_TIMEOUT_MS,
      SMTP_DNS_TIMEOUT_MS,
    ]) {
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(60_000);
    }
  });

  it("does not log SMTP traffic and does not open file or URL access for content", () => {
    const opts = smtpTransportOptions(IMAP_PROVIDERS.NAVER, CREDS);
    expect(opts.logger).toBe(false);
    expect(opts.debug).toBe(false);
    expect(opts.transactionLog).toBeFalsy();
    expect(opts.disableFileAccess).toBe(true);
    expect(opts.disableUrlAccess).toBe(true);
  });

  it("sets nothing that could redirect the connection", () => {
    const opts = smtpTransportOptions(IMAP_PROVIDERS.NAVER, CREDS) as Record<string, unknown>;
    for (const key of ["proxy", "socket", "sendmail", "service", "pool", "lmtp", "localAddress"]) {
      expect(opts[key]).toBeUndefined();
    }
  });

  it("does not mutate the registry entry it reads", () => {
    const before = JSON.stringify(IMAP_PROVIDERS.NAVER);
    smtpTransportOptions(IMAP_PROVIDERS.NAVER, CREDS);
    expect(JSON.stringify(IMAP_PROVIDERS.NAVER)).toBe(before);
  });
});

describe("createSmtpTransport", () => {
  it("hands exactly those options to nodemailer and returns its transport", () => {
    const transport = createSmtpTransport(IMAP_PROVIDERS.NAVER, CREDS);
    expect(h.createTransport).toHaveBeenCalledTimes(1);
    expect(h.createTransport.mock.calls[0][0]).toEqual(
      smtpTransportOptions(IMAP_PROVIDERS.NAVER, CREDS),
    );
    expect(transport).toBe(h.createTransport.mock.results[0].value);
  });
});

describe("isSmtpAuthRejection", () => {
  it.each([530, 534, 535])("treats EAUTH with reply %i as a rejected login", (responseCode) => {
    expect(isSmtpAuthRejection({ code: "EAUTH", responseCode })).toBe(true);
  });

  it("does not treat transport or recipient failures as a rejected login", () => {
    expect(isSmtpAuthRejection({ code: "ETIMEDOUT" })).toBe(false);
    expect(isSmtpAuthRejection({ code: "ECONNECTION" })).toBe(false);
    expect(isSmtpAuthRejection({ code: "EENVELOPE", responseCode: 550 })).toBe(false);
    expect(isSmtpAuthRejection({ code: "EAUTH", responseCode: 454 })).toBe(false);
    expect(isSmtpAuthRejection({ code: "EAUTH" })).toBe(false);
    expect(isSmtpAuthRejection(null)).toBe(false);
    expect(isSmtpAuthRejection("EAUTH")).toBe(false);
  });
});
