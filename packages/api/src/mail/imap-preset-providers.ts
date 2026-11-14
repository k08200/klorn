/**
 * Registry entries of the fixed-host app-password presets (provider phase 2). Each
 * one is exactly the shape Naver and iCloud have: ONE allowlisted IMAP host on 993
 * (is-allowed-imap-host.ts lists the same host) and ONE SMTP endpoint, both
 * constants taken from the provider's own help pages. Nothing here is ever read from
 * a request or an account row; a connect body's `host` that is not this exact host
 * is refused (routes/imap-connect.ts) and re-checked on every poll.
 *
 * SMTP is implicit TLS on 465 for every preset: it is the endpoint each provider
 * documents (Daum, Kakao and AOL document no other; Fastmail calls it the primary
 * one; Yahoo and Zoho list 465 and 587 side by side). The certificate is checked
 * against the pinned host name (smtp-transport.ts).
 *
 * `idPrefix` is persisted in dedup keys: never change one once rows exist.
 * Sources were read on 2026-11-14.
 */

import type { ImapPresetKey } from "./imap-preset-keys.js";
import type { ImapProviderConfig } from "./imap-providers.js";

const IMPLICIT_TLS_PORT = 465;
/** Same ceiling as Naver and iCloud (imap-providers.ts). */
const MAX_PRESET_ACCOUNTS = 10;

