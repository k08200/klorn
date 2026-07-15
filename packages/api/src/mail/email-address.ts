/**
 * Leaf helpers for email-address header parsing. Lives outside email-sync.ts
 * so modules email-sync itself imports (e.g. judge-context.ts) can use them
 * without creating an import cycle.
 */

/**
 * Pull just the email address from a header value like "Name <foo@bar.com>".
 * Returns lowercase, or the full lowercased input when no angle brackets are
 * present.
 */
export function extractEmailAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return (match?.[1] ?? value).trim().toLowerCase();
}
