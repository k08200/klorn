/**
 * Step B4, design D1: the grammar of a user-supplied IMAP host. Pure and checked
 * before any network. A DNS name only (no IP literal, no userinfo, no port but
 * 993), folded to ASCII (punycode), length-bounded, with internal suffixes refused.
 * The folded name is what is stored and connected to.
 */

import { describe, expect, it } from "vitest";

import { GENERIC_IMAP_PORT, parseGenericImapHost } from "../mail/generic-imap-host.js";
import { isAllowedImapHost } from "../mail/is-allowed-imap-host.js";

/** A valid-looking name of exactly `total` characters: four 50-character labels, a variable one, and .com. */
function nameOfLength(total: number): string {
  const fixed = Array.from({ length: 4 }, () => "a".repeat(50));
  const last = "b".repeat(total - (4 * 50 + 4) - ".com".length);
  return `${[...fixed, last].join(".")}.com`;
}

const ACCEPTED: ReadonlyArray<readonly [string, string]> = [
  ["imap.fastmail.com", "imap.fastmail.com"],
  ["imap.fastmail.com:993", "imap.fastmail.com"],
  ["  IMAP.Fastmail.COM  ", "imap.fastmail.com"],
  ["imap.daum.net", "imap.daum.net"],
  ["mail.example.co.kr", "mail.example.co.kr"],
  ["a-b.c-d.example.org", "a-b.c-d.example.org"],
  ["123.example.com", "123.example.com"],
  ["imap2.example.com", "imap2.example.com"],
  // IDN: folded to punycode, which is what gets stored and used.
  ["münchen.de", "xn--mnchen-3ya.de"],
  ["xn--mnchen-3ya.de", "xn--mnchen-3ya.de"],
  ["example.한국", "example.xn--3e0b707e"],
  // UTS 46 folding: full-width letters and the ideographic full stop.
  ["ＩＭＡＰ.ＥＸＡＭＰＬＥ.ＣＯＭ", "imap.example.com"],
  ["imap。example。com", "imap.example.com"],
  // Names that only LOOK like an internal suffix.
  ["internal.example.com", "internal.example.com"],
  ["localhost.example.com", "localhost.example.com"],
  ["local.example.com", "local.example.com"],
  ["mail.notlocal.com", "mail.notlocal.com"],
  ["mail.fakelocal", "mail.fakelocal"],
  [`${"a".repeat(63)}.example.com`, `${"a".repeat(63)}.example.com`],
];

describe("parseGenericImapHost: accepted", () => {
  it.each(ACCEPTED)("%j -> %s", (input, hostname) => {
    expect(parseGenericImapHost(input)).toEqual({
      ok: true,
      hostname,
      port: GENERIC_IMAP_PORT,
      stored: `${hostname}:993`,
    });
  });

  it("uses 993 and nothing else", () => {
    expect(GENERIC_IMAP_PORT).toBe(993);
  });

  it("accepts a name of exactly 253 characters", () => {
    const name = nameOfLength(253);
    expect(name.length).toBe(253);
    expect(parseGenericImapHost(name)).toMatchObject({ ok: true, hostname: name });
  });

  it("an IDN look-alike stays a different (xn--) host and never equals its ASCII twin", () => {
    // U+0430 CYRILLIC SMALL LETTER A in place of the Latin a.
    const result = parseGenericImapHost("аpple.com");
    expect(result).toMatchObject({ ok: true, hostname: "xn--pple-43d.com" });
    expect(result.ok && result.hostname).not.toBe("apple.com");
  });

  it("full-width forms fold to the ASCII host they spell", () => {
    expect(parseGenericImapHost("ｇｏｏｇｌｅ.com")).toMatchObject({
      ok: true,
      hostname: "google.com",
    });
  });
});

