import { charFromCodePoint } from "./char-ref";

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

/**
 * Decode named and numeric character references in display text. Numeric
 * references to invalid code points become U+FFFD (see char-ref.ts); malformed
 * or unknown references stay as written. One linear regex pass, never throws.
 */
export function decodeHtmlEntities(value: string | null | undefined): string {
  if (!value) return "";

  return value.replace(
    /&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi,
    (match, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
      if (hex !== undefined) return charFromCodePoint(Number.parseInt(hex, 16));
      if (dec !== undefined) return charFromCodePoint(Number.parseInt(dec, 10));
      // Own keys only: `&constructor;` must not find the object prototype's.
      const key = (name ?? "").toLowerCase();
      return Object.hasOwn(HTML_ENTITIES, key) ? (HTML_ENTITIES[key] as string) : match;
    },
  );
}

/**
 * Locale-aware relative time, for strings that embed a timestamp inside a
 * translated sentence.
 *
 * `formatRelative` below hardcodes English ("3m ago"), which is survivable as a
 * standalone column but reads as broken the moment it lands mid-sentence in
 * another language — "메일 7통 · 마지막 13m ago". `Intl.RelativeTimeFormat` is
 * built in and needs no table of its own.
 *
 * Under a minute has no good `Intl` rendering (numeric:"auto" gives "this
 * minute"), so the caller supplies an already-translated "just now" string.
 *
 * Not a replacement for `formatRelative`: existing callers are left alone on
 * purpose. New localized surfaces should reach for this one.
 */
export function formatRelativeIntl(
  date: string | Date | null | undefined,
  locale: string,
  justNow: string,
): string {
  if (!date) return justNow;
  const d = typeof date === "string" ? new Date(date) : date;
  const diffMs = Date.now() - d.getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return justNow;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return justNow;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
  if (minutes < 60) return rtf.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 30) return rtf.format(-days, "day");
  return d.toLocaleDateString(locale, { month: "short", day: "numeric" });
}

/** Relative time string: "Just now", "3m ago", "2h ago", "Jan 3", "Jan 3, 25" */
export function formatRelative(date: string | Date | null | undefined): string {
  if (!date) return "Just now";
  const d = typeof date === "string" ? new Date(date) : date;
  const diffMs = Date.now() - d.getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return "Just now";
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "2-digit" }),
  });
}
