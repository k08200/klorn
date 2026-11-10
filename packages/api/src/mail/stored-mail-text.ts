/**
 * The body and snippet a mail source without its own preview stores: IMAP
 * (imap-sync.ts) and the Klorn mailbox (klorn-inbound-map.ts). Gmail and Outlook
 * have a server-side snippet and do not use this.
 */

import sanitizeHtml from "sanitize-html";
import { capStored } from "./imap-envelope.js";

// Cut with capStored, never splitting a surrogate pair: a lone surrogate is
// stored as U+FFFD, so the row would differ from the next poll's text and be
// rewritten every cycle.
export const MAX_STORED_BODY_CHARS = 50_000;

// The snippet keeps 200 characters; sanitize-html's cost grows faster than
// linearly with tag nesting, and the raw fallback can be a whole fixed-host
// TEXT part (no size cap), so only its head is sanitized.
const SNIPPET_SOURCE_CHARS = 4_000;

export function snippetFromBody(bodyText: string, max = 200): string | null {
  if (!bodyText) return null;
  // Strip HTML through sanitize-html (proper parser) rather than regex —
  // CodeQL flags regex-based tag stripping as bad-tag-filter even when
  // the output is never rendered. The judge prompt only needs the first
  // sentence or two so we collapse whitespace and slice.
  const stripped = sanitizeHtml(capStored(bodyText, SNIPPET_SOURCE_CHARS), {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: "discard",
  });
  const text = stripped.replace(/\s+/g, " ").trim();
  return capStored(text, max) || null;
}
