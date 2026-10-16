/**
 * Mail HTML → iframe srcdoc for the web reader.
 *
 * The input is the API's `renderHtml`, already sanitized server-side by
 * sanitize-html (packages/api/src/mail/email-text.ts). This module is the
 * second wall, and the browser is the third:
 *
 *   1. server allowlist (sanitize-html)        — the real sanitizer
 *   2. this rewrite (tag + attribute allowlist) — in case wall 1 ever drifts
 *   3. <iframe sandbox> with no allow-scripts / allow-same-origin, plus a CSP
 *      meta that refuses every network load except images once allowed
 *
 * Remote images are blocked by default (tracking pixels, CSS url() beacons):
 * their srcs are removed here AND the CSP refuses them, so either wall alone
 * holds. Pure string functions with no imports: tested from the api suite.
 */

export const MAIL_FRAME_MIN_HEIGHT = 240;
export const MAIL_FRAME_MAX_HEIGHT = 720;
/** Upper bound on cid: images resolved per message (each is an API call). */
export const MAX_INLINE_IMAGES = 10;

const LINE_HEIGHT_PX = 22;
const CHARS_PER_LINE = 80;
const ROW_PX = 8;
const DEFAULT_IMAGE_PX = 150;
const FRAME_PADDING_PX = 48;

export interface MailSrcdocOptions {
  allowRemoteImages: boolean;
  /** cid → data:image/… url, resolved by the caller through the authed API. */
  inlineImages?: Readonly<Record<string, string>>;
}

const SAFE_DATA_IMAGE = /^data:image\/(png|gif|jpe?g|webp|bmp|avif);/i;
/** What the frame could load once allowed (protocol-relative never resolves in srcdoc). */
const REMOTE_URL = /^https?:\/\//i;
const SAFE_HREF = /^(https?:|mailto:)/i;

/** Removed together with everything inside them. */
const DROP_WITH_CONTENT =
  /<(script|style|title|textarea|noscript|template|xmp|svg|math|iframe|object|noembed|noframes|select|button|applet)\b(?:"[^"]*"|'[^']*'|[^'">])*>[\s\S]*?<\/\1\s*>/gi;
const COMMENT_OR_DECL = /<!--[\s\S]*?-->|<![^>]*>|<\?[^>]*>/g;
/** A start or end tag; quoted values may contain '>'. Branches are disjoint. */
const TAG = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

const ALLOWED_TAGS = new Set(
  (
    "a b i u s em strong small big span font p div br hr h1 h2 h3 h4 h5 h6 ul ol li dl dt dd " +
    "blockquote pre code table thead tbody tfoot tr td th caption col colgroup img center sub sup " +
    "figure figcaption"
  ).split(" "),
);
const ALLOWED_ATTRS = new Set(
  (
    "style align valign width height dir title alt colspan rowspan cellpadding cellspacing border " +
    "bgcolor color size face href src"
  ).split(" "),
);
const VOID_TAGS = new Set(["br", "hr", "img", "col"]);

interface Attr {
  name: string;
  value: string;
}

const MAX_CODE_POINT = 0x10ffff;
const REPLACEMENT_CHAR = "\ufffd";

