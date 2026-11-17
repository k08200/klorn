/**
 * Mail addresses out of free text bound for Sentry (sentry-scrub.ts).
 *
 * An address is personal data, and Sentry keeps it beyond the account: a wipe
 * or a deletion does not reach it. The log sites name accounts by row id or an
 * addressLogTag (address-log-tag.ts), but the console integration turns EVERY
 * console.* line into a breadcrumb, and a breadcrumb rides on the next error
 * event; one line anywhere that printed an address put it in Sentry. So the
 * Sentry hooks redact address-shaped text wherever it sits.
 *
 * Linear on hostile input, because this runs on every breadcrumb and the
 * untrusted-text paths here have been DoS'd by a regex before (#1466): every
 * repetition is bounded and none is nested, so no start position scans more
 * than a fixed window (the local part is at most 64 characters by RFC 5321, a
 * domain label at most 63, a domain at most 253). The common unbounded
 * `[…]+@[…]+\.[…]{2,}` is quadratic on a long run of local-part characters.
 *
 * Loose on purpose: over-redaction costs readability only (`node@11.11.0`
 * reads as an address too), while a miss is a leak. Non-ASCII characters count
 * as address characters (`홍길동@회사.한국`), and so does an `@` written as
 * `%40` in a URL. The marker carries nothing of the address.
 */

export const MAIL_ADDRESS_MARKER = "[ADDRESS]";

/**
 * local part, `@` or `%40`, one domain label, a dot, then the rest of the
 * domain. The label class has no dot, so the dot after it is unambiguous.
 */
export const MAIL_ADDRESS_PATTERN =
  /[A-Za-z0-9._%+'\u0080-￿-]{1,64}(?:@|%40)[A-Za-z0-9\u0080-￿-]{1,63}\.[A-Za-z0-9.\u0080-￿-]{1,252}/g;

/** Replace every address-shaped substring with MAIL_ADDRESS_MARKER. */
export function redactMailAddresses(text: string): string {
  return text.replace(MAIL_ADDRESS_PATTERN, MAIL_ADDRESS_MARKER);
}
