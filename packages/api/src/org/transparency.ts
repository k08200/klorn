/**
 * The member transparency view (Klorn Teams launch feature 8): what this
 * member's organization can and cannot see, stated from the static truth in
 * privacy.ts plus the member's own facts (role, seat, free/busy grant) and the
 * ceilings that apply to them. Seats, roles and cost only — never mail.
 */

import {
  TEAM_STANDARD_SEAT_ANNUAL_PER_MONTH_CENTS,
  TEAM_STANDARD_SEAT_MONTHLY_CENTS,
} from "../billing/advertised-price.js";
import { isJudgeV3PolicyEnabled } from "../judge/v3/flags.js";
import { currentOrgView, recentFreeBusyReads } from "./org-members.js";
import { NEVER_VISIBLE_TO_ORG, VISIBLE_TO_ORG } from "./privacy.js";

export async function transparencyFor(userId: string) {
  const view = await currentOrgView(userId);
  if (!view.org) return { org: null };
  const { org, me } = view;
  return {
    visibleToOrg: VISIBLE_TO_ORG.map((entry) => ({
      ...entry,
      active: entry.key === "freeBusy" ? me.sharesFreeBusy : true,
    })),
    neverVisible: [...NEVER_VISIBLE_TO_ORG],
    you: { role: me.role, seated: me.seated, sharesFreeBusy: me.sharesFreeBusy },
    ceilings: {
      autoReplyDisabled: org.autoReplyDisabled,
      agentModeCap: org.agentModeCap,
      appliesToEveryone: true,
    },
    // Verified mail from these domains is named "a colleague at your company"
    // in this member's triage reasons (judge/v3 orgCompanyDomain), which only
    // the v3 policy shows: empty while it does not decide this member's
    // lanes, so the page never claims a reason the member cannot see. The
    // organization never learns which mail matched.
    companyDomains: isJudgeV3PolicyEnabled(userId) ? org.companyDomains : [],
    // Who read your free/busy lately, and for which window: the same rows the
    // owner sees in the audit log.
    freeBusyReads: await recentFreeBusyReads(userId, org.id),
    seatPrice: {
      currency: "USD",
      monthlyCents: TEAM_STANDARD_SEAT_MONTHLY_CENTS,
      annualPerMonthCents: TEAM_STANDARD_SEAT_ANNUAL_PER_MONTH_CENTS,
    },
  };
}
