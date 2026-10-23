/**
 * Two normalizations several mail paths share. Dependency-free, so config.ts can
 * use them too.
 */

/** ASCII-only lower-casing: a look-alike letter (U+212A KELVIN SIGN) never folds into `k`. */
export function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}

/** Without NUL, which Postgres text cannot hold (a refused row would lose the message). */
export function stripNul(value: string): string {
  return value.includes("\u0000") ? value.replaceAll("\u0000", "") : value;
}
