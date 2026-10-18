/**
 * Plain-text projection of an HTML email body.
 *
 * Why: extractBody only fills `body` from text/plain MIME parts, so HTML-only
 * mail persisted body=null and was permanently invisible to the summarizer
 * (`body: { not: null }`) — the "Klorn has not analyzed this email yet" dead
 * end. This helper turns htmlBody into safe plain text at persist/read time.
 *
 * Sanitization is done by sanitize-html (parser-based, not regex) — the
 * newline pre-pass below only inserts breaks and never acts as the sanitizer.
 * Anchor text is replaced with the href itself (http/https/mailto only):
 * verification links usually live in the href, not the visible text.
 */

import sanitizeHtml from "sanitize-html";

const SAFE_HREF = /^(https?:|mailto:)/i;
const SAFE_DATA_IMAGE = /^data:image\/(png|gif|jpe?g|webp|bmp|avif);/i;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/ /g, " ");
}

// Sanitizing is synchronous, event-loop-blocking work with no natural bound —
// a multi-MB spam HTML must not stall the server on every read. 500KB keeps
// every legitimate email intact.
const MAX_HTML_INPUT = 500_000;
// sanitize-html's parser (htmlparser2) keeps open tags with Array#unshift, so
// its cost grows with the square of the nesting depth: "<b>" x 166k, under
// MAX_HTML_INPUT, took 8.3 s (2026-10-16). Bounding the tag count bounds the
// depth: 20k cost up to ~260 ms per render, 10k a quarter of that.
// Production's most tag-heavy stored body had 5,780 '<' (p99.9 4,156).
export const MAX_SANITIZE_TAGS = 10_000;

/**
 * The part of `html` sanitize-html may see: at most MAX_HTML_INPUT characters,
 * cut right before the tag past MAX_SANITIZE_TAGS. Linear (indexOf only).
 * Exported for the test.
 */
export function boundSanitizeInput(html: string): string {
  const capped = html.length > MAX_HTML_INPUT ? html.slice(0, MAX_HTML_INPUT) : html;
  let at = -1;
  for (let tags = 0; tags < MAX_SANITIZE_TAGS; tags++) {
    at = capped.indexOf("<", at + 1);
    if (at === -1) return capped;
  }
  const next = capped.indexOf("<", at + 1);
  return next === -1 ? capped : capped.slice(0, next);
}

