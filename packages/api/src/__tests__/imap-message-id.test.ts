/**
 * The synthetic provider message id of an IMAP row is
 * `<idPrefix>:<mailbox email>:<uid>` (imap-sync.ts writes it, EmailMessage
 * .gmailId stores it). Flag actions address the server by that UID, so the
 * parser is a security boundary: anything that is not EXACTLY this shape for
 * THIS mailbox must be refused before a connection is opened.
 */

import { describe, expect, it } from "vitest";
import { formatImapMessageId, MAX_IMAP_UID, parseImapMessageId } from "../mail/imap-message-id.js";

const PREFIX = "naver-imap";
const EMAIL = "me@naver.com";

describe("formatImapMessageId", () => {
  it("builds the persisted dedup key shape", () => {
    expect(formatImapMessageId(PREFIX, EMAIL, 101)).toBe("naver-imap:me@naver.com:101");
    expect(formatImapMessageId("icloud-imap", "a@icloud.com", 7)).toBe(
      "icloud-imap:a@icloud.com:7",
    );
  });
});

describe("parseImapMessageId", () => {
  it("round-trips whatever formatImapMessageId produced", () => {
    for (const uid of [1, 2, 101, 65_535, 4_000_000_000, MAX_IMAP_UID]) {
      expect(parseImapMessageId(formatImapMessageId(PREFIX, EMAIL, uid), PREFIX, EMAIL)).toBe(uid);
    }
  });

  it("accepts the smallest and the largest legal UID", () => {
    expect(parseImapMessageId("naver-imap:me@naver.com:1", PREFIX, EMAIL)).toBe(1);
    expect(parseImapMessageId("naver-imap:me@naver.com:4294967295", PREFIX, EMAIL)).toBe(
      4_294_967_295,
    );
  });

  it.each([
    ["empty string", ""],
    ["prefix only", "naver-imap:"],
    ["missing uid", "naver-imap:me@naver.com:"],
    ["non-numeric uid", "naver-imap:me@naver.com:abc"],
    ["uid zero (UIDs start at 1)", "naver-imap:me@naver.com:0"],
    ["negative uid", "naver-imap:me@naver.com:-5"],
    ["explicit plus sign", "naver-imap:me@naver.com:+5"],
    ["decimal uid", "naver-imap:me@naver.com:1.5"],
    ["exponent uid", "naver-imap:me@naver.com:1e3"],
    ["hex uid", "naver-imap:me@naver.com:0x10"],
    ["leading zeros (not canonical)", "naver-imap:me@naver.com:007"],
    ["uid above 2^32-1", "naver-imap:me@naver.com:4294967296"],
    ["absurdly long uid", `naver-imap:me@naver.com:${"9".repeat(40)}`],
    ["trailing space", "naver-imap:me@naver.com:101 "],
    ["trailing newline", "naver-imap:me@naver.com:101\n"],
    ["leading space", " naver-imap:me@naver.com:101"],
    ["extra segment", "naver-imap:me@naver.com:101:102"],
    ["IMAP range injection", "naver-imap:me@naver.com:1:*"],
    ["comma list injection", "naver-imap:me@naver.com:1,2"],
    ["star wildcard", "naver-imap:me@naver.com:*"],
    ["another provider's prefix", "icloud-imap:me@naver.com:101"],
    ["another mailbox's email", "naver-imap:other@naver.com:101"],
    ["email differing only by case", "naver-imap:ME@naver.com:101"],
    ["email with a suffix", "naver-imap:me@naver.com.evil.io:101"],
    ["a Gmail message id", "18c2f0a1b2c3d4e5"],
    ["a database row id", "cm8x0y1z20000abcd"],
    ["fullwidth digits", "naver-imap:me@naver.com:１０１"],
  ])("refuses %s", (_label, id) => {
    expect(parseImapMessageId(id, PREFIX, EMAIL)).toBeNull();
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 101],
    ["an object", { toString: () => "naver-imap:me@naver.com:101" }],
    ["an array", ["naver-imap:me@naver.com:101"]],
  ])("refuses a non-string (%s)", (_label, value) => {
    expect(parseImapMessageId(value, PREFIX, EMAIL)).toBeNull();
  });

  it("binds the id to the mailbox it was asked about, not to whatever the id claims", () => {
    const id = formatImapMessageId(PREFIX, "a@naver.com", 5);
    expect(parseImapMessageId(id, PREFIX, "a@naver.com")).toBe(5);
    expect(parseImapMessageId(id, PREFIX, "b@naver.com")).toBeNull();
  });
});
