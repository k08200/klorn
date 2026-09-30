/**
 * The one-bare-address parser (step A4 of docs/providers/unified-platform-plan.md).
 * The address comes from mail the sender wrote, so every case here is hostile
 * input until it is parsed into ONE bare address or refused. Pure functions, no
 * mocks. Invisible characters are built with `String.fromCodePoint`, never typed
 * into this file.
 */

import { describe, expect, it } from "vitest";
import { MAX_ADDRESS_HEADER_LENGTH, parseSingleAddress } from "../mail/single-address.js";

const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const LS = cp(0x2028);
const PS = cp(0x2029);
const NEL = cp(0x85);

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
    ["a comment in the display name", "Jane Doe (Acme) <jane@acme.com>", "jane@acme.com"],
    ["a comment before the display name", "(Acme) Jane Doe <jane@acme.com>", "jane@acme.com"],
    ["a comment holding a comma", "Jane Doe (Acme, Inc.) <jane@acme.com>", "jane@acme.com"],
    ["two separate comments", "Jane (Acme) (EU) <jane@acme.com>", "jane@acme.com"],
    ["a comment next to a quoted name", '"Jane Doe" (Acme) <jane@acme.com>', "jane@acme.com"],
    [
      "a comment that mentions another address (the comment is dropped, only the angle group counts)",
      "Jane (old: jane@old.example, cc: boss@x.com) <jane@new.example>",
      "jane@new.example",
    ],
    ["blanks after the angle group", "Alice <alice@example.com> \t", "alice@example.com"],
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
    ["a comment beside a bare address (no angle group)", "alice@example.com (Alice)"],
    ["a comment after the angle group", "Alice <alice@example.com> (work)"],
    ["a comment inside the angle group", "Alice <alice@example.com(work)>"],
    ["an unclosed comment", "Jane (Acme <jane@acme.com>"],
    ["a stray closing parenthesis", "Jane Acme) <jane@acme.com>"],
    ["a nested comment", "Jane (Acme (EU)) <jane@acme.com>"],
    ["an angle bracket hidden in a comment", "(<evil@x.com>) <legit@z.com>"],
    ["a quote opened inside a comment", '(Acme "x) <jane@acme.com>'],
    ["an escape inside a comment", "Jane (Acme\\) <jane@acme.com>"],
    ["a comment only", "(Acme)"],
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
    ["a unicode line separator", `alice@example.com${LS}`],
    ["a unicode paragraph separator", `alice@example.com${PS}`],
    ["a next-line character", `alice@example.com${NEL}`],
    ["a line break inside a display name", "Alice\r\nKim <alice@example.com>"],
    ["a header over the length bound", `${"x".repeat(MAX_ADDRESS_HEADER_LENGTH)}@example.com`],
  ];
  for (const [label, input] of refused) {
    it(`refuses ${label}`, () => {
      expect(parseSingleAddress(input)).toBeNull();
    });
  }

  it("applies the length bound structurally: a valid address just inside it passes, one character over is refused", () => {
    const name = "n".repeat(MAX_ADDRESS_HEADER_LENGTH - "<a@example.com>".length);
    const atBound = `${name}<a@example.com>`;
    expect(atBound).toHaveLength(MAX_ADDRESS_HEADER_LENGTH);
    expect(parseSingleAddress(atBound)).toBe("a@example.com");
    expect(parseSingleAddress(`n${atBound}`)).toBeNull();
  });

  it("refuses an over-bound header whatever it holds, including a valid address and adversarial quoting", () => {
    expect(
      parseSingleAddress(`${"x".repeat(MAX_ADDRESS_HEADER_LENGTH)} <a@example.com>`),
    ).toBeNull();
    expect(parseSingleAddress(`${'"'.repeat(500_000)}${"<".repeat(500_000)}`)).toBeNull();
  });

  it("refuses the longest allowed header made only of quotes, escapes and brackets", () => {
    expect(parseSingleAddress('"\\'.repeat(MAX_ADDRESS_HEADER_LENGTH / 2))).toBeNull();
    expect(parseSingleAddress("<".repeat(MAX_ADDRESS_HEADER_LENGTH))).toBeNull();
    expect(parseSingleAddress("(".repeat(MAX_ADDRESS_HEADER_LENGTH))).toBeNull();
  });
});