/** A numeric entity's character; out-of-range values become U+FFFD, never a throw. */
function codePointChar(code: number): string {
  return Number.isInteger(code) && code >= 0 && code <= MAX_CODE_POINT
    ? String.fromCodePoint(code)
    : REPLACEMENT_CHAR;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => codePointChar(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec: string) => codePointChar(Number.parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Scheme check on the browser's view of a url: whitespace and controls gone. */
function urlForCheck(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping controls is the point
  return value.replace(/[\u0000- \u007f]+/g, "");
}

function parseAttrs(raw: string): Attr[] {
  // The browser honours the first of duplicate attributes; so do we.
  const attrs = new Map<string, Attr>();
  for (const m of raw.matchAll(ATTR)) {
    const name = m[1].toLowerCase();
    if (attrs.has(name)) continue;
    const quoted = m[2] ?? "";
    const unquoted = /^["']/.test(quoted) ? quoted.slice(1, -1) : quoted;
    attrs.set(name, { name, value: decodeEntities(unquoted) });
  }
  return [...attrs.values()];
}

function cleanStyle(style: string, allowRemote: boolean): string {
  const noActive = style.replace(
    /expression\s*\(|javascript\s*:|vbscript\s*:|behavior\s*:|-moz-binding/gi,
    "",
  );
  return noActive.replace(/url\s*\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (whole, _q, inner: string) => {
    const url = urlForCheck(inner);
    if (SAFE_DATA_IMAGE.test(url)) return whole;
    if (allowRemote && /^https?:\/\//i.test(url)) return whole;
    return "none";
  });
}

function imageSrc(value: string, opts: MailSrcdocOptions): string | null {
  const url = urlForCheck(value);
  if (SAFE_DATA_IMAGE.test(url)) return url;
  if (/^cid:/i.test(url)) {
    const resolved = opts.inlineImages?.[value.trim().slice(4)];
    return resolved && SAFE_DATA_IMAGE.test(resolved) ? resolved : null;
  }
  if (opts.allowRemoteImages && /^https?:\/\//i.test(url)) return value.trim();
  return null;
}

function cleanAttr(tag: string, attr: Attr, opts: MailSrcdocOptions): Attr | null {
  if (!ALLOWED_ATTRS.has(attr.name)) return null;
  if (attr.name === "href") {
    return tag === "a" && SAFE_HREF.test(urlForCheck(attr.value)) ? attr : null;
  }
  if (attr.name === "src") {
    const src = tag === "img" ? imageSrc(attr.value, opts) : null;
    return src ? { name: "src", value: src } : null;
  }
  if (attr.name === "style") {
    return { name: "style", value: cleanStyle(attr.value, opts.allowRemoteImages) };
  }
  return attr;
}

function rewriteTag(
  closing: string,
  rawName: string,
  rawAttrs: string,
  opts: MailSrcdocOptions,
): string {
  const name = rawName.toLowerCase();
  if (!ALLOWED_TAGS.has(name)) return "";
  if (closing) return VOID_TAGS.has(name) ? "" : `</${name}>`;
  const kept = parseAttrs(rawAttrs)
    .map((a) => cleanAttr(name, a, opts))
    .filter((a): a is Attr => a !== null);
  const withRel = name === "a" ? [...kept, { name: "rel", value: "noopener noreferrer" }] : kept;
  const attrs = withRel.map((a) => ` ${a.name}="${escapeAttr(a.value)}"`).join("");
  return `<${name}${attrs}>`;
}

function dropActiveBlocks(html: string): string {
  let prev = html;
  for (;;) {
    const next = prev.replace(COMMENT_OR_DECL, "").replace(DROP_WITH_CONTENT, "");
    if (next === prev) return next;
    prev = next;
  }
}

/**
 * Tag + attribute allowlist rewrite. Unknown tags are dropped (their text
 * stays, inert); script-like blocks go with their content; every attribute
 * is re-quoted, so the output is well-formed for the checks downstream.
 */
export function neutralizeMailHtml(
  html: string,
  opts: MailSrcdocOptions = { allowRemoteImages: false },
): string {
  const source = dropActiveBlocks(html);
  const parts: string[] = [];
  let last = 0;
  for (const m of source.matchAll(TAG)) {
    parts.push(escapeText(source.slice(last, m.index)));
    parts.push(rewriteTag(m[1], m[2], m[3], opts));
    last = m.index + m[0].length;
  }
  parts.push(escapeText(source.slice(last)));
  return parts.join("");
}

/**
 * Text between recognised tags. A stray '<' (an unterminated or malformed
 * tag) must stay text — the browser would otherwise parse it as markup we
 * never vetted. Existing entities are left as they are.
 */
function escapeText(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function eachTag(html: string): Array<{ name: string; attrs: Attr[] }> {
  const out: Array<{ name: string; attrs: Attr[] }> = [];
  for (const m of html.matchAll(TAG)) {
    if (!m[1]) out.push({ name: m[2].toLowerCase(), attrs: parseAttrs(m[3]) });
  }
  return out;
}

/** Images (img src or CSS url()) that would load from the network. */
export function countRemoteImages(html: string): number {
  let count = 0;
  for (const tag of eachTag(html)) {
    for (const a of tag.attrs) {
      if (tag.name === "img" && a.name === "src" && REMOTE_URL.test(urlForCheck(a.value))) count++;
      if (a.name === "style") {
        for (const m of a.value.matchAll(/url\s*\(\s*['"]?([^)'"]*)/gi)) {
          if (REMOTE_URL.test(urlForCheck(m[1]))) count++;
        }
      }
    }
  }
  return count;
}

/** Distinct cid: references in img srcs, capped at MAX_INLINE_IMAGES. */
export function cidRefs(html: string): string[] {
  const seen = new Set<string>();
  for (const tag of eachTag(html)) {
    if (tag.name !== "img") continue;
    const src = tag.attrs.find((a) => a.name === "src")?.value.trim() ?? "";
    if (/^cid:/i.test(src)) seen.add(src.slice(4));
    if (seen.size >= MAX_INLINE_IMAGES) break;
  }
  return [...seen];
}

/** A height for the frame without measuring it (no same-origin, no scripts). */
export function estimateMailFrameHeight(html: string): number {
  const text = html.replace(TAG, " ").replace(/\s+/g, " ").trim();
  const textPx = Math.ceil(text.length / CHARS_PER_LINE) * LINE_HEIGHT_PX;
  const tags = eachTag(html);
  const rowsPx =
    tags.filter((t) => t.name === "tr" || t.name === "p" || t.name === "br").length * ROW_PX;
  const imagesPx = tags
    .filter((t) => t.name === "img")
    .reduce((sum, t) => {
      const h = Number.parseInt(t.attrs.find((a) => a.name === "height")?.value ?? "", 10);
      return sum + (Number.isFinite(h) && h > 0 ? h : DEFAULT_IMAGE_PX);
    }, 0);
  const estimate = textPx + rowsPx + imagesPx + FRAME_PADDING_PX;
  return Math.min(MAIL_FRAME_MAX_HEIGHT, Math.max(MAIL_FRAME_MIN_HEIGHT, estimate));
}

function contentSecurityPolicy(allowRemoteImages: boolean): string {
  const img = allowRemoteImages ? "data: https: http:" : "data:";
  return `default-src 'none'; img-src ${img}; style-src 'unsafe-inline'; font-src data:; form-action 'none'`;
}

/**
 * Mail is authored against a white page (senders set dark text and assume
 * the background), so the frame is always a light sheet — the same call the
 * desktop app made (EmailHtmlView.wrap).
 */
const FRAME_CSS =
  ":root{color-scheme: light}html,body{background:#ffffff}" +
  "body{margin:16px 20px;font:15px/1.6 system-ui,-apple-system,'Segoe UI','Apple SD Gothic Neo',sans-serif;" +
  "color:#1e293b;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}a{color:#0369a1}";

/**
 * The full srcdoc. Order matters: the CSP meta is the first thing in <head>
 * so it governs every load that follows, and our <base target="_blank"> is
 * injected after sanitizing, so no sender <base> can precede or replace it.
 */
export function buildMailSrcdoc(html: string, opts: MailSrcdocOptions): string {
  const body = neutralizeMailHtml(html, opts);
  return (
    "<!doctype html><html><head>" +
    `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(opts.allowRemoteImages)}">` +
    '<meta charset="utf-8"><meta name="referrer" content="no-referrer"><base target="_blank">' +
    `<style>${FRAME_CSS}</style></head><body>${body}</body></html>`
  );
}
