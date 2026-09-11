/**
 * Company domains (2026-09-10): the user declares which email domains are
 * THEIR company, and a sender on one of them is 회사 (internal) as a recorded
 * fact — the one relationship signal the judge could never store reliably
 * (email-summarize's vocabulary has no "internal"). Feeds two places: the
 * row chip (firewall route) and the analysis preamble (so the LLM reads a
 * colleague as a colleague, not a customer).
 *
 * Validation lives here, once, because the value is user input that ends up
 * in a prompt: lowercase hostnames only, no public mail providers (gmail.com
 * as "my company" would mark the whole world internal), a small cap.
 */

import { senderEmail } from "../notify/notification-format.js";

export const MAX_COMPANY_DOMAINS = 10;

/** Consumer mail providers — never a company, never prefilled as one. */
export const PUBLIC_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "naver.com",
  "daum.net",
  "hanmail.net",
  "kakao.com",
  "nate.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.co.jp",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "qq.com",
  "163.com",
  "126.com",
]);

// RFC 1035 labels, at least one dot, lowercase — what a mail domain looks
// like after normalization. Max 253 total like a hostname.
const DOMAIN_RE =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * One raw entry → a canonical domain, or null when it is not a domain.
 * Accepts what people paste: "@Acme.com", "acme.com ", "*.acme.com",
 * "https://acme.com/", "me@acme.com" (the address's domain).
 */
export function normalizeDomain(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  value = value.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  value = value.replace(/^\*\./, "").replace(/^@/, "");
  const at = value.lastIndexOf("@");
  if (at >= 0) value = value.slice(at + 1);
  if (value.endsWith(".")) value = value.slice(0, -1);
  return DOMAIN_RE.test(value) ? value : null;
}

export type CompanyDomainsResult = { domains: string[] } | { error: string };

/**
 * The PATCH body → the stored list. Rejects loudly (with the offending
 * value) rather than dropping entries silently: a typo the user never sees
 * is a chip that never appears.
 */
export function normalizeCompanyDomains(input: unknown): CompanyDomainsResult {
  if (!Array.isArray(input)) return { error: "domains must be an array" };
  const domains: string[] = [];
  for (const entry of input) {
    if (typeof entry !== "string") return { error: "domains must be strings" };
    if (!entry.trim()) continue;
    const domain = normalizeDomain(entry);
    if (!domain) return { error: `Not a domain: ${entry.trim()}` };
    if (PUBLIC_MAIL_DOMAINS.has(domain)) {
      return { error: `${domain} is a public mail provider, not a company domain` };
    }
    if (!domains.includes(domain)) domains.push(domain);
  }
  if (domains.length > MAX_COMPANY_DOMAINS) {
    return { error: `At most ${MAX_COMPANY_DOMAINS} domains` };
  }
  return { domains };
}

/** The domain of a From header ("Name <a@b.com>" → "b.com"), lowercase. */
export function senderDomain(from: string | null | undefined): string | null {
  if (!from) return null;
  const address = senderEmail(from).toLowerCase();
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1) || null : null;
}

/**
 * Is this sender on one of the declared company domains? Exact match or a
 * subdomain ("mail.acme.com" ⊂ "acme.com"); "notacme.com" is NOT acme.com.
 * A missing From, or no declared domains, is never internal.
 */
export function isInternalSender(
  from: string | null | undefined,
  companyDomains: readonly string[],
): boolean {
  if (!companyDomains.length) return false;
  const domain = senderDomain(from);
  if (!domain) return false;
  return companyDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/**
 * The account's own domain as the prefill for the connect-time question —
 * null for public providers (no guess to offer) or when the address is not
 * parseable.
 */
export function suggestedCompanyDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const domain = normalizeDomain(email);
  if (!domain || PUBLIC_MAIL_DOMAINS.has(domain)) return null;
  return domain;
}
