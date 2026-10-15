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
 *   - with no angle-addr the text outside quotes and comments is the address;
 *   - an unterminated quoted-string or comment, or a backslash outside one
 *     (`Sarah :( <s@x.com>`, `CORP\\jsmith <j@x.com>`), leaves the structure
 *     unreadable: the value's one `<...>` is the mailbox only when it holds the
 *     whole value's only angle brackets and a plain address, so nothing the
 *     sender wrote around it can be read as another mailbox; otherwise "".
 * Linear time: one pass, each character appended to one buffer at most.
 */
export function parseAddress(value: string): string {
  const scanned = scanMailbox(value);
  return scanned ?? soleAngleAddress(value);
}

/** The value's only `<...>` when it is a plain address and no other angle bracket exists. */
function soleAngleAddress(value: string): string {
  const open = value.indexOf("<");
  const close = value.indexOf(">");
  if (open < 0 || close < open) return "";
  if (value.indexOf("<", open + 1) >= 0 || value.indexOf(">", close + 1) >= 0) return "";
  const inner = value.slice(open + 1, close).trim();
  return isPlainAddress(inner) ? inner : "";
}

/**
 * The structured read: the mailbox, "" when it is ambiguous (two angle-addrs, a
 * nested or unclosed one), or null when a quote, comment or backslash is unbalanced.
 */
function scanMailbox(value: string): string | null {
  const outside: string[] = [];
  let runStart = 0;
  let mailbox: string | null = null;
  let angles = 0;
  let angleStart = -1;
  let quoteStart = -1;
  let commentDepth = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (commentDepth > 0) {
      if (ch === "\\") i++;
      else if (ch === "(") commentDepth++;
      else if (ch === ")" && --commentDepth === 0) runStart = i + 1;
      continue;
    }
    if (quoteStart >= 0) {
      if (ch === "\\") i++;
      else if (ch === '"') {
        // In the angle-addr a quoted local part is in the raw slice taken at ">";
        // outside it only a quoted local part (followed by "@") is kept.
        if (angleStart < 0) {
          outside.push(value[i + 1] === "@" ? value.slice(quoteStart, i + 1) : " ");
          runStart = i + 1;
        }
        quoteStart = -1;
      }
      continue;
    }
    if (ch === "\\") return null;
    if (angleStart >= 0) {
      if (ch === '"') quoteStart = i;
      else if (ch === "<") return "";
      else if (ch === ">") {
        mailbox = value.slice(angleStart, i);
        angleStart = -1;
        runStart = i + 1;
      }
      continue;
    }
    if (ch !== '"' && ch !== "(" && ch !== "<") continue;
    outside.push(value.slice(runStart, i));
    if (ch === '"') quoteStart = i;
    else if (ch === "(") {
      commentDepth = 1;
      outside.push(" ");
    } else if (++angles > 1) return "";
    else angleStart = i + 1;
  }
  if (angleStart >= 0) return "";
  if (quoteStart >= 0 || commentDepth > 0) return null;
  if (mailbox !== null) return mailbox.trim();
  outside.push(value.slice(runStart));
  return outside.join("").trim();
}

/** Characters that would change how parseAddress reads a display name left unquoted. */
const DISPLAY_NAME_SPECIALS = /["\\()<>]/;
/** An address safe inside `<...>`: one "@", nothing that ends, splits or quotes a mailbox. */
const PLAIN_ADDRESS = /^[^\s<>"\\(),;:@\p{Cc}]+@[^\s<>"\\(),;:@\p{Cc}]+$/u;

/**
 * A From value for a name and an address a provider gave separately (IMAP's
 * envelope, Graph's emailAddress). The name is quoted, its `"` and `\` escaped,
 * only when it holds a character that would otherwise change the parse, so the
 * value names that one address whatever the sender put in their name. An address
 * that is not plain (`victim@t.com>x@evil.co`, two "@", a space, a comma) is
 * returned bare: inside `<...>` it could close early and name another mailbox,
 * bare it fails every single-recipient check.
 */
export function formatMailbox(name: string, address: string): string {
  const n = name.trim();
  const a = address.trim();
  const shown = DISPLAY_NAME_SPECIALS.test(n) ? `"${n.replace(/["\\]/g, "\\$&")}"` : n;
  if (!a) return shown;
  if (!n || !PLAIN_ADDRESS.test(a)) return a;
  return `${shown} <${a}>`;
}

/** True for an address with one "@" and nothing that ends, splits or quotes a mailbox. */
export function isPlainAddress(address: string): boolean {
  return PLAIN_ADDRESS.test(address);
}

/**
 * The display name before a From value's angle-addr, outer quotes removed, or null.
 * For showing and grouping only: the address is parseAddress's to decide.
 */
export function displayNameOf(value: string): string | null {
  const open = value.lastIndexOf("<");
  if (open <= 0) return null;
  const name = value
    .slice(0, open)
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
  return name || null;
}

/** The mailbox of a header value, lowercased (see parseAddress). */
export function extractEmailAddress(value: string): string {
  return parseAddress(value).toLowerCase();
}
