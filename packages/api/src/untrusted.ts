/**
 * Wrap content pulled from external sources (email bodies, web pages, files,
 * third-party messages) so the LLM can distinguish it from trusted instructions.
 * The system prompt tells the model to treat anything inside
 * <untrusted_content>...</untrusted_content> as data, never as a command.
 *
 * Any pre-existing <untrusted_content> tags inside the raw content are stripped
 * so a crafted email body cannot close the wrapper early and smuggle
 * instructions back into the trusted context.
 */
const STRIP_RE = /<\/?untrusted_content[^>]*>/gi;

export function wrapUntrusted(content: string | null | undefined, source: string): string {
  if (!content) return "";
  const safe = content.replace(STRIP_RE, "");
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
