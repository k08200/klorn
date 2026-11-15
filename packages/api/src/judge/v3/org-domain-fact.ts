/**
 * The orgCompanyDomain relationship fact (Klorn Teams): is the sender on one
 * of the user's organization's company domains? Pure; relationship.ts calls
 * it with the domains org/org-domains.ts read.
 *
 * The domains are typed in by an organization owner and nothing verifies
 * them yet, so a domain only counts when it cannot stand for strangers:
 *  - never a public mailbox provider (either list in mail/), which DMARC-passes
 *    for every one of its users;
 *  - never a public suffix shaped like co.uk / com.au / or.kr, which the
 *    owner-side validator accepts (two labels) but which every company under
 *    it would match by subdomain;
 *  - never a multi-tenant hosting parent (github.io, onmicrosoft.com, …), where
 *    every tenant holds a DMARC-aligned subdomain.
 * And the sender's own domain must be a well-formed hostname before a suffix
 * match (no "evil.io#.acme.com").
 */

import { PUBLIC_EMAIL_DOMAINS } from "../../mail/public-mail-domains.js";
import { isPublicMailboxDomain } from "../../mail/public-mailbox-domains.js";

/** A hostname: LDH labels, an alphabetic or punycode top-level label. */
const HOSTNAME_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** Second-level public suffixes under a country code (co.uk, com.au, or.kr, ac.jp, …). */
const CC_SECOND_LEVEL_RE =
  /^(?:co|com|or|org|ne|net|go|gov|gv|ac|edu|ed|mil|nic|ltd|plc)\.[a-z]{2}$/;

/** Hosting parents whose tenants each get a subdomain they control. */
const MULTI_TENANT_PARENTS: ReadonlySet<string> = new Set([
  "onmicrosoft.com",
  "github.io",
  "gitlab.io",
  "herokuapp.com",
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "workers.dev",
  "web.app",
  "firebaseapp.com",
  "appspot.com",
  "azurewebsites.net",
  "cloudfront.net",
  "amazonaws.com",
  "blogspot.com",
  "wixsite.com",
  "myshopify.com",
  "googleusercontent.com",
]);

function standsForStrangers(domain: string): boolean {
  return (
    isPublicMailboxDomain(domain) ||
    PUBLIC_EMAIL_DOMAINS.has(domain) ||
    CC_SECOND_LEVEL_RE.test(domain) ||
    MULTI_TENANT_PARENTS.has(domain)
  );
}

/** The organization's domains a sender can match; empty when none is usable. */
export function usableOrgDomains(domains: readonly string[] | undefined): string[] {
  if (!domains) return [];
  return domains
    .map((d) => d.trim().toLowerCase())
    .filter((d) => HOSTNAME_RE.test(d) && !standsForStrangers(d));
}

/**
 * The fact for one sender domain (lower-case), under the same spoofing rule as
 * sameOrgDomain: a company-domain From is a colleague only when this mail
 * passed DMARC; unknown or failed authentication is null (no evidence). Exact
 * domain or a subdomain (mail.acme.com ⊂ acme.com, as isInternalSender in
 * mail/company-domains.ts); notacme.com and acme.com.evil.io are not acme.com.
 */
export function orgDomainFact(
  senderDomain: string,
  usable: readonly string[],
  authenticated: boolean | null,
): boolean | null {
  if (!HOSTNAME_RE.test(senderDomain) || standsForStrangers(senderDomain)) return false;
  const match = usable.some((d) => senderDomain === d || senderDomain.endsWith(`.${d}`));
  if (!match) return false;
  return authenticated === true ? true : null;
}
