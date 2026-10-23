/**
 * RFC 2047 encoded-words in address headers (mail/encoded-words.ts): the Klorn
 * mailbox reads From/To/Cc from Resend's raw header values, where a display name
 * is often encoded. Linear, never throws, an unknown charset left as it came.
 */

import { describe, expect, it, vi } from "vitest";
import { decodeEncodedWords, MAX_DECODED_WORDS } from "../mail/encoded-words.js";

const b64 = (text: string, encoding: BufferEncoding = "utf8") =>
  Buffer.from(text, encoding).toString("base64");

describe("decodeEncodedWords", () => {
  it("leaves a header without encoded-words untouched", () => {
    expect(decodeEncodedWords("Jane <jane@example.com>")).toBe("Jane <jane@example.com>");
    expect(decodeEncodedWords("")).toBe("");
  });

  it("decodes B (base64) words in UTF-8, any case", () => {
    expect(decodeEncodedWords(`=?UTF-8?B?${b64("김철수")}?= <kim@example.com>`)).toBe(
      "김철수 <kim@example.com>",
    );
    expect(decodeEncodedWords(`=?utf-8?b?${b64("Zoë")}?=`)).toBe("Zoë");
  });

  it("decodes Q words: underscores are spaces, =XX are bytes", () => {
    expect(decodeEncodedWords("=?UTF-8?Q?Jane_D=C3=B6e?= <jane@example.com>")).toBe(
      "Jane Döe <jane@example.com>",
    );
    expect(decodeEncodedWords("=?ISO-8859-1?Q?Andr=E9?=")).toBe("André");
  });

  it("decodes the Korean and Japanese legacy charsets", () => {
    expect(decodeEncodedWords("=?EUC-KR?B?x9Gx2w==?=")).toBe("한글");
    expect(decodeEncodedWords("=?ks_c_5601-1987?B?x9Gx2w==?=")).toBe("한글");
    // ISO-2022-JP "日本" (ESC $ B F| K\ ESC ( B).
    expect(decodeEncodedWords("=?ISO-2022-JP?B?GyRCRnxLXBsoQg==?=")).toBe("日本");
  });

  it("joins adjacent encoded-words, dropping only the whitespace between them", () => {
    const first = b64("김");
    const second = b64("철수");
    expect(decodeEncodedWords(`=?UTF-8?B?${first}?=  \r\n =?UTF-8?B?${second}?= <k@x.com>`)).toBe(
      "김철수 <k@x.com>",
    );
    expect(decodeEncodedWords(`=?UTF-8?B?${first}?= and =?UTF-8?B?${second}?=`)).toBe(
      "김 and 철수",
    );
  });

  it("drops an RFC 2231 language suffix from the charset", () => {
    expect(decodeEncodedWords(`=?UTF-8*ko?B?${b64("한")}?=`)).toBe("한");
  });

  it("leaves a word with an unknown charset or a broken encoding as it came", () => {
    expect(decodeEncodedWords("=?x-klingon?B?SGk=?=")).toBe("=?x-klingon?B?SGk=?=");
    expect(decodeEncodedWords("=?UTF-8?B?not*base64?=")).toBe("=?UTF-8?B?not*base64?=");
    expect(decodeEncodedWords("=?UTF-8?X?abc?=")).toBe("=?UTF-8?X?abc?=");
  });

  it("decodes only allowlisted charsets, aliases included", () => {
    expect(decodeEncodedWords(`=?utf8?B?${b64("é")}?=`)).toBe("é");
    expect(decodeEncodedWords("=?latin1?Q?Andr=E9?=")).toBe("André");
    expect(decodeEncodedWords("=?cp949?B?x9Gx2w==?=")).toBe("한글");
    expect(decodeEncodedWords("=?koi8-r?B?8NLJ18XU?=")).toBe("Привет");
    // Known to TextDecoder but not allowlisted: left as it came.
    expect(decodeEncodedWords("=?utf-16le?B?SABpAA==?=")).toBe("=?utf-16le?B?SABpAA==?=");
    expect(decodeEncodedWords("=?z?B??=")).toBe("=?z?B??=");
  });

  it(`decodes at most ${MAX_DECODED_WORDS} words per header and leaves the rest raw`, () => {
    const word = `=?UTF-8?B?${b64("가")}?=`;
    const header = Array.from({ length: MAX_DECODED_WORDS + 3 }, () => word).join(" x ");
    const decoded = decodeEncodedWords(header);
    expect(decoded.split("가")).toHaveLength(MAX_DECODED_WORDS + 1);
    expect(decoded.endsWith(word)).toBe(true);
  });

  it("constructs no decoder for an unknown charset, and one per known charset", () => {
    // Counted structurally (a wall clock flakes on a loaded runner): before the
    // allowlist and the cache, each word constructed (or failed to construct) one.
    const Real = globalThis.TextDecoder;
    let constructed = 0;
    vi.stubGlobal(
      "TextDecoder",
      class extends Real {
        constructor(...args: ConstructorParameters<typeof TextDecoder>) {
          super(...args);
          constructed += 1;
        }
      },
    );
    try {
      const unknown = Array.from({ length: 2_000 }, () => "=?z?B??=").join(" ");
      expect(decodeEncodedWords(unknown)).toBe(unknown);
      expect(constructed).toBe(0);

      // A charset no other test here uses, so its decoder is not cached yet.
      const known = Array.from({ length: 2_000 }, () => "=?windows-1251?B?7/Do4uXy?=").join(" ");
      decodeEncodedWords(known);
      decodeEncodedWords(known);
      expect(constructed).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stays well within a generous time backstop on thousands of words", () => {
    const unknown = Array.from({ length: 2_000 }, () => "=?z?B??=").join(" ");
    const known = Array.from({ length: 2_000 }, () => `=?UTF-8?B?${b64("가")}?=`).join(" ");
    const started = performance.now();
    for (let i = 0; i < 20; i++) {
      decodeEncodedWords(unknown);
      decodeEncodedWords(known);
    }
    // ~120 ms per header before the allowlist and the cache: 40 headers took ~5 s.
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it("is linear on hostile input (a generous backstop)", () => {
    const hostile = `${"=?".repeat(50_000)}${"?=".repeat(50_000)}`;
    const started = performance.now();
    decodeEncodedWords(hostile);
    decodeEncodedWords(`=?UTF-8?Q?${"=".repeat(100_000)}?=`);
    expect(performance.now() - started).toBeLessThan(1_500);
  });
});
