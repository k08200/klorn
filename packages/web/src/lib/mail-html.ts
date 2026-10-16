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
const DROP_WITH_CONTENT = new Set(
  (
    "script style title textarea noscript template xmp svg math iframe object noembed noframes " +
    "select button applet"
  ).split(" "),
);
const TAG_NAME_START = /[a-z]/i;
const TAG_NAME_CHAR = /[\w:-]/;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
/**
 * Style values dropped whole: legacy script hooks, CSS functions that load
 * images without url(), and escapes in front of a call (u\72l(…) is url()).
 * A lone backslash stays — CJK mail escapes font names ("\5FAE\8F6F…").
 */
const ACTIVE_CSS =
  /expression\s*\(|javascript\s*:|vbscript\s*:|behavior\s*:|-moz-binding|image-set|cross-fade|element\s*\(|(?<![\w-])image\s*\(/i;

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

/** The url inside each CSS url(…), quotes and controls stripped. Linear. */
function cssUrlSegments(style: string): Array<{ url: string | null; rest: string; raw: string }> {
  return style
    .split(/url\s*\(/i)
    .slice(1)
    .map((raw) => {
      const close = raw.indexOf(")");
      if (close < 0) return { url: null, rest: "", raw };
      const url = urlForCheck(raw.slice(0, close)).replace(/^['"]|['"]$/g, "");
      return { url, rest: raw.slice(close + 1), raw };
    });
}

function cleanStyle(style: string, allowRemote: boolean): string | null {
  if (ACTIVE_CSS.test(style) || (style.includes("\\") && style.includes("("))) return null;
  const head = style.split(/url\s*\(/i, 1)[0];
  const keep = (url: string) => SAFE_DATA_IMAGE.test(url) || (allowRemote && REMOTE_URL.test(url));
  const tail = cssUrlSegments(style).map((seg) =>
    seg.url !== null && keep(seg.url) ? `url(${seg.raw}` : `none${seg.rest}`,
  );
  return head + tail.join("");
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
    const style = cleanStyle(attr.value, opts.allowRemoteImages);
    return style === null ? null : { name: "style", value: style };
  }
  return attr;
}

function rewriteTag(
  closing: boolean,
  name: string,
  rawAttrs: string,
  opts: MailSrcdocOptions,
): string {
  if (!ALLOWED_TAGS.has(name)) return "";
  if (closing) return VOID_TAGS.has(name) ? "" : `</${name}>`;
  const kept = parseAttrs(rawAttrs)
    .map((a) => cleanAttr(name, a, opts))
    .filter((a): a is Attr => a !== null);
  const withRel = name === "a" ? [...kept, { name: "rel", value: "noopener noreferrer" }] : kept;
  const attrs = withRel.map((a) => ` ${a.name}="${escapeAttr(a.value)}"`).join("");
  return `<${name}${attrs}>`;
}

type Token =
  | { kind: "text"; text: string }
  | { kind: "tag"; closing: boolean; name: string; rawAttrs: string };

/** Index of the '>' closing a tag, honouring quotes; -1 if the tag never ends. */
function tagEnd(src: string, from: number): number {
  let quote = "";
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i;
    }
  }
  return -1;
}

/** Past the end of `<!…>`, `<?…>` or a comment (all dropped); unterminated drops the rest. */
function skipDeclaration(src: string, lt: number): number {
  const isComment = src.startsWith("<!--", lt);
  const end = isComment ? src.indexOf("-->", lt + 4) : src.indexOf(">", lt);
  if (end < 0) return src.length;
  return end + (isComment ? 3 : 1);
}

/** Reads the markup at `lt`, pushing at most one token; returns where to resume. */
function scanMarkup(src: string, lower: string, lt: number, tokens: Token[]): number {
  const next = src[lt + 1] ?? "";
  if (next === "!" || next === "?") return skipDeclaration(src, lt);
  const closing = next === "/";
  const nameStart = lt + (closing ? 2 : 1);
  if (!TAG_NAME_START.test(src[nameStart] ?? "")) {
    tokens.push({ kind: "text", text: "<" });
    return lt + 1;
  }
  let nameEnd = nameStart + 1;
  while (nameEnd < src.length && TAG_NAME_CHAR.test(src[nameEnd])) nameEnd++;
  const name = lower.slice(nameStart, nameEnd);
  const end = tagEnd(src, nameEnd);
  if (end < 0) {
    tokens.push({ kind: "text", text: src.slice(lt) });
    return src.length;
  }
  if (!closing && DROP_WITH_CONTENT.has(name)) {
    const close = lower.indexOf(`</${name}`, end + 1);
    const closeEnd = close < 0 ? -1 : src.indexOf(">", close);
    return closeEnd < 0 ? src.length : closeEnd + 1;
  }
  tokens.push({ kind: "tag", closing, name, rawAttrs: src.slice(nameEnd, end) });
  return end + 1;
}

/**
 * One linear pass (no backtracking regex over the document — hostile input
 * of unterminated '<' made the regex version quadratic). Whatever is not a
 * well-terminated tag becomes text, and text is always escaped on output.
 */
function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const lower = src.toLowerCase();
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      tokens.push({ kind: "text", text: src.slice(i) });
      break;
    }
    if (lt > i) tokens.push({ kind: "text", text: src.slice(i, lt) });
    i = scanMarkup(src, lower, lt, tokens);
  }
  return tokens;
}

/**
 * Tag + attribute allowlist rewrite. Unknown tags are dropped (their text
 * stays, inert); script-like blocks go with their content; every attribute
 * is re-quoted and all text escaped, so nothing the sender wrote is ever
 * re-parsed as markup.
 */
export function neutralizeMailHtml(
  html: string,
  opts: MailSrcdocOptions = { allowRemoteImages: false },
): string {
  return tokenize(html)
    .map((t) =>
      t.kind === "text" ? escapeText(t.text) : rewriteTag(t.closing, t.name, t.rawAttrs, opts),
    )
    .join("");
}

/** Text between tags: '<' and '>' always escaped. Existing entities stay. */
function escapeText(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function eachTag(html: string): Array<{ name: string; attrs: Attr[] }> {
  return tokenize(html).flatMap((t) =>
    t.kind === "tag" && !t.closing ? [{ name: t.name, attrs: parseAttrs(t.rawAttrs) }] : [],
  );
}

/** Images (img src or CSS url()) that would load from the network. */
export function countRemoteImages(html: string): number {
  let count = 0;
  for (const tag of eachTag(html)) {
    for (const a of tag.attrs) {
      if (tag.name === "img" && a.name === "src" && REMOTE_URL.test(urlForCheck(a.value))) count++;
      if (a.name === "style") {
        count += cssUrlSegments(a.value).filter(
          (seg) => seg.url && REMOTE_URL.test(seg.url),
        ).length;
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
    const cid = /^cid:/i.test(src) ? src.slice(4) : "";
    // "." / ".." would be normalised by fetch into a different API path.
    if (cid && cid !== "." && cid !== "..") seen.add(cid);
    if (seen.size >= MAX_INLINE_IMAGES) break;
  }
  return [...seen];
}

/** A height for the frame without measuring it (no same-origin, no scripts). */
export function estimateMailFrameHeight(html: string): number {
  const text = tokenize(html)
    .map((t) => (t.kind === "text" ? t.text : " "))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
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
