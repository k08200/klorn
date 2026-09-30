/**
 * Step B3: the MIME builder and the recipient guard are shared by the Gmail
 * path (base64url `raw` for the Gmail API) and the IMAP path (bytes for SMTP and
 * for an IMAP APPEND). They live in `mail/outbound-message.ts`.
 *
 * Pinned here:
 *   - without the standalone headers the output is byte-for-byte what
 *     `mail/gmail.ts` produced before B3 (plain and multipart branch), so
 *     moving the builder changed nothing for Gmail;
 *   - a standalone message (SMTP / APPEND) additionally carries From, Date and
 *     Message-ID in a fixed order, and a base64 body (no 8BITMIME needed);
 *   - reply headers go through `reply-headers.ts` on both flavours;
 *   - the recipient guard answers exactly as Gmail's `sendEmail` did, and
 *     `toSmtpAddress` refuses anything that is not a plain, bounded addr-spec.
 */

import { describe, expect, it } from "vitest";

import {
  buildPlainTextMime,
  buildPlainTextRawEmail,
  checkSendRecipient,
  extractAddress,
  isNoReplyAddress,
  looksLikeEmailAddress,
  newMessageId,
  toSmtpAddress,
} from "../mail/outbound-message.js";

const CRLF = "\r\n";
const SUBJECT = "Re: Q3 plan";
const SUBJECT_B64 = Buffer.from(SUBJECT).toString("base64");
const DATE = new Date("2026-09-30T10:00:00.000Z");
const ORIGINAL = "<orig-1@mail.example.com>";

const decodeRaw = (raw: string) => Buffer.from(raw, "base64url").toString("utf-8");

describe("buildPlainTextRawEmail — Gmail output is unchanged", () => {
  it("plain branch: byte-identical to the pre-B3 builder", () => {
    const expected = [
      "To: bob@example.com",
      `Subject: =?UTF-8?B?${SUBJECT_B64}?=`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      "Sounds good.",
    ].join(CRLF);
    expect(decodeRaw(buildPlainTextRawEmail("bob@example.com", SUBJECT, "Sounds good."))).toBe(
      expected,
    );
  });

  it("multipart branch: byte-identical for a pinned boundary", () => {
    const realNow = Date.now;
    const realRandom = Math.random;
    Date.now = () => 0;
    Math.random = () => 0.5;
    try {
      const boundary = `klorn_0_${(0.5).toString(36).slice(2)}`;
      const content = Buffer.from("hello");
      const expected = [
        "To: bob@example.com",
        `Subject: =?UTF-8?B?${SUBJECT_B64}?=`,
        "MIME-Version: 1.0",
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        "Body",
        `--${boundary}`,
        'Content-Type: text/plain; name="a.txt"',
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="a.txt"; filename*=UTF-8''a.txt`,
        "",
        content.toString("base64"),
        `--${boundary}--`,
        "",
      ].join(CRLF);
      const raw = buildPlainTextRawEmail("bob@example.com", SUBJECT, "Body", [
        { filename: "a.txt", mimeType: "text/plain", content },
      ]);
      expect(decodeRaw(raw)).toBe(expected);
    } finally {
      Date.now = realNow;
      Math.random = realRandom;
    }
  });

  it("returns the same bytes as buildPlainTextMime, base64url-encoded", () => {
    const mime = buildPlainTextMime("bob@example.com", SUBJECT, "Sounds good.", [], {
      inReplyTo: ORIGINAL,
    });
    const raw = buildPlainTextRawEmail("bob@example.com", SUBJECT, "Sounds good.", [], {
      inReplyTo: ORIGINAL,
    });
    expect(decodeRaw(raw)).toBe(mime);
  });
});

describe("buildPlainTextMime — standalone message (SMTP / APPEND)", () => {
  const standalone = {
    from: "me@naver.com",
    messageId: "<0b7e3c1a-1111-4222-8333-444455556666@naver.com>",
    date: DATE,
  };

  it("emits From, To, Subject, Date, Message-ID in that order, then MIME headers", () => {
    const mime = buildPlainTextMime("bob@example.com", SUBJECT, "Sounds good.", [], undefined, {
      ...standalone,
    });
    const [head] = mime.split(`${CRLF}${CRLF}`);
    expect(head.split(CRLF)).toEqual([
      "From: me@naver.com",
      "To: bob@example.com",
      `Subject: =?UTF-8?B?${SUBJECT_B64}?=`,
      "Date: Wed, 30 Sep 2026 10:00:00 +0000",
      `Message-ID: ${standalone.messageId}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
    ]);
  });

  it("encodes the body as base64 with CRLF line breaks, so the bytes are 7-bit clean", () => {
    const body = "안녕하세요\n두 번째 줄 \u{1F600}";
    const mime = buildPlainTextMime("bob@example.com", SUBJECT, body, [], undefined, standalone);
    const encoded = mime.split(`${CRLF}${CRLF}`)[1];
    expect(Buffer.from(encoded.replace(/\r\n/g, ""), "base64").toString("utf-8")).toBe(
      "안녕하세요\r\n두 번째 줄 \u{1F600}",
    );
    expect(Array.from(mime).every((ch) => ch.charCodeAt(0) < 0x80)).toBe(true);
    for (const line of mime.split(CRLF)) expect(line.length).toBeLessThanOrEqual(998);
  });

  it("folds the base64 body at 76 characters per line", () => {
    const mime = buildPlainTextMime("b@example.com", SUBJECT, "x".repeat(500), [], undefined, {
      ...standalone,
    });
    const bodyLines = mime.split(`${CRLF}${CRLF}`)[1].split(CRLF);
    expect(bodyLines.length).toBeGreaterThan(1);
    for (const line of bodyLines) expect(line.length).toBeLessThanOrEqual(76);
  });

  it("puts In-Reply-To and References (parsed ids only) after Message-ID", () => {
    const mime = buildPlainTextMime(
      "bob@example.com",
      SUBJECT,
      "hi",
      [],
      { inReplyTo: `junk ${ORIGINAL}`, references: "<root@x.example> <mid@x.example>" },
      standalone,
    );
    const head = mime.split(`${CRLF}${CRLF}`)[0].split(CRLF);
    const at = head.indexOf(`Message-ID: ${standalone.messageId}`);
    expect(head.slice(at + 1, at + 3)).toEqual([
      `In-Reply-To: ${ORIGINAL}`,
      "References: <root@x.example> <mid@x.example>",
    ]);
  });

  it("keeps a multipart message standalone: headers first, base64 text part, attachment", () => {
    const mime = buildPlainTextMime(
      "bob@example.com",
      SUBJECT,
      "Body",
      [{ filename: "a.txt", mimeType: "text/plain", content: Buffer.from("hello") }],
      undefined,
      standalone,
    );
    expect(mime.startsWith(`From: me@naver.com${CRLF}To: bob@example.com${CRLF}`)).toBe(true);
    expect(mime).toContain("Date: Wed, 30 Sep 2026 10:00:00 +0000");
    expect(mime).toContain(`Message-ID: ${standalone.messageId}`);
    expect(mime).toContain("Content-Type: multipart/mixed; boundary=");
    expect(mime).toContain(`Content-Transfer-Encoding: base64${CRLF}${CRLF}Qm9keQ==`);
    expect(mime).toContain(Buffer.from("hello").toString("base64"));
  });

  it("never lets CR or LF from a field start a new header line", () => {
    const mime = buildPlainTextMime(
      "bob@example.com\r\nBcc: evil@example.com",
      "Hi\r\nBcc: evil@example.com",
      "body",
      [],
      undefined,
      { ...standalone, from: "me@naver.com\r\nBcc: evil@example.com" },
    );
    const headerLines = mime.split(`${CRLF}${CRLF}`)[0].split(CRLF);
    expect(headerLines.some((line) => line.startsWith("Bcc:"))).toBe(false);
  });
});

