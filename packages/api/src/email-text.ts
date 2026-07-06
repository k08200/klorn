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

export function htmlToPlainText(html: string): string {
  if (!html || !html.trim()) return "";

  // Insert line breaks after block-level closes and <br> so paragraphs don't
  // collapse into one blob. Tags themselves are stripped by sanitize-html.
  const withBreaks = html
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

  return decodeEntities(text)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
