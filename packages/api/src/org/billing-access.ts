/**
 * What the viewing owner may do with the team subscription, so Settings →
 * Team explains it up front instead of failing on click (GET
 * /api/orgs/current only): whether they pay, whether the billing portal opens
 * for them, the seat cap a recorded payer without the paying email has, and
 * whether they can take a scheduled cancel back. Only the viewer's own
 * standing: never who pays, never an email, nothing for a member. A hint, not
 * a gate: every route checks again against Paddle's live state
 * (seat-management.ts), and the cap here is from the stored seat count, which
 * can trail Paddle's until the webhook lands.
 *
 * The one Paddle read (the customer's email) is remembered per owner and
 * customer for a short while, so reloading the page cannot drain Paddle's API
 * rate limit. A failed read is not remembered and answers null (unknown).
 */

import { getPaddleCustomerEmail } from "../billing/paddle-team.js";
import { prisma } from "../db.js";
import { captureError } from "../sentry.js";
import { subscriptionBills } from "./effective-tier.js";
import { currentOrgView, type MeWire } from "./org-members.js";
import type { OrgWire } from "./org-shape.js";
import { BILLING_SELECT, recordedPayerSeatCap, sameEmail } from "./seat-management.js";

export interface BillingAccessWire {
  /** The recorded payer, or the owner whose verified email Paddle bills; null when Paddle could not say. */
  isPayer: boolean | null;
  /** The billing portal opens for this owner (their verified email is Paddle's); null when unknown. */
  portal: boolean | null;
  /** The most seats this owner can set without the paying email, or null when no such cap applies. */
  seatCap: number | null;
  /** This owner can take back a scheduled cancel (the payer, or the owner who scheduled it in Klorn). */
  canResume: boolean | null;
}

/** How long a customer-email match is remembered for the hint. */
const EMAIL_MATCH_TTL_MS = 2 * 60_000;
/** At most this many remembered matches (one per owner and Paddle customer). */
const EMAIL_MATCH_CACHE_MAX = 1_000;
/** The page waits on this read, so it is shorter than a change's. */
const HINT_CALL_TIMEOUT_MS = 3_000;

const emailMatches = new Map<string, { match: boolean; at: number }>();

function rememberedMatch(key: string, now: number): boolean | undefined {
  const hit = emailMatches.get(key);
  if (!hit) return undefined;
  if (now - hit.at > EMAIL_MATCH_TTL_MS) {
    emailMatches.delete(key);
    return undefined;
  }
  return hit.match;
}

function rememberMatch(key: string, match: boolean, now: number): void {
  if (emailMatches.size >= EMAIL_MATCH_CACHE_MAX) {
    const oldest = emailMatches.keys().next().value;
    if (oldest !== undefined) emailMatches.delete(oldest);
  }
  emailMatches.set(key, { match, at: now });
}

/** Whether the owner's verified Klorn email is the Paddle customer's; null when Paddle could not say. */
async function emailMatch(
  userId: string,
  orgId: string,
  customerId: string,
): Promise<boolean | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  if (!user?.emailVerified) return false;
  if (!(process.env.PADDLE_API_KEY ?? "").trim()) return null;
  const key = `${customerId}:${userId}`;
  const now = Date.now();
  const remembered = rememberedMatch(key, now);
  if (remembered !== undefined) return remembered;
  let payerEmail: string | null;
  try {
    payerEmail = await getPaddleCustomerEmail(customerId, { timeoutMs: HINT_CALL_TIMEOUT_MS });
  } catch (err) {
    captureError(err, { tags: { scope: "org.billing.access_hint" }, extra: { orgId } });
    return null;
  }
  const match = payerEmail !== null && sameEmail(payerEmail, user.email);
  rememberMatch(key, match, now);
  return match;
}

/** The owner's standing on the organization's subscription, or null when nothing bills. */
export async function ownerBillingAccess(
  userId: string,
  orgId: string,
): Promise<BillingAccessWire | null> {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: orgId },
    select: BILLING_SELECT,
  });
  if (!org.paddleSubscriptionId || !subscriptionBills(org.subscriptionStatus)) return null;
  const recorded = org.payerUserId === userId;
  const email = org.paddleCustomerId
    ? await emailMatch(userId, orgId, org.paddleCustomerId)
    : false;
  const isPayer = recorded || email === true ? true : email;
  return {
    isPayer,
    portal: email,
    seatCap:
      recorded && email === false
        ? recordedPayerSeatCap(org.seatsPurchased, org.seatsAtAttach)
        : null,
    canResume: org.cancelRequestedByUserId === userId ? true : isPayer,
  };
}

type OrgView = { org: null } | { org: OrgWire; me: MeWire & { billing?: BillingAccessWire } };

/** GET /api/orgs/current: the view, and for an owner, their standing on the subscription. */
export async function currentOrgViewWithBilling(userId: string): Promise<OrgView> {
  const view = await currentOrgView(userId);
  if (!view.org || view.me.role !== "OWNER") return view;
  const billing = await ownerBillingAccess(userId, view.org.id);
  return billing ? { ...view, me: { ...view.me, billing } } : view;
}
