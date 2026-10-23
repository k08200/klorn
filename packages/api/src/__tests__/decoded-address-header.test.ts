/**
 * Address headers of the Klorn mailbox with their encoded-words decoded
 * (mail/decoded-address-header.ts, step E1b of docs/providers/unified-platform-plan.md).
 *
 * The raw header is parsed first, quote- and comment-aware, and only the display
 * name is decoded: decoding the whole value first let an encoded comment or name
 * supply a second, fake mailbox that the parser then read as the sender
 * (security re-verification N1).
 */

import { describe, expect, it } from "vitest";
import { decodedAddressList, decodedMailbox } from "../mail/decoded-address-header.js";
import { extractEmailAddress, splitAddressList } from "../mail/email-address.js";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe("decodedMailbox", () => {
  it("keeps the real mailbox when an encoded comment spells another (a Klorn address)", () => {
    const raw =
      "=?utf-8?Q?=22?= <attacker@evil.com> (=?utf-8?Q?=22_=3Cjane=40klorn.ai=3E_=22=22?=)";
    const stored = decodedMailbox(raw);
    expect(extractEmailAddress(stored)).toBe("attacker@evil.com");
    expect(stored).not.toContain("jane@klorn.ai");
  });

  it("keeps the real mailbox when an encoded comment spells a trusted sender", () => {
    const raw =
      "=?utf-8?Q?=22?= <attacker@evil.com> (=?utf-8?Q?=22_=3Cno-reply=40accounts.google.com=3E_=22=22?=)";
    expect(extractEmailAddress(decodedMailbox(raw))).toBe("attacker@evil.com");
  });

  it("keeps the real mailbox when the encoded display name itself spells an angle-addr", () => {
    const raw = "=?utf-8?Q?Jane_=3Cjane=40klorn.ai=3E?= <attacker@evil.com>";
    const stored = decodedMailbox(raw);
    expect(extractEmailAddress(stored)).toBe("attacker@evil.com");
    expect(stored).toBe('"Jane <jane@klorn.ai>" <attacker@evil.com>');
  });

  it("decodes an ordinary display name and keeps the address", () => {
    expect(decodedMailbox(`=?UTF-8?B?${b64("김철수")}?= <Kim@Example.com>`)).toBe(
      "김철수 <Kim@Example.com>",
    );
    expect(decodedMailbox(`"=?UTF-8?B?${b64("김철수")}?=" <kim@example.com>`)).toBe(
      "김철수 <kim@example.com>",
    );
  });

  it("strips control characters after decoding", () => {
    expect(decodedMailbox("=?utf-8?Q?Ja=0D=0Ane=00?= <jane@example.com>")).toBe(
      "Ja ne <jane@example.com>",
    );
    expect(decodedMailbox("Plain\r\n Name <p@example.com>")).toBe("Plain Name <p@example.com>");
  });

  it("leaves a header without a display name or an encoded name as it came", () => {
    expect(decodedMailbox("<a@example.com> (=?utf-8?Q?x?=)")).toBe(
      "<a@example.com> (=?utf-8?Q?x?=)",
    );
    expect(decodedMailbox("a@example.com")).toBe("a@example.com");
    expect(decodedMailbox("Sam <sam@example.com>")).toBe("Sam <sam@example.com>");
  });

  it("leaves an ambiguous header (two angle-addrs) undecoded", () => {
    const raw = "=?utf-8?Q?x?= <a@example.com> <b@example.com>";
    expect(decodedMailbox(raw)).toBe(raw);
    expect(extractEmailAddress(decodedMailbox(raw))).toBe("");
  });
});

describe("splitAddressList", () => {
  it("splits on commas outside quotes, comments and angle-addrs", () => {
    expect(
      splitAddressList('"Doe, Jane" <j@x.com>, (a, comment) b@y.com ,<"q,1"@z.com>, , c@w.com'),
    ).toEqual(['"Doe, Jane" <j@x.com>', "(a, comment) b@y.com", '<"q,1"@z.com>', "c@w.com"]);
  });

  it("keeps an unterminated quote's tail as one part", () => {
    expect(splitAddressList('a@x.com, "open, quote <b@y.com>')).toEqual([
      "a@x.com",
      '"open, quote <b@y.com>',
    ]);
  });
});

describe("decodedAddressList", () => {
  it("decodes each display name and keeps every address", () => {
    const raw = `=?UTF-8?B?${b64("한글")}?= <a@x.com>, "Doe, Jane" <j@x.com>, b@y.com`;
    expect(decodedAddressList(raw)).toBe('한글 <a@x.com>, "Doe, Jane" <j@x.com>, b@y.com');
  });

  it("cannot be made to add an address through an encoded name", () => {
    const raw = "=?utf-8?Q?x=2C_victim=40klorn.ai?= <a@x.com>";
    const list = splitAddressList(decodedAddressList(raw)).map(extractEmailAddress);
    expect(list).toEqual(["a@x.com"]);
  });
});
