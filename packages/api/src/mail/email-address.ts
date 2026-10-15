/**
 * Leaf helpers for email-address header parsing. Lives outside email-sync.ts
 * so modules email-sync itself imports (e.g. judge-context.ts) can use them
 * without creating an import cycle.
 */

/**
 * The mailbox of a From-style header value like `Name <foo@bar.com>`, case kept,
 * or "" when the value does not name exactly one.
 *
 * The display name is the sender's to write, and RFC 5322 lets a quoted-string or
 * a comment hold `<...>`: `"<victim@target.com>" <attacker@evil.co>` is a valid
 * header whose mailbox is attacker@evil.co. Reading the first `<...>` made the
 * reply paths, a rule's auto-reply among them, answer victim@target.com. So:
 *   - quoted-strings and comments are skipped (a quoted local part, `"a"@x`, kept);
 *   - more than one angle-addr, or one left open, is refused: which of two the
 *     sender meant is theirs to choose, so neither is taken;
 *   - an unterminated quoted-string or comment, or a backslash outside one, is
 *     refused, wherever it sits;
 *   - with no angle-addr the text outside quotes and comments is the address.
 * One pass, each character appended to one buffer at most: linear time.
 */
export function parseAddress(value: string): string {
  let outside = "";
  let angle = "";
  let mailbox: string | null = null;
  let angles = 0;
  let inAngle = false;
  let quoted = false;
  let quotedText = "";
  let commentDepth = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (commentDepth > 0) {
      if (ch === "\\") i++;
      else if (ch === "(") commentDepth++;
      else if (ch === ")") commentDepth--;
      continue;
    }
    if (quoted) {
      if (ch === "\\") {
        quotedText += ch + (value[i + 1] ?? "");
        i++;
      } else if (ch === '"') {
        quoted = false;
        const kept = `"${quotedText}"`;
        if (inAngle) angle += kept;
        else outside += value[i + 1] === "@" ? kept : " ";
        quotedText = "";
      } else quotedText += ch;
      continue;
    }
    if (ch === "\\") return "";
    if (ch === '"') quoted = true;
    else if (inAngle && ch === ">") {
      inAngle = false;
      mailbox = angle;
    } else if (inAngle && ch === "<") return "";
    else if (inAngle) angle += ch;
    else if (ch === "(") {
      commentDepth = 1;
      outside += " ";
    } else if (ch === "<") {
      angles++;
      if (angles > 1) return "";
      inAngle = true;
    } else outside += ch;
  }
  if (quoted || commentDepth > 0 || inAngle) return "";
  return (mailbox ?? outside).trim();
}

/** Characters that would change how parseAddress reads a display name left unquoted. */
const DISPLAY_NAME_SPECIALS = /["\\()<>]/;

/**
 * A From value for a name and an address a provider gave separately (IMAP's
 * envelope, Graph's emailAddress). The name is quoted, its `"` and `\` escaped,
 * only when it holds a character that would otherwise change the parse, so the
 * value names that one address whatever the sender put in their name.
 */
export function formatMailbox(name: string, address: string): string {
  const n = name.trim();
  const a = address.trim();
  if (!n || !a) return a || n;
  const shown = DISPLAY_NAME_SPECIALS.test(n) ? `"${n.replace(/["\\]/g, "\\$&")}"` : n;
  return `${shown} <${a}>`;
}

/** The mailbox of a header value, lowercased (see parseAddress). */
export function extractEmailAddress(value: string): string {
  return parseAddress(value).toLowerCase();
}
