/**
 * PII scrub + leak-linter for the real eval set workflow (#648).
 *
 * Division of labor, per the eval/README.md doctrine:
 *  - The SCRUBBER runs locally over the founder's real labeled mail and
 *    mechanically replaces addresses / URLs / phone numbers with stable
 *    placeholders. Deterministic and sender-consistent: the same address
 *    always maps to the same placeholder within one run, so per-sender
 *    structure (the signal sender-priors key on) survives the scrub.
 *  - The FOUNDER still eyeballs every drafted row (names in prose, org
 *    names, anything the patterns can't see) — that step is deliberately
 *    manual and stays so.
 *  - The LINTER is the pre-commit tripwire: it refuses any document that
 *    still contains an address/URL/phone-shaped string, because in a public
 *    repo one missed address is an irreversible leak.
 *
 * Pure module — no I/O. scripts/draft-real-eval-set.ts owns files and the DB.
 */

export interface ScrubResult {
  text: string;
  /** "kind:original→replacement" entries for the founder's review pass. */
  notes: string[];
}

export interface ScrubContext {
  addressMap: Map<string, string>;
  domainMap: Map<string, string>;
  urlCount: { value: number };
  phoneCount: { value: number };
}

export function createScrubContext(): ScrubContext {
  return {
    addressMap: new Map(),
    domainMap: new Map(),
    urlCount: { value: 0 },
    phoneCount: { value: 0 },
  };
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;
// Phone-shaped: international prefix and/or separator-grouped digit runs.
// Two separated groups of 3+ digits (e.g. 555 0100, 010-1234-5678) qualify;
// bare short numbers (INV-2291) and ISO dates are excluded by the lookarounds
// below and by requiring at least 7 digits in total.
const PHONE_RE =
  /(?<![\dA-Za-z-])(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]){1,3}\d{3,4}(?![\dA-Za-z-])/g;

function digitCount(s: string): number {
  return (s.match(/\d/g) ?? []).length;
}

/** ISO dates (2026-07-25) must survive — they are structural signal. */
function looksLikeDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
}

function placeholderFor(address: string, ctx: ScrubContext): string {
  const lower = address.toLowerCase();
  const existing = ctx.addressMap.get(lower);
  if (existing) return existing;
  const domain = lower.split("@")[1] ?? "unknown";
  let domainToken = ctx.domainMap.get(domain);
  if (!domainToken) {
    domainToken = `domain-${ctx.domainMap.size + 1}`;
    ctx.domainMap.set(domain, domainToken);
  }
  const placeholder = `person-${ctx.addressMap.size + 1}@${domainToken}.example`;
  ctx.addressMap.set(lower, placeholder);
  return placeholder;
}

export function scrubText(input: string, ctx: ScrubContext): ScrubResult {
  const notes: string[] = [];
  let text = input.replace(EMAIL_RE, (match) => {
    const replacement = placeholderFor(match, ctx);
    notes.push(`email:${match}→${replacement}`);
    return replacement;
  });
  text = text.replace(URL_RE, (match) => {
    ctx.urlCount.value += 1;
    const replacement = `https://link-${ctx.urlCount.value}.example`;
    notes.push(`url:${match}→${replacement}`);
    return replacement;
  });
  text = text.replace(PHONE_RE, (match) => {
    if (looksLikeDate(match) || digitCount(match) < 7) return match;
    ctx.phoneCount.value += 1;
    const replacement = `000-0000-${ctx.phoneCount.value}`;
    notes.push(`phone:${match.trim()}→${replacement}`);
    return replacement;
  });
  return { text, notes };
}

export interface RealEvalSourceItem {
  id: string;
  gmailId: string;
  from: string;
  subject: string;
  snippet: string | null;
  body: string | null;
  labels: string[];
  receivedAt: string;
  label: string;
  note?: string;
}

export interface DraftEvalItem extends RealEvalSourceItem {
  /** The founder flips this to true after eyeballing the row. */
  reviewed: boolean;
  scrubNotes: string[];
}

export function scrubItem(item: RealEvalSourceItem, ctx: ScrubContext): DraftEvalItem {
  const notes: string[] = [];
  const run = (value: string | null): string | null => {
    if (value === null || value === "") return value;
    const r = scrubText(value, ctx);
    notes.push(...r.notes);
    return r.text;
  };
  return {
    ...item,
    from: run(item.from) ?? "",
    subject: run(item.subject) ?? "",
    snippet: run(item.snippet),
    body: run(item.body),
    reviewed: false,
    scrubNotes: notes,
  };
}

/** Placeholder shapes the linter must NOT flag. */
const PLACEHOLDER_EMAIL_RE = /^person-\d+@domain-\d+\.example$/;
const PLACEHOLDER_URL_RE = /^https:\/\/link-\d+\.example\/?$/;

/** Collect every string value in a parsed JSON structure. */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, out);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) collectStrings(entry, out);
  }
}

/**
 * Pre-commit leak tripwire: scan a JSON document for anything address/URL/
 * phone-shaped that is not one of our placeholders. Scans DECODED string
 * values when the document parses as JSON (raw-text scanning misreads "\n"
 * escapes as a letter glued to the next token); falls back to raw text
 * otherwise so a malformed file still gets linted. Empty result = safe to
 * commit.
 */
export function lintPii(documentText: string): string[] {
  let haystacks: string[];
  try {
    const parsed = JSON.parse(documentText) as unknown;
    haystacks = [];
    collectStrings(parsed, haystacks);
  } catch {
    haystacks = [documentText];
  }

  const findings: string[] = [];
  for (const text of haystacks) {
    for (const match of text.match(EMAIL_RE) ?? []) {
      if (!PLACEHOLDER_EMAIL_RE.test(match)) findings.push(`email-like: ${match}`);
    }
    for (const match of text.match(URL_RE) ?? []) {
      const cleaned = match.replace(/[",\\]+$/, "");
      if (!PLACEHOLDER_URL_RE.test(cleaned)) findings.push(`url-like: ${cleaned}`);
    }
    for (const match of text.match(PHONE_RE) ?? []) {
      if (looksLikeDate(match) || digitCount(match) < 7) continue;
      if (/^000-0000-\d+$/.test(match.trim())) continue;
      findings.push(`phone-like: ${match.trim()}`);
    }
  }
  return findings;
}
