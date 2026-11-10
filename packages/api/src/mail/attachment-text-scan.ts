/**
 * Linear-time replacements for the regexes email-attachment-text.ts used to run
 * on attachment bytes at Gmail sync time. Attachment bytes are sender-controlled
 * and the extractor runs synchronously on the event loop, so a backtracking
 * pattern turned one crafted file into a whole-API stall (2026-10-14: an 80 KB
 * PDF took 5 s, a 4 KB hwpx section took 1.3 s, both growing at least
 * quadratically).
 *
 * Each function documents the regex it replaces and returns EXACTLY what that
 * regex returned, on every input; the differential tests in
 * attachment-text-scan.test.ts check this against the old patterns. Two facts
 * keep the scans linear:
 *   - a failed match never needs re-scanning: the positions the regex would
 *     retry fail for the same reason, so the scan jumps past them or stops;
 *   - name checks for every "<" inside one run of tag-name characters share a
 *     single forward pass over that run (the run caches below).
 */

const GT = 0x3e;
const SLASH = 0x2f;
const COLON = 0x3a;
const OPEN_PAREN = 0x28;
const CLOSE_PAREN = 0x29;
const BACKSLASH = 0x5c;
const LOWER_T = 0x74;
const UPPER_T = 0x54;
const ASCII_LIMIT = 0x80;
const REGEX_WHITESPACE = /\s/;

/** `\w` without the `u` flag: [A-Za-z0-9_]. */
function isAsciiWordCode(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f
  );
}

/** `\b` right after a word character: the next char is not `\w`, or there is none. */
function wordEndsAt(text: string, index: number): boolean {
  return index >= text.length || !isAsciiWordCode(text.charCodeAt(index));
}

/** `\s` exactly as the regex engine defines it. */
function isRegexWhitespace(code: number): boolean {
  if (code < ASCII_LIMIT) return code === 0x20 || (code >= 0x09 && code <= 0x0d);
  return REGEX_WHITESPACE.test(String.fromCharCode(code));
}

/** What `.` refuses to match without the `s` flag. */
function isLineTerminator(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;
}

function joinParts(text: string, parts: string[], last: number): string {
  if (parts.length === 0) return text;
  return parts.join("") + text.slice(last);
}

/**
 * `text.replace(/<[^>]+>/g, " ")`. An unterminated "<" (no ">" after it) is
 * left as is, like the regex did; so is "<>".
 */
export function stripTags(text: string): string {
  const parts: string[] = [];
  let last = 0;
  let from = 0;
  for (;;) {
    const start = text.indexOf("<", from);
    if (start < 0) break;
    const end = text.indexOf(">", start + 1);
    if (end < 0) break;
    from = end + 1;
    if (end === start + 1) continue;
    parts.push(text.slice(last, start), " ");
    last = end + 1;
  }
  return joinParts(text, parts, last);
}

/**
 * `xml.replace(new RegExp(`${prefix}\\b[^>]*\\/>`, "g"), replacement)` for a
 * literal prefix ending in a word character, e.g. "<w:tab" or "<w:br".
 */
export function replaceSelfClosingTag(xml: string, prefix: string, replacement: string): string {
  const parts: string[] = [];
  let last = 0;
  let from = 0;
  for (;;) {
    const start = xml.indexOf(prefix, from);
    if (start < 0) break;
    const afterName = start + prefix.length;
    if (!wordEndsAt(xml, afterName)) {
      from = start + 1;
      continue;
    }
    const end = xml.indexOf(">", afterName);
    if (end < 0) break;
    // Every later prefix before `end` reaches the same ">" and gets the same answer.
    if (xml.charCodeAt(end - 1) === SLASH) {
      parts.push(xml.slice(last, start), replacement);
      last = end + 1;
    }
    from = end + 1;
  }
  return joinParts(xml, parts, last);
}

/** Group 1 of every `/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g` match. */
export function collectWordTextRuns(xml: string): string[] {
  const runs: string[] = [];
  let from = 0;
  for (;;) {
    const start = xml.indexOf("<w:t", from);
    if (start < 0) break;
    if (!wordEndsAt(xml, start + 4)) {
      from = start + 1;
      continue;
    }
    const openEnd = xml.indexOf(">", start + 4);
    if (openEnd < 0) break;
    const close = xml.indexOf("</w:t>", openEnd + 1);
    // No closer after this tag means none after any later tag either: stop.
    if (close < 0) break;
    runs.push(xml.slice(openEnd + 1, close));
    from = close + 6;
  }
  return runs;
}

