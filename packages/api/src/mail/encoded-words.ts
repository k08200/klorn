/**
 * RFC 2047 encoded-words (`=?charset?B|Q?text?=`) in a header value, decoded.
 * The Klorn mailbox decodes the display names of From/To/Cc with this (step E1b
 * of docs/providers/unified-platform-plan.md); decoded-address-header.ts decides
 * which part of a header is a display name.
 *
 * - Linear: one global regex whose parts exclude `?` and whitespace (no
 *   backtracking between them), and a single pass over the matches.
 * - Bounded: only allowlisted charsets (CHARSET_LABELS), one cached TextDecoder
 *   per label, and at most MAX_DECODED_WORDS words per header, the rest left raw.
 *   A sender cannot make each word construct, or fail to construct, a decoder.
 * - A charset outside the list, a broken base64 or an encoding other than B or
 *   Q leaves that word as it came.
 * - Whitespace between two adjacent decoded words is dropped (RFC 2047 §6.2).
 * - Never throws. Control characters, NUL and length are the caller's.
 */

const ENCODED_WORD = /=\?([^?\s]{1,64})\?([BbQq])\?([^?\s]*)\?=/g;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const HEX_BYTE = /^[0-9A-Fa-f]{2}$/;
const SPACE = 0x20;
const WHITESPACE_ONLY = /^\s*$/;

export const MAX_DECODED_WORDS = 50;

const ISO_8859 = Array.from({ length: 15 }, (_, i) => `iso-8859-${i + 1}`).filter(
  (label) => label !== "iso-8859-12", // never assigned
);
const WINDOWS_125X = Array.from({ length: 9 }, (_, i) => `windows-${1250 + i}`);

/** Lowercased charset label (an RFC 2231 `*lang` suffix removed) → its TextDecoder label. */
const CHARSET_LABELS: ReadonlyMap<string, string> = new Map([
  ...["utf-8", "utf8"].map((label) => [label, "utf-8"] as const),
  ...["us-ascii", "ascii"].map((label) => [label, "us-ascii"] as const),
  ...ISO_8859.map((label) => [label, label] as const),
  ["latin1", "iso-8859-1"],
  ...WINDOWS_125X.map((label) => [label, label] as const),
  ...WINDOWS_125X.map((label) => [`cp${label.slice(-4)}`, label] as const),
  ...["euc-kr", "ks_c_5601-1987", "cp949", "x-windows-949"].map(
    (label) => [label, "euc-kr"] as const,
  ),
  ["iso-2022-jp", "iso-2022-jp"],
  ...["shift_jis", "shift-jis", "sjis", "x-sjis", "windows-31j", "cp932"].map(
    (label) => [label, "shift_jis"] as const,
  ),
  ["euc-jp", "euc-jp"],
  ["gb2312", "gb2312"],
  ...["gbk", "cp936"].map((label) => [label, "gbk"] as const),
  ["gb18030", "gb18030"],
  ...["big5", "big5-hkscs"].map((label) => [label, "big5"] as const),
  ["koi8-r", "koi8-r"],
]);

/** One decoder per label, made on first use; null when this runtime lacks the charset. */
const decoders = new Map<string, TextDecoder | null>();

function decoderFor(charset: string): TextDecoder | null {
  const label = CHARSET_LABELS.get(charset.split("*")[0].toLowerCase());
  if (!label) return null;
  if (!decoders.has(label)) {
    try {
      decoders.set(label, new TextDecoder(label));
    } catch {
      decoders.set(label, null);
    }
  }
  return decoders.get(label) ?? null;
}

function qBytes(text: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const hex = text.slice(i + 1, i + 3);
    if (char === "_") bytes.push(SPACE);
    else if (char === "=" && HEX_BYTE.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else bytes.push(char.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes);
}

function decodeWord(charset: string, encoding: string, text: string): string | null {
  const decoder = decoderFor(charset);
  if (!decoder) return null;
  const isBase64 = encoding === "B" || encoding === "b";
  if (isBase64 && !BASE64.test(text)) return null;
  return decoder.decode(isBase64 ? Buffer.from(text, "base64") : qBytes(text));
}

export function decodeEncodedWords(header: string): string {
  if (!header.includes("=?")) return header;
  let out = "";
  let last = 0;
  let decodedWords = 0;
  let previousDecoded = false;
  for (const match of header.matchAll(ENCODED_WORD)) {
    if (decodedWords >= MAX_DECODED_WORDS) break;
    const start = match.index;
    const gap = header.slice(last, start);
    const decoded = decodeWord(match[1], match[2], match[3]);
    if (decoded === null) {
      out += gap + match[0];
    } else {
      out += (previousDecoded && WHITESPACE_ONLY.test(gap) ? "" : gap) + decoded;
      decodedWords += 1;
    }
    previousDecoded = decoded !== null;
    last = start + match[0].length;
  }
  return out + header.slice(last);
}
