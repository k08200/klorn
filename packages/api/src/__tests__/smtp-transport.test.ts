/**
 * Step B3: the SMTP side of the provider registry and the one place a nodemailer
 * transport is built.
 *
 * Pinned: host, port and security come ONLY from the registry entry of the
 * provider (never from the account row), certificate verification stays on,
 * STARTTLS is mandatory where the registry says STARTTLS (no plaintext
 * fallback), every timeout is an explicit finite constant, nothing that could
 * redirect the connection (proxy, sendmail, pool) is in the options, the only
 * socket is the unconnected one the session creates itself, and the
 * transport logs nothing (SMTP traffic carries the credential and the mail).
 */

import net from "node:net";

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ createTransport: vi.fn(), loads: 0 }));

// Counts how often the package is first imported: it must not load at boot.
vi.mock("nodemailer", () => {
  h.loads += 1;
  return { createTransport: h.createTransport };
});

const loadsBeforeImport = h.loads;
const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");
const {
  SMTP_CONNECTION_TIMEOUT_MS,
  SMTP_DNS_TIMEOUT_MS,
  SMTP_GREETING_TIMEOUT_MS,
  SMTP_SOCKET_TIMEOUT_MS,
  SMTP_EHLO_NAME,
  classifySmtpFailure,
  createSmtpTransport,
  isSmtpAuthRejection,
  openSmtpSession,
  sendRaw,
  smtpTransportOptions,
} = await import("../mail/smtp-transport.js");
const loadsAfterModuleImport = h.loads;

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

  it("introduces itself with a fixed EHLO name, never the machine's hostname", () => {
    const opts = smtpTransportOptions(IMAP_PROVIDERS.NAVER, CREDS);
    expect(SMTP_EHLO_NAME).toBe("klorn.ai");
    expect(opts.name).toBe("klorn.ai");
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
  it("does not import nodemailer until a transport is built (nothing loads at boot)", async () => {
    expect(loadsBeforeImport).toBe(0);
    expect(loadsAfterModuleImport).toBe(0);
    await createSmtpTransport(IMAP_PROVIDERS.NAVER, CREDS);
    expect(h.loads).toBe(1);
  });

  it("hands exactly those options to nodemailer and returns its transport", async () => {
    const transport = await createSmtpTransport(IMAP_PROVIDERS.NAVER, CREDS);
    expect(h.createTransport).toHaveBeenCalledTimes(1);
    expect(h.createTransport.mock.calls[0][0]).toEqual(
      smtpTransportOptions(IMAP_PROVIDERS.NAVER, CREDS),
    );
    expect(transport).toBe(h.createTransport.mock.results[0].value);
  });
});

describe("openSmtpSession — a socket the caller can destroy", () => {
  const transportFor = () => {
    const sendMail = vi.fn(async () => ({ accepted: ["bob@example.com"] }));
    const close = vi.fn();
    h.createTransport.mockReturnValue({ sendMail, close });
    return { sendMail, close };
  };
  const socketOf = () => h.createTransport.mock.calls[0][0].socket as net.Socket;

  it("gives nodemailer the registry options plus a fresh, unconnected socket of its own", async () => {
    transportFor();
    await openSmtpSession(IMAP_PROVIDERS.NAVER, CREDS);
    const options = h.createTransport.mock.calls[0][0];
    expect(options).toEqual({
      ...smtpTransportOptions(IMAP_PROVIDERS.NAVER, CREDS),
      socket: expect.any(net.Socket),
    });
    expect(options.host).toBe("smtp.naver.com");
    expect(socketOf().connecting).toBe(false);
    expect(socketOf().destroyed).toBe(false);
  });

  it("uses a different socket for every session", async () => {
    transportFor();
    await openSmtpSession(IMAP_PROVIDERS.NAVER, CREDS);
    await openSmtpSession(IMAP_PROVIDERS.NAVER, CREDS);
    expect(h.createTransport.mock.calls[0][0].socket).not.toBe(
      h.createTransport.mock.calls[1][0].socket,
    );
  });

  it("abort() destroys the socket itself, not just the transport, and is safe to repeat", async () => {
    const { close } = transportFor();
    const session = await openSmtpSession(IMAP_PROVIDERS.NAVER, CREDS);
    session.abort();
    expect(socketOf().destroyed).toBe(true);
    expect(close).toHaveBeenCalled();
    expect(() => session.abort()).not.toThrow();
  });

  it("close() ends the transport without touching the socket", async () => {
    const { close } = transportFor();
    const session = await openSmtpSession(IMAP_PROVIDERS.NAVER, CREDS);
    session.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(socketOf().destroyed).toBe(false);
  });

  it("reports whether the TCP connection was ever established", async () => {
    transportFor();
    const session = await openSmtpSession(IMAP_PROVIDERS.NAVER, CREDS);
    expect(session.connected).toBe(false);
    socketOf().emit("connect");
    expect(session.connected).toBe(true);
  });

  it("send() submits the exact bytes with an explicit envelope", async () => {
    const { sendMail } = transportFor();
    const session = await openSmtpSession(IMAP_PROVIDERS.NAVER, CREDS);
    const raw = Buffer.from("From: me@naver.com\r\n\r\nhi\r\n");
    await session.send({ from: "me@naver.com", to: "bob@example.com", raw });
    expect(sendMail).toHaveBeenCalledWith({
      envelope: { from: "me@naver.com", to: ["bob@example.com"] },
      raw,
    });
  });
});