/**
 * Answers `[^:>\s]*:?t\b` (case-insensitive) at increasing positions. Every
 * position inside one run of `[^:>\s]` characters shares the run's end, so one
 * pass over the run answers them all.
 */
class TextRunNameScanner {
  private runStart = -1;
  private runEnd = -1;
  private lastT = -1;
  private colonT = false;

  constructor(private readonly xml: string) {}

  /** Positions must be queried in non-decreasing order. */
  endsInT(position: number): boolean {
    if (position < this.runStart || position > this.runEnd) this.scanRun(position);
    return this.lastT >= position || this.colonT;
  }

  private scanRun(position: number): void {
    const { xml } = this;
    let lastT = -1;
    let i = position;
    for (; i < xml.length; i++) {
      const code = xml.charCodeAt(i);
      if (code === COLON || code === GT || isRegexWhitespace(code)) break;
      if ((code === LOWER_T || code === UPPER_T) && wordEndsAt(xml, i + 1)) lastT = i;
    }
    const afterColon = xml.charCodeAt(i + 1);
    this.runStart = position;
    this.runEnd = i;
    this.lastT = lastT;
    this.colonT =
      xml.charCodeAt(i) === COLON &&
      (afterColon === LOWER_T || afterColon === UPPER_T) &&
      wordEndsAt(xml, i + 2);
  }
}

/**
 * Group 1 of every
 * `/<[^:>\s]*:?t\b[^>]*>([\s\S]*?)<\/[^:>\s]*:?t\b[^>]*>/gi` match: the text
 * runs of xlsx/pptx/hwpx XML (<t>, <a:t>, <hp:t>). Like the regex, any tag
 * name ending in "t" counts (<sst>, <worksheet>).
 */
export function collectTextRuns(xml: string): string[] {
  const runs: string[] = [];
  const names = new TextRunNameScanner(xml);
  let from = 0;
  for (;;) {
    const start = xml.indexOf("<", from);
    if (start < 0) break;
    if (!names.endsInT(start + 1)) {
      from = start + 1;
      continue;
    }
    const openEnd = xml.indexOf(">", start + 1);
    if (openEnd < 0) break;
    const close = findTextRunClose(xml, openEnd + 1, names);
    // No closer after this tag means none after any later tag either: stop.
    if (!close) break;
    runs.push(xml.slice(openEnd + 1, close.start));
    from = close.end + 1;
  }
  return runs;
}

function findTextRunClose(
  xml: string,
  from: number,
  names: TextRunNameScanner,
): { start: number; end: number } | null {
  for (let at = from; ; ) {
    const start = xml.indexOf("</", at);
    if (start < 0) return null;
    if (names.endsInT(start + 2)) {
      const end = xml.indexOf(">", start + 2);
      return end < 0 ? null : { start, end };
    }
    at = start + 1;
  }
}

/**
 * Answers `[^:>]*:?NAME\b` at increasing positions, with one pass per run of
 * `[^:>]` characters (see TextRunNameScanner).
 */
class NamespacedNameScanner {
  private runStart = -1;
  private runEnd = -1;
  private lastName = -1;
  private colonName = false;

  constructor(
    private readonly xml: string,
    private readonly name: string,
  ) {}

  /** Positions must be queried in non-decreasing order. */
  hasName(position: number): boolean {
    if (position < this.runStart || position > this.runEnd) this.scanRun(position);
    return this.lastName >= position || this.colonName;
  }

  private scanRun(position: number): void {
    const { xml, name } = this;
    let lastName = -1;
    let i = position;
    for (; i < xml.length; i++) {
      const code = xml.charCodeAt(i);
      if (code === COLON || code === GT) break;
      if (xml.startsWith(name, i) && wordEndsAt(xml, i + name.length)) lastName = i;
    }
    this.runStart = position;
    this.runEnd = i;
    this.lastName = lastName;
    this.colonName =
      xml.charCodeAt(i) === COLON &&
      xml.startsWith(name, i + 1) &&
      wordEndsAt(xml, i + 1 + name.length);
  }
}

