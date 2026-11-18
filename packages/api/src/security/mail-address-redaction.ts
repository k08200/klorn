/**
 * Mail addresses out of free text bound for Sentry (sentry-scrub.ts).
 *
 * An address is personal data, and Sentry keeps it beyond the account: a wipe
 * or a deletion does not reach it. The log sites name accounts by row id or an
 * addressLogTag (address-log-tag.ts), but the console integration turns EVERY
 * console.* line into a breadcrumb, and a breadcrumb rides on the next error
 * event; one line anywhere that printed an address put it in Sentry. So the
 * Sentry hooks redact address-shaped text wherever it sits.
 *
 * A scanner anchored on the `@`, not a regex. This runs on every breadcrumb,
 * on the event loop, and the untrusted-text paths here have been DoS'd by a
 * regex before (#1466). A bounded regex is linear but tries every start
 * position, about 0.5s per MB of plain text; the common unbounded
 * `[…]+@[…]+\.[…]{2,}` is quadratic (7s at 80 KB). Here one pass carries the
 * start of the local part it is in (the run of local-part characters, or the
 * opening quote of a quoted one), so nothing left of an `@` is walked again,
 * and the domain scan to its right stops at RFC 5321's 253 characters.
 *
 * Loose on purpose: over-redaction costs readability only (`node@11.11.0`
 * reads as an address, and `?to=` before an address goes with it), while a
 * miss is a leak. The local part takes the RFC 5322 atext characters, so the
 * recipient inside a VERP or SRS bounce address (`bounce+kim=example.com@…`)
 * goes too; non-ASCII characters count (`홍길동@회사.한국`); and an `@` written
 * as `%40` (or `%2540`, a URL nested in a query) counts as an `@`. Except
 * `/ ? & #`: they structure the URLs most breadcrumb addresses sit in, and
 * taking them would erase the path and query before every address, for local
 * parts that almost never contain them (`first/last@…` keeps `first/`).
 *
 * A local part is taken whole whatever its length: RFC 5321 caps a valid one
 * at 64 characters, but cutting a longer run there left its head behind. A
 * quoted local part (`"kim lee"@…`) runs back to its opening quote on its line
 * — a folded line (a line break before a space or tab, RFC 5322) counts as the
 * same line — and its JSON-escaped form (`\"kim lee\"@…`) to the escaped
 * opening quote with its backslash. A closing quote with no opening one on its
 * line takes the line up to the `@`. Not recognised: a JSON-escaped quoted local part
 * that itself holds an escaped quote (`\"kim \\\"x\\\" lee\"@…` keeps
 * `\"kim \\\"x\\`). The marker carries nothing of the address.
 */

export const MAIL_ADDRESS_MARKER = "[ADDRESS]";

/** RFC 5321: a label is at most 63 octets, a domain 253. */
const LABEL_MAX = 63;
const DOMAIN_MAX = 253;
/** How many `%25` may wrap the `%40` of an encoded `@`: a URL nested in a URL's query. */
const MAX_PERCENT_NESTING = 3;

const AT = 0x40;
const PERCENT = 0x25;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const LINE_FEED = 0x0a;
const SPACE = 0x20;
const TAB = 0x09;
const DOT = 0x2e;
const HYPHEN = 0x2d;
const UNDERSCORE = 0x5f;
const FIRST_NON_ASCII = 0x80;

/** RFC 5322 atext symbols less `/ ? & #` (see the header), plus `.` and the `%` of an encoding. */
const LOCAL_SYMBOLS: ReadonlySet<number> = new Set(
  Array.from("!$%'*+-=^_`{|}~.", (char) => char.charCodeAt(0)),
);

function isAsciiAlphanumeric(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a)
  );
}

function isLocalChar(code: number): boolean {
  return isAsciiAlphanumeric(code) || code >= FIRST_NON_ASCII || LOCAL_SYMBOLS.has(code);
}

/** `_` is not valid in a hostname, but it is in DNS names, and a miss is a leak. */
function isLabelChar(code: number): boolean {
  return (
    isAsciiAlphanumeric(code) || code >= FIRST_NON_ASCII || code === HYPHEN || code === UNDERSCORE
  );
}

