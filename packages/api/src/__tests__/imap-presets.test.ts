/**
 * Provider phase 2: fixed-host app-password IMAP presets (Daum, Kakao, Yahoo, AOL,
 * Fastmail, Zoho). Each preset reuses the Naver/iCloud path, so the invariants that
 * matter are the same ones: every host (IMAP and SMTP) is a constant taken from the
 * provider's own documentation, a request can never choose another one, and the whole
 * set stays dark behind IMAP_PRESETS_ENABLED (off / cohort / on).
 */

import { afterEach, describe, expect, it } from "vitest";
import { IMAP_PRESET_KEYS } from "../mail/imap-preset-keys.js";
import {
  enabledImapProviderKeys,
  hostMatchesProvider,
  IMAP_PROVIDERS,
} from "../mail/imap-providers.js";
import { isAllowedImapHost } from "../mail/is-allowed-imap-host.js";

const FLAG_ENV = [
  "IMAP_PRESETS_ENABLED",
  "ICLOUD_INBOX_ENABLED",
  "GENERIC_IMAP_ENABLED",
  "ROLLOUT_COHORT_USER_IDS",
] as const;
const ORIGINAL = Object.fromEntries(FLAG_ENV.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of FLAG_ENV) {
    const value = ORIGINAL[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** The documented endpoints, written out by hand so a registry edit has to change this too. */
const PINNED = {
  DAUM: { imap: "imap.daum.net:993", smtp: "smtp.daum.net", prefix: "daum-imap" },
  KAKAO: { imap: "imap.kakao.com:993", smtp: "smtp.kakao.com", prefix: "kakao-imap" },
  YAHOO: { imap: "imap.mail.yahoo.com:993", smtp: "smtp.mail.yahoo.com", prefix: "yahoo-imap" },
  AOL: { imap: "imap.aol.com:993", smtp: "smtp.aol.com", prefix: "aol-imap" },
  FASTMAIL: { imap: "imap.fastmail.com:993", smtp: "smtp.fastmail.com", prefix: "fastmail-imap" },
  ZOHO: { imap: "imap.zoho.com:993", smtp: "smtp.zoho.com", prefix: "zoho-imap" },
  ZOHOPRO: { imap: "imappro.zoho.com:993", smtp: "smtppro.zoho.com", prefix: "zohopro-imap" },
} as const;

describe("preset registry: every host is pinned", () => {
  it("covers exactly the documented presets", () => {
    expect([...IMAP_PRESET_KEYS].sort()).toEqual(Object.keys(PINNED).sort());
  });

  it.each(
    IMAP_PRESET_KEYS,
  )("%s is fixed-host with its documented IMAP and SMTP endpoints", (key) => {
    const entry = IMAP_PROVIDERS[key];
    expect(entry.provider).toBe(key);
    expect(entry.hostPolicy).toBe("fixed");
    expect(entry.defaultHost).toBe(PINNED[key].imap);
    // Implicit TLS on 465: TLS from the first byte, certificate checked (smtp-transport.ts).
    expect(entry.smtp).toEqual({ host: PINNED[key].smtp, port: 465, security: "implicit-tls" });
    expect(entry.idPrefix).toBe(PINNED[key].prefix);
    expect(entry.webmailUrl).toMatch(/^https:\/\//);
    expect(entry.maxAccounts).toBeGreaterThan(0);
    expect(entry.authFailureHint.length).toBeGreaterThan(20);
  });

  it.each(IMAP_PRESET_KEYS)("%s: its host is on the SSRF allowlist, on 993 only", (key) => {
    const host = PINNED[key].imap.split(":")[0];
    expect(isAllowedImapHost(PINNED[key].imap)).toBe(true);
    expect(isAllowedImapHost(`${host}:143`)).toBe(false);
    expect(isAllowedImapHost(`${host}:465`)).toBe(false);
  });

  it.each(IMAP_PRESET_KEYS)("%s accepts its own host and no other provider's", (key) => {
    const entry = IMAP_PROVIDERS[key];
    expect(hostMatchesProvider(PINNED[key].imap, entry)).toBe(true);
    expect(hostMatchesProvider(PINNED[key].imap.toUpperCase(), entry)).toBe(true);
    for (const other of IMAP_PRESET_KEYS) {
      if (other !== key) expect(hostMatchesProvider(PINNED[other].imap, entry)).toBe(false);
    }
    expect(hostMatchesProvider("imap.naver.com:993", entry)).toBe(false);
    expect(hostMatchesProvider("imap.mail.me.com:993", entry)).toBe(false);
    expect(hostMatchesProvider("imap.example.com:993", entry)).toBe(false);
    expect(hostMatchesProvider("127.0.0.1:993", entry)).toBe(false);
  });

  it("no SMTP host is shared between presets or reused from an IMAP host", () => {
    const smtpHosts = IMAP_PRESET_KEYS.map((key) => IMAP_PROVIDERS[key].smtp?.host);
    expect(new Set(smtpHosts).size).toBe(IMAP_PRESET_KEYS.length);
    for (const key of IMAP_PRESET_KEYS) {
      expect(isAllowedImapHost(IMAP_PROVIDERS[key].smtp?.host ?? "")).toBe(false);
    }
  });
});

describe("enabledImapProviderKeys: IMAP_PRESETS_ENABLED", () => {
  it("excludes every preset while the flag is off (default)", () => {
    for (const value of [undefined, "", "false", "0", "off"]) {
      if (value === undefined) delete process.env.IMAP_PRESETS_ENABLED;
      else process.env.IMAP_PRESETS_ENABLED = value;
      const keys = enabledImapProviderKeys();
      for (const key of IMAP_PRESET_KEYS) expect(keys).not.toContain(key);
    }
  });

  it.each(["true", "on", "cohort"])("includes every preset when the flag is %s", (value) => {
    process.env.IMAP_PRESETS_ENABLED = value;
    const keys = enabledImapProviderKeys();
    for (const key of IMAP_PRESET_KEYS) expect(keys).toContain(key);
  });

  it("does not depend on the iCloud or generic IMAP flags", () => {
    delete process.env.ICLOUD_INBOX_ENABLED;
    delete process.env.GENERIC_IMAP_ENABLED;
    process.env.IMAP_PRESETS_ENABLED = "true";
    expect(enabledImapProviderKeys()).toEqual(["NAVER", ...IMAP_PRESET_KEYS]);
  });
});