/**
 * `xml.replace(new RegExp(`<[^:>]*:?${name}\\b[^>]*\\/>`, "g"), replacement)`
 * for a word-character name: hwpx self-closing tags such as <hp:tab .../>.
 */
export function replaceNamespacedSelfClosingTag(
  xml: string,
  name: string,
  replacement: string,
): string {
  const names = new NamespacedNameScanner(xml, name);
  const parts: string[] = [];
  let last = 0;
  let from = 0;
  let end = -1;
  for (;;) {
    const start = xml.indexOf("<", from);
    if (start < 0) break;
    // The first ">" after `start` is shared by every "<" before it.
    if (end <= start) end = xml.indexOf(">", start + 1);
    if (end < 0) break;
    if (xml.charCodeAt(end - 1) !== SLASH) {
      from = end + 1;
      continue;
    }
    if (!names.hasName(start + 1)) {
      from = start + 1;
      continue;
    }
    parts.push(xml.slice(last, start), replacement);
    last = end + 1;
    from = end + 1;
  }
  return joinParts(xml, parts, last);
}

/**
 * `xml.replace(new RegExp(`<\\/[^:>]*:?${name}>`, "g"), replacement)`: hwpx
 * closing tags such as </hp:p>.
 */
export function replaceNamespacedClosingTag(
  xml: string,
  name: string,
  replacement: string,
): string {
  const parts: string[] = [];
  let last = 0;
  let from = 0;
  let runStart = -1;
  let runEnd = -1;
  let nameBeforeGt = false;
  let colonMatchEnd = -1;
  for (;;) {
    const start = xml.indexOf("</", from);
    if (start < 0) break;
    const position = start + 2;
    if (position < runStart || position > runEnd) {
      // Every "</" inside one run of [^:>] shares the run's end.
      runStart = position;
      runEnd = scanToColonOrGt(xml, position);
      const nameStart = runEnd - name.length;
      nameBeforeGt =
        xml.charCodeAt(runEnd) === GT && nameStart >= 0 && xml.startsWith(name, nameStart);
      const colonEnd = runEnd + 1 + name.length;
      colonMatchEnd =
        xml.charCodeAt(runEnd) === COLON &&
        xml.startsWith(name, runEnd + 1) &&
        xml.charCodeAt(colonEnd) === GT
          ? colonEnd
          : -1;
    }
    const matchEnd = nameBeforeGt && runEnd - name.length >= position ? runEnd : colonMatchEnd;
    if (matchEnd < 0) {
      from = start + 1;
      continue;
    }
    parts.push(xml.slice(last, start), replacement);
    last = matchEnd + 1;
    from = matchEnd + 1;
  }
  return joinParts(xml, parts, last);
}

function scanToColonOrGt(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === COLON || code === GT) break;
    i++;
  }
  return i;
}

/**
 * Group 1 of every `/\(([^()\\]*(?:\\.[^()\\]*)*)\)/g` match: PDF literal
 * strings, escapes still encoded. Like the regex, nested parentheses are NOT
 * balanced: "(a(b)c)" yields "b". Balancing would let one stray "(" in a binary
 * stream swallow every later string in the file.
 */
export function collectPdfLiteralStrings(raw: string): string[] {
  const literals: string[] = [];
  let start = raw.indexOf("(");
  while (start >= 0) {
    const next = scanPdfLiteral(raw, start, literals);
    if (next < 0) break;
    start = raw.indexOf("(", next);
  }
  return literals;
}

/**
 * Scans one literal from the "(" at `start`, pushing its body when it closes.
 * Returns where to look for the next "(", or -1 when no later "(" can match.
 * Any "(" skipped inside the scan was escaped, and a regex attempt from there
 * reaches the same stopping point, so nothing is re-scanned.
 */
function scanPdfLiteral(raw: string, start: number, literals: string[]): number {
  for (let i = start + 1; i < raw.length; ) {
    const code = raw.charCodeAt(i);
    if (code === CLOSE_PAREN) {
      literals.push(raw.slice(start + 1, i));
      return i + 1;
    }
    if (code === OPEN_PAREN) return i;
    if (code !== BACKSLASH) {
      i++;
      continue;
    }
    if (i + 1 >= raw.length || isLineTerminator(raw.charCodeAt(i + 1))) return i + 1;
    i += 2;
  }
  // Unterminated up to the end: every later "(" is escaped and ends the same way.
  return -1;
}
