/**
 * Escaping for the Klorn Vault export. Every subject, snippet, name, reason,
 * brief line and body comes from mail (or a model reading mail), so it is
 * untrusted: in the user's Obsidian vault it must stay text, never YAML
 * structure, a wiki-link, an embed, a tag, HTML, a comment, math or a
 * frontmatter fence.
 *
 *   yamlString  a frontmatter value: one line, JSON-quoted (a subset of YAML
 *               1.2 double-quoted scalars), so no value can add a key, a
 *               list, an anchor or a closing `---`.
 *   mdInline    text in a note: one line, every markdown-significant ASCII
 *               character backslash-escaped (CommonMark lets any ASCII
 *               punctuation be escaped), plus a leading list/heading marker
 *               and Dataview's `::`.
 *   codeBlock   a mail body (opt-in): fenced with more backticks than any run
 *               inside it, so nothing in it is parsed at all.
 *   wikiLink    `[[path|alias]]` to a path this export built (checked), with
 *               an alias that cannot end the link.
 *
 * C0/C1 controls become spaces; format characters (bidi overrides, zero-width
 * marks) are dropped, as notify/mail-push-content.ts plainLine does, so text
 * cannot reorder what the user reads.
 */

import { isVaultPath } from "./vault-paths.js";

export const YAML_VALUE_MAX = 500;
export const MD_INLINE_MAX = 500;
const ALIAS_MAX = 80;

const CONTROL_CHARS = /\p{Cc}/gu;
const FORMAT_CHARS = /\p{Cf}/gu;
// Line and paragraph separators: not \p{Cc}, but YAML 1.1 and some editors
// read them as line breaks.
const LINE_SEPARATORS = /[\u2028\u2029]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// Every ASCII character with a meaning in Obsidian markdown: escapes, code,
// emphasis, links/embeds, HTML/autolinks, tags, tables, strikethrough,
// highlights, math, comments, block ids, entities.
const MD_SPECIAL = /[\\`*_[\]<>#|~=$%^!&]/g;
// A block marker at the very start: bullet or ordered list, or a rule.
const LEADING_LIST = /^([-+])/;
const LEADING_ORDERED = /^(\d{1,9})([.)])/;
const DATAVIEW_FIELD = /::/g;
// An alias is display text: drop what ends the link (`[ ] |`), escapes,
// HTML brackets, code ticks, heading/block markers, and fold a comment
// marker `%%` to a lone `%`.
const ALIAS_BREAKERS = /[[\]|\\<>`#^]/g;
const COMMENT_MARKER = /%{2,}/g;
const BACKTICK_RUN = /`+/g;
const MIN_FENCE = 3;

/** One line of plain text: controls → space, format characters dropped, capped. */
function oneLine(value: string, max: number): string {
  const text = value
    .slice(0, max * 4)
    .replace(LONE_SURROGATE, "�")
    .replace(FORMAT_CHARS, "")
    .replace(CONTROL_CHARS, " ")
    .replace(LINE_SEPARATORS, " ")
    .replace(/\s+/g, " ")
    .trim();
  return capChars(text, max);
}

function capChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/** A frontmatter scalar: double-quoted, one line, capped. */
export function yamlString(value: string, max = YAML_VALUE_MAX): string {
  return JSON.stringify(oneLine(value, max));
}

/** Text inside a note: one line, markdown-inert, capped. */
export function mdInline(value: string, max = MD_INLINE_MAX): string {
  return oneLine(value, max)
    .replace(MD_SPECIAL, (ch) => `\\${ch}`)
    .replace(DATAVIEW_FIELD, ":\\:")
    .replace(LEADING_LIST, "\\$1")
    .replace(LEADING_ORDERED, "$1\\$2");
}

/** A body as a fenced block: nothing inside is parsed as markdown. */
export function codeBlock(text: string): string {
  const clean = text
    .replace(LONE_SURROGATE, "�")
    .replace(/\r\n?/g, "\n")
    .replace(LINE_SEPARATORS, "\n")
    .replace(FORMAT_CHARS, "")
    .replace(CONTROL_CHARS, (ch) => (ch === "\n" || ch === "\t" ? ch : ""));
  const longest = Math.max(0, ...Array.from(clean.matchAll(BACKTICK_RUN), (m) => m[0].length));
  const fence = "`".repeat(Math.max(MIN_FENCE, longest + 1));
  return `${fence}text\n${clean}\n${fence}`;
}

/** Display text for a wiki-link alias: one line, nothing that ends the link. */
export function aliasText(value: string, fallback = ""): string {
  const text = oneLine(value.replace(ALIAS_BREAKERS, "").replace(COMMENT_MARKER, "%"), ALIAS_MAX);
  return text || fallback;
}

/**
 * `[[path|alias]]` to a path this export built; throws on anything else.
 * Inside a table cell the alias pipe is written `\\|`, as Obsidian requires,
 * or it would split the cell.
 */
export function wikiLink(path: string, alias: string, opts: { inTable?: boolean } = {}): string {
  if (!isVaultPath(path)) throw new Error("wikiLink: not a vault path");
  const target = path.slice(0, -".md".length);
  const shown = aliasText(alias, target.split("/").at(-1) ?? target);
  return `[[${target}${opts.inTable ? "\\|" : "|"}${shown}]]`;
}
