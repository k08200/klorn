/**
 * Where an MCP agent's reply draft goes and what it is called (step A4 of
 * docs/providers/unified-platform-plan.md). Pure functions, no mocks: the address
 * comes from mail the sender wrote, so every case here is hostile input until it
 * is parsed into ONE bare address or refused.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_ADDRESS_HEADER_LENGTH,
  MAX_SUBJECT_LENGTH,
  parseSingleAddress,
  pickReplyAddress,
  replySubject,
} from "../mcp/reply-target.js";

describe("parseSingleAddress — one bare address or null", () => {
  const accepted: Array<[string, string, string]> = [
    ["a bare address", "alice@example.com", "alice@example.com"],
    ["surrounding whitespace", "  alice@example.com \t", "alice@example.com"],
    ["a display name", "Alice Kim <alice@example.com>", "alice@example.com"],
    ["an angle-only address", "<alice@example.com>", "alice@example.com"],
    ["a quoted display name with a comma", '"Doe, John" <john@example.com>', "john@example.com"],
    [
      "a quoted display name that contains another address",
      '"a@x.com, evil@y.com" <legit@z.com>',
      "legit@z.com",
    ],
    [
      "a quoted display name with an escaped quote",
      '"Al \\"A\\" Kim" <al@example.com>',
      "al@example.com",
    ],
    [
      "plus addressing and a multi-label domain",
      "alice+tag@mail.example.co.uk",
      "alice+tag@mail.example.co.uk",
    ],
    ["an apostrophe in the local part", "o'brien@example.com", "o'brien@example.com"],
    ["a punycode domain", "kim@xn--bcher-kva.example", "kim@xn--bcher-kva.example"],
    ["a dotted local part", "first.last@example.com", "first.last@example.com"],
  ];
  for (const [label, input, expected] of accepted) {
    it(`accepts ${label}`, () => {
      expect(parseSingleAddress(input)).toBe(expected);
    });
  }

  const refused: Array<[string, unknown]> = [
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["an object", { address: "a@b.co" }],
    ["an array", ["a@b.co"]],
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["two addresses with a comma", "a@x.com, b@y.com"],
    ["two addresses with a semicolon", "a@x.com; b@y.com"],
    ["the unquoted display-name trick", "a@x.com, evil@y.com <legit@z.com>"],
    ["an address group", "Undisclosed recipients:;"],
    ["two angle groups", "<a@x.com><b@y.com>"],
    ["an unclosed angle bracket", "Alice <alice@example.com"],
    ["text after the angle group", "Alice <alice@example.com> extra"],
    ["an unterminated quote", '"Alice <alice@example.com>'],
    ["a comment", "alice@example.com (Alice)"],
    ["no at sign", "alice.example.com"],
    ["two at signs", "a@b@example.com"],
    ["an empty local part", "@example.com"],
    ["an empty domain", "alice@"],
    ["a domain with no dot", "alice@localhost"],
    ["a trailing dot in the domain", "alice@example.com."],
    ["a leading dot in the local part", ".alice@example.com"],
    ["consecutive dots in the local part", "al..ice@example.com"],
    ["a space in the local part", "al ice@example.com"],
    ["a non-ASCII local part", "홍길동@example.com"],
    ["a non-ASCII domain", "alice@예시.com"],
    ["a domain label starting with a hyphen", "alice@-example.com"],
    ["a domain label ending with a hyphen", "alice@example-.com"],
    ["a domain label over 63 characters", `alice@${"a".repeat(64)}.com`],
    ["a local part over 64 characters", `${"a".repeat(65)}@example.com`],
    [
      "an address over 254 characters",
      `a@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.${"e".repeat(63)}.com`,
    ],
    ["an LF injection", "alice@example.com\nBcc: evil@y.com"],
    ["a CRLF injection", "alice@example.com\r\nBcc: evil@y.com"],
    ["a CR", "alice@example.com\r"],
    ["a NUL byte", "alice@example.com\u0000"],
    ["a DEL byte", "alice@example.com\u007f"],
    ["a unicode line separator", "alice@example.com "],
    ["a header over the length bound", `${"x".repeat(MAX_ADDRESS_HEADER_LENGTH)}@example.com`],
  ];
  for (const [label, input] of refused) {
    it(`refuses ${label}`, () => {
      expect(parseSingleAddress(input)).toBeNull();
    });
  }

  it("answers a 1 MB adversarial header immediately (bounded before any parsing)", () => {
    const hostile = `${'"'.repeat(500_000)}${"<".repeat(500_000)}`;
    const started = Date.now();
    expect(parseSingleAddress(hostile)).toBeNull();
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("stays fast on the longest allowed header full of quotes and brackets", () => {
    const hostile = '"\\'.repeat(MAX_ADDRESS_HEADER_LENGTH / 2);
    const started = Date.now();
    expect(parseSingleAddress(hostile)).toBeNull();
    expect(Date.now() - started).toBeLessThan(100);
  });
});

describe("pickReplyAddress — Reply-To when it is one valid address, else From", () => {
  const from = "Alice Kim <alice@example.com>";

  it("uses From when there is no Reply-To", () => {
    expect(pickReplyAddress({ from })).toBe("alice@example.com");
    expect(pickReplyAddress({ from, replyTo: undefined })).toBe("alice@example.com");
    expect(pickReplyAddress({ from, replyTo: null })).toBe("alice@example.com");
    expect(pickReplyAddress({ from, replyTo: "" })).toBe("alice@example.com");
  });

  it("prefers a single valid Reply-To, display name dropped", () => {
    expect(pickReplyAddress({ from, replyTo: "Help Desk <help@example.org>" })).toBe(
      "help@example.org",
    );
    expect(pickReplyAddress({ from, replyTo: "help@example.org" })).toBe("help@example.org");
  });

  it("falls back to From when Reply-To carries several addresses", () => {
    expect(pickReplyAddress({ from, replyTo: "a@x.com, b@y.com" })).toBe("alice@example.com");
    expect(pickReplyAddress({ from, replyTo: "a@x.com; b@y.com" })).toBe("alice@example.com");
    expect(pickReplyAddress({ from, replyTo: "a@x.com, evil@y.com <legit@z.com>" })).toBe(
      "alice@example.com",
    );
  });

  it("falls back to From when Reply-To is not a valid address", () => {
    for (const replyTo of ["not an address", "help@localhost", "help@", 7, {}, ["a@b.co"]]) {
      expect(pickReplyAddress({ from, replyTo }), JSON.stringify(replyTo)).toBe(
        "alice@example.com",
      );
    }
  });

  it("falls back to From when Reply-To tries to inject a header", () => {
    expect(pickReplyAddress({ from, replyTo: "help@example.org\r\nBcc: evil@y.com" })).toBe(
      "alice@example.com",
    );
  });

  it("uses a valid Reply-To when From itself is unusable", () => {
    expect(pickReplyAddress({ from: "undisclosed", replyTo: "help@example.org" })).toBe(
      "help@example.org",
    );
  });

  it("is null when neither header holds one valid address", () => {
    expect(pickReplyAddress({ from: "", replyTo: "nope" })).toBeNull();
    expect(pickReplyAddress({ from: "a@x.com, b@y.com" })).toBeNull();
  });
});

describe("replySubject — the derived subject of a reply", () => {
  it("prefixes Re: once", () => {
    expect(replySubject("Quarterly plan")).toBe("Re: Quarterly plan");
  });

  it("does not double an existing reply prefix, in any case or spacing", () => {
    for (const subject of [
      "Re: Quarterly plan",
      "RE: Quarterly plan",
      "re: quarterly plan",
      "Re:Quarterly plan",
      "  Re: Quarterly plan",
    ]) {
      expect(replySubject(subject), subject).toBe(subject.trim());
    }
    expect(replySubject("Re: Re: Quarterly plan")).toBe("Re: Re: Quarterly plan");
  });

  it("prefixes words that merely start with re, and other prefixes", () => {
    expect(replySubject("Research update")).toBe("Re: Research update");
    expect(replySubject("Re")).toBe("Re: Re");
    expect(replySubject("Fwd: Invoice")).toBe("Re: Fwd: Invoice");
  });

  it("is a bare Re: for an empty, blank or missing subject", () => {
    for (const subject of ["", "   ", null, undefined]) {
      expect(replySubject(subject)).toBe("Re:");
    }
  });

  it("flattens control characters so the derived subject is always one line", () => {
    expect(replySubject("Hello\r\nBcc: evil@y.com")).toBe("Re: Hello Bcc: evil@y.com");
    expect(replySubject("a\u0000b\tc d")).toBe("Re: a b c d");
  });

  it("is capped at the subject limit, prefix included", () => {
    expect(replySubject("x".repeat(5000))).toHaveLength(MAX_SUBJECT_LENGTH);
    expect(replySubject(`Re: ${"x".repeat(5000)}`)).toHaveLength(MAX_SUBJECT_LENGTH);
    expect(replySubject("x".repeat(MAX_SUBJECT_LENGTH - 4))).toHaveLength(MAX_SUBJECT_LENGTH);
  });

  it("never leaves half a surrogate pair when the cap falls inside an emoji", () => {
    const original = `${"x".repeat(MAX_SUBJECT_LENGTH - 5)}\u{1F4C5}`;
    expect(replySubject(original)).toBe(`Re: ${"x".repeat(MAX_SUBJECT_LENGTH - 5)}`);
  });

  it("keeps non-ASCII text intact", () => {
    expect(replySubject("회의 일정 확인 \u{1F4C5}")).toBe("Re: 회의 일정 확인 \u{1F4C5}");
  });
});
