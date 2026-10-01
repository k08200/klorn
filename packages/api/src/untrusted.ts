/**
 * Wrap content pulled from external sources (email bodies, web pages, files,
 * third-party messages) so the LLM can distinguish it from trusted instructions.
 * The system prompt tells the model to treat anything inside
 * <untrusted_content>...</untrusted_content> as data, never as a command.
 *
 * Any pre-existing <untrusted_content> tags inside the raw content are stripped
 * so a crafted email body cannot close the wrapper early and smuggle
 * instructions back into the trusted context.
 *
 * Stripping alone is not enough: removing one tag can join the text around it
 * into a new one (`</untrusted_</untrusted_content>content>` becomes
 * `</untrusted_content>`), and a zero-width character inside the name slips
 * past any pattern. So after the strip, the data is made unable to close
 * anything: a `<` that starts a closing tag (`</`, also with whitespace or
 * zero-width characters before the slash) becomes `&lt;`, and any remaining
 * mention of the tag name is renamed. Every pattern is bounded, so the cost
 * stays linear in the input (mail bodies reach here uncapped).
 */
const STRIP_RE = /<\s{0,16}\/?\s{0,16}untrusted_content[^>]{0,256}>/gi;
const TAG_NAME_RE = /untrusted_content/gi;
const NEUTRAL_TAG_NAME = "untrusted-content";
// `<` or fullwidth `＜`, then up to 16 whitespace / soft hyphen / zero-width / word-joiner / BOM characters, then `/`.
const CLOSING_TAG_START_RE = /[<＜](?=[\s­​-‍⁠﻿]{0,16}\/)/g;

export function wrapUntrusted(content: string | null | undefined, source: string): string {
  if (!content) return "";
  const safe = content
    .replace(STRIP_RE, "")
    .replace(CLOSING_TAG_START_RE, "&lt;")
    .replace(TAG_NAME_RE, NEUTRAL_TAG_NAME);
  return `<untrusted_content source="${source}">${safe}</untrusted_content>`;
}

/**
 * Strip <untrusted_content> wrappers for user-facing display. The wrappers
 * exist so the LLM treats external text as data; once we render to a human
 * (briefing fallback, lists, search results) the tags become visible noise
 * and pollute downstream tokenizers.
 */
export function stripUntrusted(content: string | null | undefined): string {
  if (!content) return "";
  return content.replace(STRIP_RE, "");
}