const REJECTED: ReadonlyArray<readonly [string, string, string]> = [
  // empty
  ["empty", "", "empty"],
  ["blank", "   ", "empty"],
  // IP literals, in every spelling
  ["IPv4 loopback", "127.0.0.1", "ip-literal"],
  ["IPv4 loopback with port", "127.0.0.1:993", "ip-literal"],
  ["unspecified", "0.0.0.0", "ip-literal"],
  ["metadata", "169.254.169.254", "ip-literal"],
  ["metadata with port", "169.254.169.254:993", "ip-literal"],
  ["RFC1918", "10.0.0.1", "ip-literal"],
  ["public IPv4 literal", "8.8.8.8", "ip-literal"],
  ["decimal IPv4", "2130706433", "ip-literal"],
  ["hex IPv4", "0x7f.0.0.1", "ip-literal"],
  ["short IPv4", "127.1", "ip-literal"],
  ["full-width IPv4", "１２７.０.０.１", "ip-literal"],
  ["IPv6 loopback", "::1", "ip-literal"],
  ["bracketed IPv6", "[::1]", "ip-literal"],
  ["bracketed IPv6 with port", "[::1]:993", "ip-literal"],
  ["IPv6 link-local", "fe80::1", "ip-literal"],
  ["IPv4-mapped IPv6", "[::ffff:10.0.0.1]:993", "ip-literal"],
  // userinfo, path, query, fragment, separators, control characters
  ["userinfo", "user@imap.example.com", "invalid-format"],
  ["host after @", "imap.example.com@evil.com", "invalid-format"],
  ["user:pass@", "user:pass@imap.example.com", "invalid-format"],
  ["port then @", "imap.example.com:993@10.0.0.1", "invalid-format"],
  ["path", "imap.example.com/path", "invalid-format"],
  ["query", "imap.example.com?x=1", "invalid-format"],
  ["fragment", "imap.example.com#frag", "invalid-format"],
  ["backslash", "imap.example.com\\evil.com", "invalid-format"],
  ["inner space", "imap.example.com evil.com", "invalid-format"],
  ["inner newline", "imap.example.com\r\nevil.com", "invalid-format"],
  ["tab", "imap\t.example.com", "invalid-format"],
  ["NUL", "imap.example.com\u0000", "invalid-format"],
  ["percent", "imap.example.com%00", "invalid-format"],
  ["scheme", "imaps://imap.example.com", "invalid-format"],
  // ports: 993 only, in canonical text
  ["IMAP port 143", "imap.example.com:143", "port-not-allowed"],
  ["SMTP 587", "imap.example.com:587", "port-not-allowed"],
  ["SMTP 465", "imap.example.com:465", "port-not-allowed"],
  ["port 80", "imap.example.com:80", "port-not-allowed"],
  ["port 0", "imap.example.com:0", "port-not-allowed"],
  ["port 65536", "imap.example.com:65536", "port-not-allowed"],
  ["padded 0993", "imap.example.com:0993", "port-not-allowed"],
  ["empty port", "imap.example.com:", "invalid-format"],
  ["text port", "imap.example.com:abc", "invalid-format"],
  ["signed port", "imap.example.com:+993", "invalid-format"],
  ["two ports", "imap.example.com:993:993", "invalid-format"],
  ["port only", ":993", "invalid-format"],
  // label and name shape
  ["underscore", "imap_server.example.com", "invalid-format"],
  ["leading hyphen", "-imap.example.com", "invalid-format"],
  ["trailing hyphen", "imap-.example.com", "invalid-format"],
  ["empty label", "imap..example.com", "invalid-format"],
  ["leading dot", ".example.com", "invalid-format"],
  ["trailing dot", "example.com.", "invalid-format"],
  ["trailing dot on an internal name", "localhost.", "invalid-format"],
  ["64-character label", `${"a".repeat(64)}.example.com`, "invalid-format"],
  ["numeric TLD", "example.123", "invalid-format"],
  ["one-letter TLD", "example.c", "invalid-format"],
  ["TLD with a digit", "imap.example.c0m", "invalid-format"],
  // no dot at all
  ["bare localhost", "localhost", "single-label"],
  ["metadata short name", "metadata", "single-label"],
  ["intranet short name", "intranet", "single-label"],
  ["single label", "imap", "single-label"],
  // internal suffixes
  [".local", "printer.local", "internal-suffix"],
  [".internal", "db.internal", "internal-suffix"],
  ["GCP metadata", "metadata.google.internal", "internal-suffix"],
  [".localhost", "foo.localhost", "internal-suffix"],
  ["nested .localhost", "foo.bar.localhost", "internal-suffix"],
  [".localdomain", "host.localdomain", "internal-suffix"],
  [".lan", "router.lan", "internal-suffix"],
  [".home", "nas.home", "internal-suffix"],
  [".corp", "svc.corp", "internal-suffix"],
  [".intranet", "wiki.intranet", "internal-suffix"],
  [".private", "x.private", "internal-suffix"],
  [".home.arpa", "router.home.arpa", "internal-suffix"],
  [".arpa", "4.3.2.1.in-addr.arpa", "internal-suffix"],
  [".test", "a.test", "internal-suffix"],
  [".invalid", "a.invalid", "internal-suffix"],
  [".example", "a.example", "internal-suffix"],
  [".onion", "a.onion", "internal-suffix"],
  ["metadata.goog", "metadata.goog", "internal-suffix"],
  ["under metadata.goog", "x.metadata.goog", "internal-suffix"],
  ["upper case suffix", "DB.INTERNAL", "internal-suffix"],
  ["ideographic dot before suffix", "db。internal", "internal-suffix"],
  ["full-width suffix", "ｄｂ.ｉｎｔｅｒｎａｌ", "internal-suffix"],
  ["suffix with a port", "db.internal:993", "internal-suffix"],
  // built-in providers have their own connection
  ["Naver", "imap.naver.com", "built-in-provider"],
  ["Naver with port", "imap.naver.com:993", "built-in-provider"],
  ["iCloud", "imap.mail.me.com", "built-in-provider"],
  ["Gmail", "imap.gmail.com", "built-in-provider"],
  ["Gmail alias", "imap.googlemail.com", "built-in-provider"],
  ["Outlook", "outlook.office365.com", "built-in-provider"],
  ["Outlook legacy", "imap-mail.outlook.com", "built-in-provider"],
  ["built-in in capitals", "IMAP.GMAIL.COM", "built-in-provider"],
  ["built-in as a full-width name", "ｉｍａｐ.ｇｍａｉｌ.ｃｏｍ", "built-in-provider"],
];