describe("newMessageId", () => {
  it("is a valid <unique@domain> id on the sender's domain", () => {
    const id = newMessageId("me@naver.com");
    expect(id).toMatch(/^<[0-9a-f-]{36}@naver\.com>$/);
    expect(newMessageId("me@naver.com")).not.toBe(id);
  });

  it("falls back to a fixed local domain when the address has no usable domain", () => {
    expect(newMessageId("not-an-address")).toMatch(/^<[0-9a-f-]{36}@klorn\.local>$/);
    expect(newMessageId("me@ex ample<>.com")).toMatch(/^<[0-9a-f-]{36}@example\.com>$/);
  });
});

describe("checkSendRecipient — the Gmail sendEmail guard, shared", () => {
  it.each([
    [
      "a@x.com, b@y.com",
      "Send to one recipient at a time (no commas or semicolons in the address).",
    ],
    [
      "a@x.com; b@y.com",
      "Send to one recipient at a time (no commas or semicolons in the address).",
    ],
    [
      "accounts.google.com",
      'Invalid email address: "accounts.google.com". Use a full address like local@domain, not a domain such as accounts.google.com.',
    ],
    [
      "noreply@example.com",
      "This address (noreply@example.com) is a no-reply system sender, so Klorn will not send a reply.",
    ],
  ])("refuses %s with the Gmail wording", (to, message) => {
    expect(checkSendRecipient(to)).toBe(message);
  });

  it("accepts a plain address and a display-name form", () => {
    expect(checkSendRecipient("bob@example.com")).toBeNull();
    expect(checkSendRecipient("Bob <bob@example.com>")).toBeNull();
  });

  it("exposes the primitives the Gmail module re-exports", () => {
    expect(extractAddress(" Bob <bob@example.com> ")).toBe("bob@example.com");
    expect(looksLikeEmailAddress("bob@example.com")).toBe(true);
    expect(looksLikeEmailAddress("bob")).toBe(false);
    expect(isNoReplyAddress("do-not-reply@example.com")).toBe(true);
    expect(isNoReplyAddress("bob@example.com")).toBe(false);
  });
});

describe("toSmtpAddress — only a plain, bounded addr-spec reaches an SMTP command", () => {
  it.each([
    ["bob@example.com", "bob@example.com"],
    ["Bob Builder <bob.b+tag@mail.example.co.kr>", "bob.b+tag@mail.example.co.kr"],
    ["  bob@example.com  ", "bob@example.com"],
  ])("accepts %s", (input, expected) => {
    expect(toSmtpAddress(input)).toBe(expected);
  });

  it.each([
    "bob@example.com>",
    "bob@example.com(comment)evil.com",
    "Name <bob@example.com(x)evil.com>",
    "bob@exa mple.com",
    "bob\r\n@example.com",
    "bob@example.com\r\nRCPT TO:<evil@example.com>",
    '"bob smith"@example.com',
    "bob@@example.com",
    "@example.com",
    "bob@",
    "bob@localhost",
    "bob@-example.com",
    "bob@example..com",
    ".bob@example.com",
    "bob.@example.com",
    "bob..b@example.com",
    "bob@[127.0.0.1]",
    "bob@127.0.0.1",
    "bób@example.com",
    "bob@exämple.com",
    `${"a".repeat(65)}@example.com`,
    `bob@${"a".repeat(64)}.com`,
    `bob@${"a.".repeat(130)}com`,
    "",
  ])("refuses %j", (input) => {
    expect(toSmtpAddress(input)).toBeNull();
  });
});