export function htmlToPlainText(html: string): string {
  if (!html || !html.trim()) return "";

  // Insert line breaks after block-level closes and <br> so paragraphs don't
  // collapse into one blob. Tags themselves are stripped by sanitize-html.
  const withBreaks = boundSanitizeInput(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, "$&\n");

  const text = sanitizeHtml(withBreaks, {
    allowedTags: [],
    allowedAttributes: {},
    // Surface the link TARGET: replace anchor children with the href so
    // "click here" becomes the actual verification URL. Unsafe schemes drop.
    transformTags: {
      a: (_tag, attribs) => ({
        tagName: "a",
        attribs: {},
        text:
          attribs.href && SAFE_HREF.test(attribs.href.trim()) ? ` ${attribs.href.trim()} ` : " ",
      }),
    },
  });

  return trimBlanksBeforeNewlines(decodeEntities(text))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isBlank(code: number): boolean {
  return code === 0x20 || code === 0x09;
}

/**
 * Drop the spaces and tabs that end each line — what `/[ \t]+\n/g` did, in one
 * pass. The regex backtracked quadratically over a long run of blanks with no
 * newline after it: 128k spaces in one HTML-only email took 10.3 s on the event
 * loop (2026-10-16). Exported for the differential test.
 */
export function trimBlanksBeforeNewlines(text: string): string {
  let out = "";
  let lineStart = 0;
  for (let nl = text.indexOf("\n"); nl !== -1; nl = text.indexOf("\n", lineStart)) {
    let end = nl;
    while (end > lineStart && isBlank(text.charCodeAt(end - 1))) end--;
    out += `${text.slice(lineStart, end)}\n`;
    lineStart = nl + 1;
  }
  return out + text.slice(lineStart);
}

/**
 * Some senders ship a text/plain MIME part that actually contains raw HTML
 * source (observed 2026-08-13: Paddle's "Verify your identity" mail — Gmail
 * renders its html part, our reader trusted the plain part and displayed
 * tag soup). When the plain body is markup, the html part is the authority.
 *
 * The threshold is deliberately high: prose that merely mentions a couple of
 * tags (e.g. a dev explaining `<div>` usage) must pass through untouched.
 * Only bodies with a real density of block/table/style markup are coerced.
 */
const MIN_MARKUP_TOKENS = 5;
// Tag-name prefixes that count, as in the regex this replaced:
// <\/?(?:table|tbody|tr|td|div|p|span|h[1-6]|img|br|a\s)[^>]*>|style="  (/gi)
const MARKUP_TAG_PREFIXES = ["table", "tbody", "tr", "td", "div", "p", "span", "img", "br"];
const STYLE_ATTR = 'style="';
const WHITESPACE = /\s/;

function lowerAscii(code: number): number {
  return code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
}

/**
 * ASCII-case-insensitive "does `word` start at `at`". ASCII-only is exact: the
 * regex had /i without /u, and non-unicode /i never folds a non-ASCII character
 * to ASCII (`/s/i` does not match "ſ", `/k/i` does not match Kelvin "K").
 */
function startsWithAt(text: string, at: number, word: string): boolean {
  if (at + word.length > text.length) return false;
  for (let k = 0; k < word.length; k++) {
    if (lowerAscii(text.charCodeAt(at + k)) !== word.charCodeAt(k)) return false;
  }
  return true;
}

/** Index just past a counted tag name starting at `at`, or -1. */
function markupNameEnd(text: string, at: number): number {
  for (const prefix of MARKUP_TAG_PREFIXES) {
    if (startsWithAt(text, at, prefix)) return at + prefix.length;
  }
  if (lowerAscii(text.charCodeAt(at)) === 0x68) {
    const digit = text.charCodeAt(at + 1);
    if (digit >= 0x31 && digit <= 0x36) return at + 2; // h1..h6
  }
  if (lowerAscii(text.charCodeAt(at)) === 0x61 && WHITESPACE.test(text.charAt(at + 1))) {
    return at + 2; // "a" + whitespace
  }
  return -1;
}

/**
 * Count raw-HTML markup tokens, up to `limit`, with exactly the regex's
 * leftmost, non-overlapping semantics but in linear time. The regex's
 * `[^>]*>` rescanned to the end of the text from every `<tag` with no `>`
 * after it: "<div" × 32k (128 KB) took 1.9 s, and this runs on the plain body
 * of every persisted email, which has no size cap (2026-10-16). Here the first
 * `>` at or after a position is cached and only ever searched forward. Once no
 * `>` is left (-1) it stays so: `i` only moves forward and no tag name contains
 * `<` or `>`, so a later name never ends before the one that found none.
 * Exported for the differential test.
 */
export function countMarkupTokens(text: string, limit: number): number {
  let count = 0;
  let nextGt = -2; // -2: not looked up yet; -1: no '>' after the last lookup
  let i = 0;
  while (i < text.length && count < limit) {
    if (text.charCodeAt(i) === 0x3c) {
      const nameAt = text.charCodeAt(i + 1) === 0x2f ? i + 2 : i + 1;
      const nameEnd = markupNameEnd(text, nameAt);
      if (nameEnd !== -1) {
        if (nextGt === -2 || (nextGt !== -1 && nextGt < nameEnd)) {
          nextGt = text.indexOf(">", nameEnd);
        }
        if (nextGt !== -1) {
          count++;
          i = nextGt + 1;
          continue;
        }
      }
    } else if (startsWithAt(text, i, STYLE_ATTR)) {
      count++;
      i += STYLE_ATTR.length;
      continue;
    }
    i++;
  }
  return count;
}

function looksLikeRawHtml(text: string): boolean {
  return countMarkupTokens(text, MIN_MARKUP_TOKENS) >= MIN_MARKUP_TOKENS;
}

/**
 * Return the body to store/serve as plain text: the plain part when it is
 * genuinely plain, otherwise the projection of the html part (or of the
 * body itself when no html part exists).
 */
export function coercePlainBody(body: string | null, htmlBody: string | null): string | null {
  if (!body || !looksLikeRawHtml(body)) return body;
  return htmlToPlainText(htmlBody || body);
}

/**
 * Sanitized HTML for RENDERING mail as the sender designed it (the plain
 * projection above stays the source for summaries/snippets). Allowlist is
 * the layout vocabulary real email uses — tables, inline styles, images —
 * with everything executable removed: no scripts, no event handlers, no
 * iframes/forms, http(s)/mailto links only, images over http(s)/data.
 * Clients render this in a JS-disabled webview; this sanitizer is the
 * second wall, not the only one.
 */
// Declarations that move content out of the flow: with them a sender can pin a
// fake UI over the reader (position:fixed) or stack over it (z-index).
const POSITIONING_PROPERTIES = new Set(["position", "z-index"]);
// A property name as real mail writes it: an identifier, or a custom property.
// Anything else (CSS escapes such as \70 osition, comments such as
// position/**/) could spell a blocked property without the word, so it goes.
const PLAIN_CSS_PROPERTY = /^(?:-?[a-z][a-z0-9-]*|--[a-z0-9-]+)$/;

/**
 * A style attribute without its positioning declarations; every other
 * declaration is kept as written. One split on ";": a fragment with no colon
 * (the "base64,…)" tail of a data URL) is kept as it is. Linear. Exported for
 * the test.
 */
export function stripPositioningStyles(style: string): string {
  return style
    .split(";")
    .filter((declaration) => {
      const colon = declaration.indexOf(":");
      if (colon === -1) return true;
      const property = declaration.slice(0, colon).trim().toLowerCase();
      return PLAIN_CSS_PROPERTY.test(property) && !POSITIONING_PROPERTIES.has(property);
    })
    .join(";");
}

export function renderableEmailHtml(html: string | null | undefined): string | null {
  if (!html || !html.trim()) return null;
  const out = sanitizeHtml(boundSanitizeInput(html), {
    allowedTags: [
      "a",
      "b",
      "i",
      "u",
      "s",
      "em",
      "strong",
      "small",
      "big",
      "span",
      "font",
      "p",
      "div",
      "br",
      "hr",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "ul",
      "ol",
      "li",
      "dl",
      "dt",
      "dd",
      "blockquote",
      "pre",
      "code",
      "table",
      "thead",
      "tbody",
      "tfoot",
      "tr",
      "td",
      "th",
      "caption",
      "img",
      "center",
      "sub",
      "sup",
      "figure",
      "figcaption",
    ],
    allowedAttributes: {
      "*": ["style", "align", "valign", "width", "height", "dir"],
      a: ["href", "title", "style"],
      img: ["src", "alt", "title", "width", "height", "style"],
      table: [
        "style",
        "width",
        "height",
        "align",
        "cellpadding",
        "cellspacing",
        "border",
        "bgcolor",
      ],
      td: ["style", "width", "height", "align", "valign", "colspan", "rowspan", "bgcolor"],
      th: ["style", "width", "height", "align", "valign", "colspan", "rowspan", "bgcolor"],
      font: ["color", "size", "face"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["http", "https", "data", "cid"] },
    allowProtocolRelative: false,
    // cid: srcs survive (resolved by the client's scheme handler against
    // GET /api/email/:id/inline/:cid since 2026-08-15); a genuinely src-less
    // <img> shell is still dropped so the pane never shows a bare broken icon.
    exclusiveFilter: (frame) => frame.tag === "img" && !(frame.attribs.src || "").trim(),
    // data: survives the scheme allowlist whatever its media type. Only
    // raster images are kept: svg+xml is a document format and text/html
    // never belongs in an <img>. Dropping src lets the filter above remove
    // the shell.
    transformTags: {
      // Runs after the tag-specific transform, on every tag.
      "*": (tagName, attribs) =>
        attribs.style
          ? { tagName, attribs: { ...attribs, style: stripPositioningStyles(attribs.style) } }
          : { tagName, attribs },
      img: (tagName, attribs) => {
        const src = (attribs.src || "").trim();
        if (/^data:/i.test(src) && !SAFE_DATA_IMAGE.test(src)) {
          const { src: _dropped, ...rest } = attribs;
          return { tagName, attribs: rest };
        }
        return { tagName, attribs };
      },
    },
  });
  return out.trim() ? out : null;
}

/**
 * The render source for a stored row: the html part when present, else the
 * plain part when it is actually raw HTML (the Paddle case coercePlainBody
 * heals for text). Genuinely-plain mail returns null — clients keep showing
 * the plain body.
 */
export function renderableEmailHtmlFor(
  body: string | null,
  htmlBody: string | null,
): string | null {
  if (htmlBody?.trim()) return renderableEmailHtml(htmlBody);
  if (body && looksLikeRawHtml(body)) return renderableEmailHtml(body);
  return null;
}