export const IMAP_PRESET_PROVIDERS: Readonly<Record<ImapPresetKey, ImapProviderConfig>> = {
  DAUM: {
    provider: "DAUM",
    label: "Daum",
    hostPolicy: "fixed",
    // Daum help, IMAP/POP3 settings
    // (https://cs.daum.net/faq/service/43/category/9234/detail/24081):
    // "imap.daum.net (SSL 사용, 포트 993)"; IMAP must be switched on under 메일 >
    // 설정 > IMAP/POP3, and an app password is required.
    defaultHost: "imap.daum.net:993",
    idPrefix: "daum-imap",
    logScope: "daum-imap",
    authFailureHint:
      "Daum IMAP login failed. Turn on IMAP in Daum Mail settings, set up two-step verification, then create an app password and paste that — not your account password.",
    maxAccounts: MAX_PRESET_ACCOUNTS,
    // Daum help, SMTP (https://cs.daum.net/faq/service/43/category/9234/detail/30863):
    // smtp.daum.net, port 465, SSL. Two-step verification is required for IMAP
    // logins since 2025-01-02 (https://hanmail-notice.daum.net/list/907).
    smtp: { host: "smtp.daum.net", port: IMPLICIT_TLS_PORT, security: "implicit-tls" },
    webmailUrl: "https://mail.daum.net/",
  },
  KAKAO: {
    provider: "KAKAO",
    label: "Kakao",
    hostPolicy: "fixed",
    // Kakao help, IMAP/POP3 server addresses
    // (https://cs.kakao.com/helps_html/1073195244): IMAP imap.kakao.com, 993, SSL;
    // SMTP smtp.kakao.com, 465, SSL. A separate service from Daum since 2025-12-01,
    // so a kakao.com mailbox does not use the Daum hosts.
    defaultHost: "imap.kakao.com:993",
    idPrefix: "kakao-imap",
    logScope: "kakao-imap",
    authFailureHint:
      "Kakao Mail IMAP login failed. Turn on IMAP in Kakao Mail settings, set up two-step verification on your Kakao account, then create an app password and paste that — not your account password.",
    maxAccounts: MAX_PRESET_ACCOUNTS,
    // Kakao help (https://cs.kakao.com/helps_html/1073209983): IMAP logins need
    // two-step verification and an app password, and IMAP switched on in settings.
    smtp: { host: "smtp.kakao.com", port: IMPLICIT_TLS_PORT, security: "implicit-tls" },
    webmailUrl: "https://mail.kakao.com/",
  },
  YAHOO: {
    provider: "YAHOO",
    label: "Yahoo",
    hostPolicy: "fixed",
    // Yahoo help, IMAP server settings (https://help.yahoo.com/kb/SLN4075.html):
    // "imap.mail.yahoo.com", port 993, SSL; SMTP smtp.mail.yahoo.com, 465 or 587,
    // SSL; the username is the full address and the password an app password
    // (https://help.yahoo.com/kb/SLN15241.html).
    defaultHost: "imap.mail.yahoo.com:993",
    idPrefix: "yahoo-imap",
    logScope: "yahoo-imap",
    authFailureHint:
      "Yahoo IMAP login failed. Create an app password in your Yahoo account security settings and paste that — not your account password.",
    maxAccounts: MAX_PRESET_ACCOUNTS,
    smtp: { host: "smtp.mail.yahoo.com", port: IMPLICIT_TLS_PORT, security: "implicit-tls" },
    webmailUrl: "https://mail.yahoo.com/",
  },
  AOL: {
    provider: "AOL",
    label: "AOL",
    hostPolicy: "fixed",
    // AOL help, using other email applications
    // (https://help.aol.com/articles/how-do-i-use-other-email-applications-to-send-and-receive-my-aol-mail):
    // IMAP imap.aol.com, 993, SSL; SMTP smtp.aol.com, 465, SSL; the username is the
    // full address. A client without OAuth needs an app password
    // (https://help.aol.com/articles/create-and-manage-app-password).
    defaultHost: "imap.aol.com:993",
    idPrefix: "aol-imap",
    logScope: "aol-imap",
    authFailureHint:
      "AOL IMAP login failed. Create an app password in your AOL account security settings and paste that — not your account password.",
    maxAccounts: MAX_PRESET_ACCOUNTS,
    smtp: { host: "smtp.aol.com", port: IMPLICIT_TLS_PORT, security: "implicit-tls" },
    webmailUrl: "https://mail.aol.com/",
  },
  FASTMAIL: {
    provider: "FASTMAIL",
    label: "Fastmail",
    hostPolicy: "fixed",
    // Fastmail help, server names and ports
    // (https://www.fastmail.help/hc/en-us/articles/1500000278342-Server-names-and-ports):
    // IMAP imap.fastmail.com, 993, SSL/TLS; SMTP smtp.fastmail.com, 465, SSL/TLS
    // (587 with STARTTLS only as the fallback). Every third-party app needs its
    // own app password
    // (https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords).
    defaultHost: "imap.fastmail.com:993",
    idPrefix: "fastmail-imap",
    logScope: "fastmail-imap",
    authFailureHint:
      "Fastmail IMAP login failed. Create an app password with IMAP and SMTP access in Fastmail settings (Privacy & Security) and paste that — not your account password.",
    maxAccounts: MAX_PRESET_ACCOUNTS,
    smtp: { host: "smtp.fastmail.com", port: IMPLICIT_TLS_PORT, security: "implicit-tls" },
    webmailUrl: "https://app.fastmail.com/",
  },
  ZOHO: {
    provider: "ZOHO",
    label: "Zoho",
    hostPolicy: "fixed",
    // Zoho Mail help, IMAP access (https://www.zoho.com/mail/help/imap-access.html),
    // personal and free organization users: "Incoming Server Name: imap.zoho.com",
    // port 993, SSL; "Outgoing Server Name: smtp.zoho.com", 465 with SSL (or 587
    // with TLS). IMAP access must be enabled in Zoho Mail settings; with two-factor
    // authentication on, an application-specific password is needed. Only the .com
    // data center's hosts are documented, so no other data center is listed here.
    // Zoho accepts the account password while two-factor is off; Klorn asks only for
    // an application-specific one (the hint and the clients' copy say so).
    defaultHost: "imap.zoho.com:993",
    idPrefix: "zoho-imap",
    logScope: "zoho-imap",
    authFailureHint:
      "Zoho IMAP login failed. Turn on IMAP access in Zoho Mail settings and two-factor authentication, then create an application-specific password and paste that — not your account password.",
    maxAccounts: MAX_PRESET_ACCOUNTS,
    smtp: { host: "smtp.zoho.com", port: IMPLICIT_TLS_PORT, security: "implicit-tls" },
    webmailUrl: "https://mail.zoho.com/",
  },
  ZOHOPRO: {
    provider: "ZOHOPRO",
    label: "Zoho (organization)",
    hostPolicy: "fixed",
    // Same page, organization users (paid, domain-based addresses):
    // "Incoming Server Name: imappro.zoho.com", 993, SSL; "Outgoing Server Name:
    // smtppro.zoho.com", 465 with SSL (or 587 with TLS).
    defaultHost: "imappro.zoho.com:993",
    idPrefix: "zohopro-imap",
    logScope: "zohopro-imap",
    authFailureHint:
      "Zoho IMAP login failed. Turn on IMAP access in Zoho Mail settings (your organization's admin may need to allow it) and two-factor authentication, then create an application-specific password and paste that — not your account password.",
    maxAccounts: MAX_PRESET_ACCOUNTS,
    smtp: { host: "smtppro.zoho.com", port: IMPLICIT_TLS_PORT, security: "implicit-tls" },
    webmailUrl: "https://mail.zoho.com/",
  },
};