describe("classifySmtpFailure — what a failure proves about delivery", () => {
  const err = (code: string, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error("x"), { code, ...extra });

  it.each([
    ["a rejected login (535)", err("EAUTH", { responseCode: 535, command: "AUTH PLAIN" }), true],
    ["a rejected login (534)", err("EAUTH", { responseCode: 534 }), true],
  ])("auth: %s", (_name, error, connected) => {
    expect(classifySmtpFailure(error, connected)).toBe("auth");
  });

  it.each([
    ["a rejected recipient", err("EENVELOPE", { responseCode: 550, command: "RCPT TO" })],
    ["a rejected sender", err("EENVELOPE", { responseCode: 553, command: "MAIL FROM" })],
    ["a refused message after DATA", err("EMESSAGE", { responseCode: 554 })],
  ])("refused: %s", (_name, error) => {
    expect(classifySmtpFailure(error, true)).toBe("refused");
  });

  it.each([
    ["DNS failure", err("EDNS", { command: "CONN" }), true],
    ["a TLS handshake failure", err("ETLS", { command: "CONN" }), true],
    ["a refused STARTTLS", err("ETLS", { responseCode: 502, command: "STARTTLS" }), true],
    ["a login failed without a rejection code", err("EAUTH", { responseCode: 454 }), true],
    ["missing credentials", err("ENOAUTH"), true],
    ["a bad configuration", err("ECONFIG"), true],
    ["a connect that never completed (refused)", err("ECONNECTION", { command: "CONN" }), false],
    ["a connect timeout", err("ETIMEDOUT", { command: "CONN" }), false],
    ["a socket error before the connection", err("ESOCKET", { command: "CONN" }), false],
  ])("not-sent: %s", (_name, error, connected) => {
    expect(classifySmtpFailure(error, connected)).toBe("not-sent");
  });

  it.each([
    ["a stall after DATA (reported as ETIMEDOUT on CONN)", err("ETIMEDOUT", { command: "CONN" })],
    ["a connection dropped mid-message", err("ECONNECTION", { command: "CONN" })],
    ["a socket error on an open connection", err("ESOCKET", { command: "CONN" })],
    ["an invalid server response", err("EPROTOCOL")],
    ["a stream failure", err("ESTREAM")],
    ["an error with no code", new Error("who knows")],
    ["a value that is not an error", "boom"],
  ])("unconfirmed: %s, once the connection was established", (_name, error) => {
    expect(classifySmtpFailure(error, true)).toBe("unconfirmed");
  });

  it("the same stall is 'not-sent' only when no connection was ever established", () => {
    const stall = err("ETIMEDOUT", { command: "CONN" });
    expect(classifySmtpFailure(stall, false)).toBe("not-sent");
    expect(classifySmtpFailure(stall, true)).toBe("unconfirmed");
  });
});

describe("sendRaw", () => {
  it("submits the exact bytes with an explicit envelope and nothing else", async () => {
    const sendMail = vi.fn(async () => ({ accepted: ["bob@example.com"] }));
    const raw = Buffer.from("From: me@naver.com\r\n\r\nhi\r\n");
    await sendRaw({ sendMail } as never, { from: "me@naver.com", to: "bob@example.com", raw });
    expect(sendMail).toHaveBeenCalledWith({
      envelope: { from: "me@naver.com", to: ["bob@example.com"] },
      raw,
    });
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
