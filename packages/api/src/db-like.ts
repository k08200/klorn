/**
 * Prisma sends `contains` / `startsWith` / `endsWith` as LIKE (ILIKE with
 * `mode: "insensitive"`) and does not escape the value, so `_` and `%` in it are
 * wildcards and `\` escapes the next character. Escaped, all three are the
 * characters themselves. Postgres's default LIKE escape is `\`.
 *
 * like-pattern-guard.test.ts fails on a filter value built at run time that does
 * not come through here.
 */

const LIKE_SPECIAL = /[\\%_]/g;

/** The value for a Prisma LIKE filter: matches `text` literally. */
export function escapeLikePattern(text: string): string {
  return text.replace(LIKE_SPECIAL, "\\$&");
}

/** `%text%` for a raw-SQL LIKE / ILIKE: a literal substring match. */
export function likeContainsPattern(text: string): string {
  return `%${escapeLikePattern(text)}%`;
}
