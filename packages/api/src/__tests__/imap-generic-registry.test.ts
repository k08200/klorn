/**
 * Step B4: the registry entry for generic IMAP, the flag that gates it, and the
 * host check that replaces the fixed-host pin for it. Naver and iCloud keep their
 * exact-host behaviour.
 */

import { afterEach, describe, expect, it } from "vitest";

import { genericImapEnabled } from "../config.js";
import {
  enabledImapProviderKeys,
  hostMatchesProvider,
  IMAP_PROVIDERS,
} from "../mail/imap-providers.js";

const FLAGS = ["GENERIC_IMAP_ENABLED", "ICLOUD_INBOX_ENABLED"] as const;
const original = Object.fromEntries(FLAGS.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of FLAGS) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("genericImapEnabled: request-time, lenient parse, OFF by default", () => {
  it.each(["true", "TRUE", " 1 ", "yes", "on", "On"])("%j is on", (value) => {
    process.env.GENERIC_IMAP_ENABLED = value;
    expect(genericImapEnabled()).toBe(true);
  });

  it.each(["", "0", "false", "no", "off", "enabled", "2"])("%j is off", (value) => {
    process.env.GENERIC_IMAP_ENABLED = value;
    expect(genericImapEnabled()).toBe(false);
  });

  it("is off when unset, and read on every call", () => {
    delete process.env.GENERIC_IMAP_ENABLED;
    expect(genericImapEnabled()).toBe(false);
    process.env.GENERIC_IMAP_ENABLED = "true";
    expect(genericImapEnabled()).toBe(true);
    process.env.GENERIC_IMAP_ENABLED = "false";
    expect(genericImapEnabled()).toBe(false);
  });
});

describe("IMAP_PROVIDERS.IMAP", () => {
  const entry = IMAP_PROVIDERS.IMAP;

  it("is the generic, user-host provider", () => {
    expect(entry.provider).toBe("IMAP");
    expect(entry.hostPolicy).toBe("user-supplied");
    expect(entry.defaultHost).toBeNull();
  });

  it("pins its persisted dedup-key namespace and log scope", () => {
    expect(entry.idPrefix).toBe("generic-imap");
    expect(entry.logScope).toBe("generic-imap");
  });

  it("caps accounts at 3 (the poll is serial and every host is an arbitrary one)", () => {
    expect(entry.maxAccounts).toBe(3);
    expect(entry.maxAccounts).toBeLessThan(IMAP_PROVIDERS.NAVER.maxAccounts);
  });

  it("has no outgoing mail endpoint and no webmail link (send is out of scope for B4)", () => {
    expect(entry.smtp).toBeNull();
    expect(entry.webmailUrl).toBeNull();
  });

  it("explains a rejected login without naming a provider", () => {
    expect(entry.authFailureHint).toMatch(/login failed/i);
    expect(entry.authFailureHint).toMatch(/app password/i);
  });

  it("no dedup prefix is a prefix of another (ids stay unambiguous)", () => {
    const prefixes = Object.values(IMAP_PROVIDERS).map((p) => `${p.idPrefix}:`);
    for (const a of prefixes) {
      for (const b of prefixes) {
        if (a !== b) expect(b.startsWith(a)).toBe(false);
      }
    }
  });
});

describe("Naver and iCloud are still fixed-host providers", () => {
  it.each(["NAVER", "ICLOUD"] as const)("%s", (key) => {
    const entry = IMAP_PROVIDERS[key];
    expect(entry.hostPolicy).toBe("fixed");
    expect(entry.defaultHost).toMatch(/:993$/);
    expect(entry.smtp).not.toBeNull();
    expect(entry.webmailUrl).toMatch(/^https:\/\//);
  });
});

describe("hostMatchesProvider", () => {
  it("fixed providers: the exact host, nothing else", () => {
    expect(hostMatchesProvider("imap.naver.com:993", IMAP_PROVIDERS.NAVER)).toBe(true);
    expect(hostMatchesProvider("imap.naver.com", IMAP_PROVIDERS.NAVER)).toBe(true);
    expect(hostMatchesProvider("imap.mail.me.com:993", IMAP_PROVIDERS.NAVER)).toBe(false);
    expect(hostMatchesProvider("imap.example.com:993", IMAP_PROVIDERS.NAVER)).toBe(false);
    expect(hostMatchesProvider("imap.example.com:993", IMAP_PROVIDERS.ICLOUD)).toBe(false);
  });

  it("generic: replaced by the host grammar, so any public name passes and nothing internal does", () => {
    const generic = IMAP_PROVIDERS.IMAP;
    expect(hostMatchesProvider("imap.fastmail.com:993", generic)).toBe(true);
    expect(hostMatchesProvider("IMAP.Fastmail.com", generic)).toBe(true);
    expect(hostMatchesProvider("127.0.0.1:993", generic)).toBe(false);
    expect(hostMatchesProvider("printer.local", generic)).toBe(false);
    expect(hostMatchesProvider("imap.fastmail.com:143", generic)).toBe(false);
    expect(hostMatchesProvider("", generic)).toBe(false);
  });
});

describe("enabledImapProviderKeys: GENERIC_IMAP_ENABLED", () => {
  it("is unchanged while the flag is off", () => {
    delete process.env.GENERIC_IMAP_ENABLED;
    delete process.env.ICLOUD_INBOX_ENABLED;
    expect(enabledImapProviderKeys()).toEqual(["NAVER"]);
    process.env.ICLOUD_INBOX_ENABLED = "true";
    expect(enabledImapProviderKeys()).toEqual(["NAVER", "ICLOUD"]);
  });

  it("adds IMAP when on, independent of the iCloud freeze", () => {
    process.env.GENERIC_IMAP_ENABLED = "true";
    delete process.env.ICLOUD_INBOX_ENABLED;
    expect(enabledImapProviderKeys()).toEqual(["NAVER", "IMAP"]);
    process.env.ICLOUD_INBOX_ENABLED = "true";
    expect(enabledImapProviderKeys()).toEqual(["NAVER", "ICLOUD", "IMAP"]);
  });
});