/** Length of the `@` starting at `index`: 1 for `@`, 3 for `%40`, 5 for `%2540`…; 0 for none. */
function separatorLength(text: string, index: number): number {
  const code = text.charCodeAt(index);
  if (code === AT) return 1;
  if (code !== PERCENT) return 0;
  let at = index + 1;
  for (let nesting = 0; nesting < MAX_PERCENT_NESTING && text.startsWith("25", at); nesting++) {
    at += 2;
  }
  return text.startsWith("40", at) ? at + 2 - index : 0;
}

/**
 * End (exclusive) of the domain starting at `start`: a label, a dot, then more
 * labels and dots. -1 when there is none, so `user@localhost` is left alone.
 */
function domainEnd(text: string, start: number): number {
  let end = start;
  while (end < text.length && end - start < LABEL_MAX && isLabelChar(text.charCodeAt(end))) end++;
  if (end === start || text.charCodeAt(end) !== DOT) return -1;
  const rest = end + 1;
  end = rest;
  while (end < text.length && end - start < DOMAIN_MAX) {
    const code = text.charCodeAt(end);
    if (!isLabelChar(code) && code !== DOT) break;
    end++;
  }
  return end === rest ? -1 : end;
}

/**
 * The last two `"` of each kind the pass has seen: bare, and escaped (`\"`, as
 * a JSON string writes one). A quoted local part closes with the quote right
 * before its `@` and opens with the quote of the same kind before that one.
 */
class QuoteMarks {
  private bareBefore = -1;
  private bareLast = -1;
  private escapedBefore = -1;
  private escapedLast = -1;

  see(text: string, index: number): void {
    if (text.charCodeAt(index - 1) === BACKSLASH) {
      this.escapedBefore = this.escapedLast;
      this.escapedLast = index;
    } else {
      this.bareBefore = this.bareLast;
      this.bareLast = index;
    }
  }

  /** Start of the quoted local part the quote at `closing` ends (an escaped one with its backslash); -1 for none. */
  openingFor(closing: number): number {
    if (closing === this.bareLast) return this.bareBefore;
    if (closing === this.escapedLast && this.escapedBefore !== -1) return this.escapedBefore - 1;
    return -1;
  }
}

/** A line break before a space or tab folds the line (RFC 5322): the next line continues it. */
function isFold(text: string, next: number): boolean {
  const code = text.charCodeAt(next);
  return code === SPACE || code === TAB;
}

/** Where the pass stands: what is copied, and where the local part it is in would start. */
interface ScanState {
  /** Everything before `copied` is already kept (or replaced by a marker). */
  copied: number;
  /** Start of the run of local-part characters that ends at the current index. */
  runStart: number;
  /** Start of the current line; a folded line (a break before a space or tab) continues it. */
  lineStart: number;
  quotes: QuoteMarks;
}

/** Start of the local part before the separator at `index`: its run, or its quoted string. */
function localPartStart(text: string, index: number, state: ScanState): number {
  const { copied, runStart, lineStart, quotes } = state;
  if (text.charCodeAt(index - 1) !== QUOTE) return Math.max(runStart, copied);
  const floor = Math.max(lineStart, copied);
  const opening = quotes.openingFor(index - 1);
  return opening >= floor ? opening : floor;
}

/**
 * Replace every address-shaped substring with MAIL_ADDRESS_MARKER.
 *
 * One pass. The local part before a separator starts where the pass already
 * knows it does (`localPartStart`), so no character is walked back over; a
 * domain scan stops at the next separator, which is not a domain character, or
 * ends in a match the pass then skips.
 */
export function redactMailAddresses(text: string): string {
  const kept: string[] = [];
  const state: ScanState = { copied: 0, runStart: 0, lineStart: 0, quotes: new QuoteMarks() };
  let index = 0;
  while (index < text.length) {
    const separator = separatorLength(text, index);
    if (separator > 0) {
      const start = localPartStart(text, index, state);
      const end = start < index ? domainEnd(text, index + separator) : -1;
      if (end !== -1) {
        kept.push(text.slice(state.copied, start), MAIL_ADDRESS_MARKER);
        state.copied = end;
        state.runStart = end;
        index = end;
        continue;
      }
    }
    const code = text.charCodeAt(index);
    if (code === QUOTE) state.quotes.see(text, index);
    if (code === LINE_FEED && !isFold(text, index + 1)) state.lineStart = index + 1;
    if (!isLocalChar(code)) state.runStart = index + 1;
    index++;
  }
  if (state.copied === 0) return text;
  kept.push(text.slice(state.copied));
  return kept.join("");
}
