/**
 * Making text that came from a remote server safe to put in a log line (step B4
 * review fix). An IMAP or TLS error message is whatever the other side chose to
 * send: with a CR or LF in it, one message becomes several log lines, and an
 * attacker-run server can forge lines that look like ours; with no cap it can
 * flood the log. Control characters become spaces and the length is capped.
 */

/** Long enough for any real error message, short enough that one cannot flood a log. */
export const MAX_LOG_TEXT_LENGTH = 240;

/** C0 and C1 controls, DEL, and the Unicode line and paragraph separators. */
function isLineBreaking(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

export function sanitizeLogText(value: unknown, max: number = MAX_LOG_TEXT_LENGTH): string {
  let text: string;
  try {
    text = value instanceof Error ? value.message : String(value);
  } catch {
    return "[unprintable]";
  }
  let out = "";
  for (const ch of text) {
    out += isLineBreaking(ch.codePointAt(0) ?? 0) ? " " : ch;
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}
