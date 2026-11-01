/**
 * Mail HTML → iframe srcdoc for the mobile reader. A port of the web reader's
 * packages/web/src/lib/mail-html.ts (#1455), kept equivalent on purpose:
 *
 *   1. server allowlist (sanitize-html, packages/api/src/mail/email-text.ts)
 *   2. this rewrite (tag + attribute allowlist) — in case wall 1 ever drifts
 *   3. <iframe sandbox> with NO allow-scripts, plus a CSP meta that refuses
 *      every load except images once the reader allows them
 *
 * Remote images are blocked by default (tracking pixels, CSS url() beacons):
 * their srcs are removed here AND the CSP refuses them, so either wall alone
 * holds. Pure string functions, no DOM: unit-tested in node (mail-html.test.ts).
 *
 * Differences from the web, both for the native shell:
 *  - Links are taken by the app (MailFrame intercepts the click and opens the
 *    system browser through @capacitor/browser), so no `<base target>` popup
 *    path is needed and the sandbox grants no popups at all.
 *  - Dark mode: mail that sets no colours of its own is drawn on the dark
 *    reader surface; mail that paints its own colours keeps the light sheet it
 *    was designed for (`frameTheme`).
 */

export const MAIL_FRAME_MIN_HEIGHT = 120;
/** Upper bound on cid: images resolved per message (each is an API call). */
export const MAX_INLINE_IMAGES = 10;

export interface MailSrcdocOptions {
  allowRemoteImages: boolean;
  /** cid → data:image/… url, resolved by the caller through the authed API. */
  inlineImages?: Readonly<Record<string, string>>;
  /** "dark" draws the frame on the dark reader surface (see frameTheme). */
  theme?: "light" | "dark";
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
const REPLACEMENT_CHAR = "�";

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
export function urlForCheck(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping controls is the point
  return value.replace(/[\u0000- \u007f]+/g, "");
}

function parseAttrs(raw: string): Attr[] {
  // The browser honours the first of duplicate attributes; so do we.
  const attrs = new Map<string, Attr>();
  for (const m of raw.matchAll(ATTR)) {
    const name = (m[1] ?? "").toLowerCase();
    if (!name || attrs.has(name)) continue;
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
  const head = style.split(/url\s*\(/i, 1)[0] ?? "";
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
  if (opts.allowRemoteImages && REMOTE_URL.test(url)) return value.trim();
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
  while (nameEnd < src.length && TAG_NAME_CHAR.test(src[nameEnd] ?? "")) nameEnd++;
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

/** Text between tags: '<' and '>' always escaped. Existing entities stay. */
function escapeText(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

const COLOUR_STYLE = /(^|[;\s])(background(-color|-image)?|color)\s*:/i;

/**
 * True when the sender painted colours of their own (bgcolor / color
 * attributes, <font color>, inline background or colour styles). Such mail
 * was designed against its own palette and keeps the light sheet in dark
 * mode; plain-styled HTML takes the reader's dark surface instead.
 */
export function hasAuthoredColors(html: string): boolean {
  for (const tag of eachTag(html)) {
    for (const a of tag.attrs) {
      if (a.name === "bgcolor" || a.name === "color") return true;
      if (a.name === "style" && COLOUR_STYLE.test(a.value)) return true;
    }
  }
  return false;
}

/** The theme the frame is drawn in: dark only for dark mode AND uncoloured mail. */
export function frameTheme(html: string, dark: boolean): "light" | "dark" {
  return dark && !hasAuthoredColors(html) ? "dark" : "light";
}

function contentSecurityPolicy(allowRemoteImages: boolean): string {
  const img = allowRemoteImages ? "data: https: http:" : "data:";
  return `default-src 'none'; img-src ${img}; style-src 'unsafe-inline'; font-src data:; form-action 'none'`;
}

const BASE_CSS =
  "html,body{margin:0;padding:0}" +
  "body{padding:4px 0 8px;font:16px/1.65 -apple-system,system-ui,'Segoe UI','Apple SD Gothic Neo','Noto Sans KR',sans-serif;" +
  "overflow-wrap:anywhere;word-break:break-word;-webkit-text-size-adjust:100%}" +
  "img{max-width:100%;height:auto}table{max-width:100%!important}pre{white-space:pre-wrap}" +
  "blockquote{margin:8px 0;padding-left:12px;border-left:3px solid rgba(100,116,139,.35)}";

/** Light sheet: mail is authored for a white page (same call as the web and Mac readers). */
const LIGHT_CSS =
  ":root{color-scheme:light}html,body{background:#ffffff;color:#1e293b}a{color:#0369a1}";
/** Dark reader surface (tokens.css dark --surface-card / --ink-strong / --accent). */
const DARK_CSS =
  ":root{color-scheme:dark}html,body{background:#141416;color:#e2e8f0}a{color:#38bdf8}";

/**
 * The full srcdoc. The CSP meta is the first thing in <head> so it governs
 * every load that follows.
 */
export function buildMailSrcdoc(html: string, opts: MailSrcdocOptions): string {
  const body = neutralizeMailHtml(html, opts);
  const themeCss = opts.theme === "dark" ? DARK_CSS : LIGHT_CSS;
  return (
    "<!doctype html><html><head>" +
    `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(opts.allowRemoteImages)}">` +
    '<meta charset="utf-8"><meta name="referrer" content="no-referrer">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<style>${BASE_CSS}${themeCss}</style></head><body>${body}</body></html>`
  );
}

/**
 * What a link the user tapped inside the mail may do: open https in the
 * system browser, start a reply for mailto:, or nothing at all.
 */
export type MailLinkAction =
  | { kind: "browser"; url: string }
  | { kind: "mailto"; address: string }
  | null;

export function mailLinkAction(href: string | null | undefined): MailLinkAction {
  if (!href) return null;
  const checked = urlForCheck(href);
  if (/^https?:/i.test(checked)) {
    try {
      const url = new URL(href.trim());
      // http is upgraded: the system browser is never sent to a cleartext page.
      if (url.protocol === "http:") url.protocol = "https:";
      return url.protocol === "https:" ? { kind: "browser", url: url.toString() } : null;
    } catch {
      return null;
    }
  }
  if (/^mailto:/i.test(checked)) {
    let address = "";
    try {
      address = decodeURIComponent(href.trim().slice(7).split("?")[0] ?? "").trim();
    } catch {
      return null;
    }
    return /^[^\s@<>]+@[^\s@<>]+$/.test(address) ? { kind: "mailto", address } : null;
  }
  return null;
}
