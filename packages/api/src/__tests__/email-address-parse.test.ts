/**
 * The sender's address from a From header. A display name is the sender's to
 * write, and RFC 5322 lets it hold `<...>` inside a quoted-string or a comment:
 * `"<victim@target.com>" <attacker@evil.co>` is a valid header whose mailbox is
 * attacker@evil.co. Taking the first `<...>` read victim@target.com, and the reply
 * paths (a user's reply, a rule's auto-reply) sent to it: mail to an address the
 * sender chose, from the user's own account. The address is the one angle-addr
 * outside quoted-strings and comments; anything ambiguous (two of them, one left
 * open, an unterminated quote or comment, a stray backslash) gives "", which no
 * reply path sends to. One linear pass.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { recipientFromHeader } from "../agentcore/auto-mode-sweep.js";
import { extractEmailAddress, formatMailbox, parseAddress } from "../mail/email-address.js";
import { expectLinear, repeatTo } from "./helpers/linear-timing.js";

describe("parseAddress", () => {
  it.each([
    ["Name <a@b.com>", "a@b.com"],
    ["a@b.com", "a@b.com"],
    ["  A@B.com  ", "A@B.com"],
    ['"Name, Inc." <A@B.com>', "A@B.com"],
    ["<a@b.com>", "a@b.com"],
    ["", ""],
    ["Doe, John <j@x.com>", "j@x.com"],
    ["joe@ok.com (Joe)", "joe@ok.com"],
    ['<"a b"@x.com>', '"a b"@x.com'],
    ['"john.smith"@example.com', '"john.smith"@example.com'],
    ['"Smith, J" <"j.s"@x.com>', '"j.s"@x.com'],
  ])("%j → %j", (header, address) => {
    expect(parseAddress(header)).toBe(address);
  });

  it.each([
    ['"<victim@target.com>" <attacker@evil.co>', "attacker@evil.co"],
    ['"a \\" <victim@target.com>" <attacker@evil.co>', "attacker@evil.co"],
    ["Attacker <attacker@evil.co> (<victim@target.com>)", "attacker@evil.co"],
    ["(<victim@target.com>) <attacker@evil.co>", "attacker@evil.co"],
    ['"<victim@target.com>" attacker@evil.co', "attacker@evil.co"],
    ["(a (<victim@target.com>) b) <attacker@evil.co>", "attacker@evil.co"],
  ])("a display name cannot choose the address: %j", (header, address) => {
    expect(parseAddress(header)).toBe(address);
  });

  it.each([
    ['"<victim@target.com> <attacker@evil.co>'],
    ['<victim@target.com> " <attacker@evil.co>'],
    ["<victim@target.com> ( <attacker@evil.co>"],
    ["<victim@target.com> <attacker@evil.co>"],
    ["<attacker@evil.co>, <victim@target.com>"],
    ["Name <attacker@evil.co>, Other <victim@target.com>"],
    ['X\\" <attacker@evil.co> "Y <victim@target.com>'],
    ["<victim@target.com"],
    ["<a<victim@target.com>"],
  ])("refuses an ambiguous header: %j", (header) => {
    expect(parseAddress(header)).toBe("");
  });

  it("stays linear on adversarial input", () => {
    expectLinear((bytes) => repeatTo(bytes, '\\"', '"'), parseAddress);
    expectLinear((bytes) => repeatTo(bytes, "<"), parseAddress);
    expectLinear((bytes) => repeatTo(bytes, "(", "", ")"), parseAddress);
    expectLinear((bytes) => repeatTo(bytes, '"<x@y.z>"'), parseAddress);
    expectLinear((bytes) => repeatTo(bytes, "x", "<", ">"), parseAddress);
    expectLinear((bytes) => repeatTo(bytes, '"x"@', "<", ">"), parseAddress);
    expectLinear((bytes) => repeatTo(bytes, "a(b)"), parseAddress);
  });
});

describe("formatMailbox", () => {
  it("leaves a plain name as it is", () => {
    expect(formatMailbox("Doe, John", "j@x.com")).toBe("Doe, John <j@x.com>");
  });

  it("quotes a name that would change the parse, so it still names its own address", () => {
    for (const name of [
      '<victim@target.com> "',
      "<victim@target.com> (",
      "<victim@target.com>",
      'a\\b "c"',
    ]) {
      expect(parseAddress(formatMailbox(name, "attacker@evil.co"))).toBe("attacker@evil.co");
    }
  });

  it("is the address alone, or the name alone, when one is missing", () => {
    expect(formatMailbox("", "a@b.com")).toBe("a@b.com");
    expect(formatMailbox("Name", "")).toBe("Name");
  });
});

describe("extractEmailAddress", () => {
  it("is the parsed address, lowercased", () => {
    expect(extractEmailAddress('"<Victim@Target.com>" <Attacker@Evil.co>')).toBe(
      "attacker@evil.co",
    );
  });
});

describe("the reply recipient", () => {
  it("of a rule's auto-reply is the sender's real mailbox", () => {
    expect(recipientFromHeader('"<victim@target.com>" <attacker@evil.co>')).toBe(
      "attacker@evil.co",
    );
  });
});

describe("From-header parsing in the source", () => {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "__tests__" ? [] : files(full);
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
    });

  it("goes through mail/email-address.ts: no other first-angle-bracket parser", () => {
    const offenders = files(srcDir)
      .filter((full) => relative(srcDir, full) !== "mail/email-address.ts")
      .filter((full) => readFileSync(full, "utf8").includes("/<([^>]+)>/"))
      .map((full) => relative(srcDir, full));
    expect(offenders).toEqual([]);
  });
});