describe("parseGenericImapHost: rejected", () => {
  it.each(REJECTED)("%s: %j", (_label, input, reason) => {
    expect(parseGenericImapHost(input)).toEqual({ ok: false, reason });
  });

  it("every host of the existing fixed-host allowlist is refused (the two lists cannot drift apart)", () => {
    for (const host of ["imap.naver.com", "imap.mail.me.com"]) {
      expect(isAllowedImapHost(host)).toBe(true);
      expect(parseGenericImapHost(host)).toEqual({ ok: false, reason: "built-in-provider" });
    }
  });

  it.each([
    "imap.gmail.com.example.org",
    "imap.naver.com.evil.net",
    "mail.gmail.com",
    "gmail.com",
    "outlook.office365.com.example.org",
    "imap.mail.me.com.attacker.io",
  ])("a name that only CONTAINS a built-in host is a different host: %s", (host) => {
    expect(parseGenericImapHost(host)).toMatchObject({ ok: true, hostname: host });
  });

  it("rejects a name over 253 characters", () => {
    const name = nameOfLength(254);
    expect(name.length).toBe(254);
    expect(parseGenericImapHost(name)).toEqual({ ok: false, reason: "too-long" });
  });

  it("rejects an absurdly long input without doing the folding work", () => {
    expect(parseGenericImapHost("a".repeat(100_000))).toEqual({ ok: false, reason: "too-long" });
  });

  it.each([
    undefined,
    null,
    993,
    {},
    [],
    ["imap.example.com"],
  ])("rejects a value that is not a string: %j", (input) => {
    expect(parseGenericImapHost(input)).toEqual({ ok: false, reason: "invalid-format" });
  });
});
