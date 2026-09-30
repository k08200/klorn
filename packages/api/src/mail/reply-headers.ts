/**
 * Reply threading headers (In-Reply-To, References) built from untrusted input.
 *
 * Values arrive from a provider fetch or, later, from callers we do not
 * control. Instead of sanitising free text, this module PARSES message ids and
 * discards everything else, so no separator, control character or header-like
 * text can reach a header. A message id is `<` + 1..255 printable ASCII
 * characters (0x21-0x7E) excluding `<` and `>` + `>`. That excludes
 * whitespace, NUL, DEL, CR, LF and every other C0 control, and it excludes
 * U+2028, U+2029 and U+0085 because they are not ASCII.
 *
 * One producer for every send and draft path: `buildPlainTextRawEmail` in
 * `gmail.ts` calls `replyHeaderLines`, and the reply route calls
 * `pickInReplyTo` so its `threaded` flag matches what was emitted.
 */

/** Longest allowed text between the angle brackets of one message id. */
export const MAX_MESSAGE_ID_LENGTH = 255;
/** References keeps the first id plus this many of the most recent ids. */
export const REFERENCES_TAIL_LIMIT = 20;
/** Folding target for a physical header line (RFC 5322 section 2.1.1 SHOULD). */
export const MAX_HEADER_LINE_LENGTH = 78;
/** Hard limit for a physical header line (RFC 5322 section 2.1.1 MUST). */
export const MAX_FOLDED_LINE_LENGTH = 998;

const FOLD = "\r\n";

// Printable ASCII 0x21-0x7E without `<` (0x3C) and `>` (0x3E).
const MESSAGE_ID_PATTERN = new RegExp(
  `<[\\x21-\\x3b\\x3d\\x3f-\\x7e]{1,${MAX_MESSAGE_ID_LENGTH}}>`,
  "g",
);

/** Every valid message id in `value`, in order. A non-string yields none. */
export function extractMessageIds(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value.match(MESSAGE_ID_PATTERN) ?? [];
}

/** The single id In-Reply-To carries: the last valid one, or undefined. */
export function pickInReplyTo(value: unknown): string | undefined {
  const found = extractMessageIds(value);
  return found[found.length - 1];
}

/** Deduplicated (first occurrence wins), then first id plus the last N. */
function limitReferences(ids: readonly string[]): string[] {
  const unique = [...new Set(ids)];
  if (unique.length <= REFERENCES_TAIL_LIMIT + 1) return unique;
  return [unique[0], ...unique.slice(-REFERENCES_TAIL_LIMIT)];
}

/**
 * One header, folded with CRLF plus a single space between tokens so a
 * physical line stays within MAX_HEADER_LINE_LENGTH wherever a token allows.
 * A token is never split, so a line holding one long token can exceed it; the
 * longest possible line is far below MAX_FOLDED_LINE_LENGTH.
 */
function foldHeader(name: string, tokens: readonly string[]): string {
  const lines = tokens.reduce<string[]>((acc, token, index) => {
    const last = acc[acc.length - 1];
    if (last !== undefined && last.length + 1 + token.length <= MAX_HEADER_LINE_LENGTH) {
      return [...acc.slice(0, -1), `${last} ${token}`];
    }
    return [...acc, index === 0 ? `${name}: ${token}` : ` ${token}`];
  }, []);
  return lines.join(FOLD);
}

function readField(reply: unknown, key: "inReplyTo" | "references"): unknown {
  if (typeof reply !== "object" || reply === null || Array.isArray(reply)) return undefined;
  return (reply as Record<string, unknown>)[key];
}

/**
 * Header lines for a reply, ready to join with CRLF. `reply` is deliberately
 * `unknown`: JSON arguments can carry any type, and a non-object, or a
 * non-string field, is treated as absent. A header with no valid id is omitted.
 */
export function replyHeaderLines(reply: unknown): string[] {
  const inReplyTo = pickInReplyTo(readField(reply, "inReplyTo"));
  const references = limitReferences(extractMessageIds(readField(reply, "references")));
  return [
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references.length > 0 ? [foldHeader("References", references)] : []),
  ];
}
