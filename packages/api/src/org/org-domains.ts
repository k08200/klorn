/**
 * Organization company domains for a member's judge (Klorn Teams launch
 * feature 6, docs/design/pricing-tiers.md): the domains the member's own
 * organization sends from, read when the judge builds the relationship
 * snapshot (judge/v3/relationship-loader.ts). They become one boolean fact,
 * orgCompanyDomain ("the sender is a colleague at your company"); the list
 * itself, the organization and its members never reach the judge.
 *
 * Direction: organization → member. The organization learns nothing of the
 * member's mail through this read; it is the member's judge reading a setting
 * of the member's own organization. While TEAMS_ENABLED is closed to the user
 * it runs no query.
 */

import { teamsOpenTo } from "../config.js";
import { prisma } from "../db.js";

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Lower-case, de-duplicated domains; anything else is dropped (admin input). */
function cleanDomains(values: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const domain = value.trim().toLowerCase();
    if (DOMAIN_RE.test(domain) && !out.includes(domain)) out.push(domain);
  }
  return out;
}

/** The user's organization's company domains; [] when none or Teams is closed to the user. */
export async function orgCompanyDomainsFor(userId: string): Promise<string[]> {
  if (!teamsOpenTo(userId)) return [];
  const membership = await prisma.orgMembership.findUnique({
    where: { userId },
    select: { org: { select: { companyDomains: true } } },
  });
  return membership ? cleanDomains(membership.org.companyDomains) : [];
}
