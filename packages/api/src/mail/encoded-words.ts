/**
 * RFC 2047 encoded-words (`=?charset?B|Q?text?=`) in a header value, decoded.
 * The Klorn mailbox reads From/To/Cc from Resend's raw header values, where a
 * display name is often encoded (step E1b of docs/providers/unified-platform-plan.md).
 *
 * - Linear: one global regex whose parts exclude `?` and whitespace (no
 *   backtracking between them), and a single pass over the matches.
 * - TextDecoder does the charsets (Node has full ICU: euc-kr, ks_c_5601-1987,
 *   iso-2022-jp, shift_jis, …). A charset it does not know, a broken base64 or
 *   an encoding other than B or Q leaves that word as it came.
 * - Whitespace between two adjacent encoded-words is dropped (RFC 2047 §6.2).
 * - Never throws. NUL and length are the caller's (storedText).
 */

const ENCODED_WORD = /=\?([^?\s]{1,64})\?([BbQq])\?([^?\s]*)\?=/g;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const HEX_BYTE = /^[0-9A-Fa-f]{2}$/;
const SPACE = 0x20;
const WHITESPACE_ONLY = /^\s*$/;

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
  const label = charset.split("*")[0].toLowerCase();
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label);
  } catch {
    return null; // a charset TextDecoder does not know
  }
  const isBase64 = encoding === "B" || encoding === "b";
  if (isBase64 && !BASE64.test(text)) return null;
  return decoder.decode(isBase64 ? Buffer.from(text, "base64") : qBytes(text));
}

export function decodeEncodedWords(header: string): string {
  if (!header.includes("=?")) return header;
  let out = "";
  let last = 0;
  let previousDecoded = false;
  for (const match of header.matchAll(ENCODED_WORD)) {
    const start = match.index;
    const gap = header.slice(last, start);
    const decoded = decodeWord(match[1], match[2], match[3]);
    if (decoded === null) {
      out += gap + match[0];
    } else {
      out += (previousDecoded && WHITESPACE_ONLY.test(gap) ? "" : gap) + decoded;
    }
    previousDecoded = decoded !== null;
    last = start + match[0].length;
  }
  return out + header.slice(last);
}
