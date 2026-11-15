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
 * The one Paddle read (the customer's email) is remembered per owner, email
 * and customer for a short while, concurrent loads share one read, and a
 * failed read answers null (unknown) for a shorter while without asking
 * again, so reloading the page cannot drain Paddle's API rate limit, which
 * checkout and every billing route share.
 */

import { getPaddleCustomerEmail } from "../billing/paddle-team.js";
import { prisma } from "../db.js";
import { captureError } from "../sentry.js";
import { subscriptionBills } from "./effective-tier.js";
import { currentOrgView, type MeWire } from "./org-members.js";
import type { OrgWire } from "./org-shape.js";
import { recordedPayerSeatCap } from "./seat-cap.js";
import { BILLING_SELECT, sameEmail } from "./seat-management.js";

export interface BillingAccessWire {
  /** The recorded payer, or the owner whose verified email Paddle bills; null when Paddle could not say. */
  isPayer: boolean | null;
  /** The billing portal opens for this owner (their verified email is Paddle's); null when unknown. */
  portal: boolean | null;
  /**
   * The most seats this owner can set without the paying email (a recorded
   * payer whose email Paddle does not bill, or cannot confirm now), or null
   * when no such cap applies.
   */
  seatCap: number | null;
  /** This owner could take back the pending cancel as it stands (see resumable). */
  canResume: boolean | null;
}

/** How long a customer-email match is remembered for the hint. */
const EMAIL_MATCH_TTL_MS = 2 * 60_000;
/** How long a failed Paddle read answers "unknown" without asking again. */
const EMAIL_FAILURE_TTL_MS = 30_000;
/** At most this many remembered answers (one per owner, email and Paddle customer). */
const EMAIL_MATCH_CACHE_MAX = 1_000;
/** The page waits on this read, so it is shorter than a change's. */
const HINT_CALL_TIMEOUT_MS = 3_000;

/** A remembered answer: the match, or null for a failed read. */
const emailMatches = new Map<string, { match: boolean | null; at: number }>();
/** Reads in flight, so concurrent page loads share one Paddle call. */
const inFlight = new Map<string, Promise<boolean | null>>();

function rememberedMatch(key: string, now: number): boolean | null | undefined {
  const hit = emailMatches.get(key);
  if (!hit) return undefined;
  const ttl = hit.match === null ? EMAIL_FAILURE_TTL_MS : EMAIL_MATCH_TTL_MS;
  if (now - hit.at > ttl) {
    emailMatches.delete(key);
    return undefined;
  }
  return hit.match;
}

function rememberMatch(key: string, match: boolean | null, now: number): void {
  if (emailMatches.size >= EMAIL_MATCH_CACHE_MAX) {
    const oldest = emailMatches.keys().next().value;
    if (oldest !== undefined) emailMatches.delete(oldest);
  }
  emailMatches.set(key, { match, at: now });
}

/** One Paddle read of the customer's email, compared with the owner's: null when it fails. */
async function readEmailMatch(
  key: string,
  read: { orgId: string; customerId: string; email: string },
): Promise<boolean | null> {
  let match: boolean | null;
  try {
    const payerEmail = await getPaddleCustomerEmail(read.customerId, {
      timeoutMs: HINT_CALL_TIMEOUT_MS,
    });
    match = payerEmail !== null && sameEmail(payerEmail, read.email);
  } catch (err) {
    captureError(err, { tags: { scope: "org.billing.access_hint" }, extra: { orgId: read.orgId } });
    match = null;
  }
  rememberMatch(key, match, Date.now());
  return match;
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
  const email = user.email.trim().toLowerCase();
  // The email is in the key: a changed Klorn email is asked about afresh.
  const key = `${customerId}:${userId}:${email}`;
  const remembered = rememberedMatch(key, Date.now());
  if (remembered !== undefined) return remembered;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const read = readEmailMatch(key, { orgId, customerId, email }).finally(() =>
    inFlight.delete(key),
  );
  inFlight.set(key, read);
  return read;
}

/**
 * Whether this owner can take back the pending cancel as it stands (the same
 * rule as seat-management.ts resumeBasis): its Klorn actor, the paying email,
 * or the recorded payer when the cancel was scheduled through Klorn.
 */
function resumable(
  org: { cancelRequestedByUserId: string | null },
  userId: string,
  recorded: boolean,
  email: boolean | null,
): boolean | null {
  if (org.cancelRequestedByUserId === userId || email === true) return true;
  if (recorded && org.cancelRequestedByUserId !== null) return true;
  return email;
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
  return {
    isPayer: recorded || email === true ? true : email,
    portal: email,
    // Unknown counts as capped: the server caps until Paddle confirms the email.
    seatCap:
      recorded && email !== true
        ? recordedPayerSeatCap(org.seatsPurchased, org.seatsAtAttach)
        : null,
    canResume: resumable(org, userId, recorded, email),
  };
}

type OrgView = { org: null } | { org: OrgWire; me: MeWire & { billing?: BillingAccessWire } };

/**
 * GET /api/orgs/current: the view, and for an owner, their standing on the
 * subscription. The hint never takes the page down: if it fails, the view goes
 * without it (the page then shows the general rules) and the failure is
 * reported.
 */
export async function currentOrgViewWithBilling(userId: string): Promise<OrgView> {
  const view = await currentOrgView(userId);
  if (!view.org || view.me.role !== "OWNER") return view;
  let billing: BillingAccessWire | null;
  try {
    billing = await ownerBillingAccess(userId, view.org.id);
  } catch (err) {
    captureError(err, {
      tags: { scope: "org.billing.access_hint" },
      extra: { orgId: view.org.id },
    });
    return view;
  }
  return billing ? { ...view, me: { ...view.me, billing } } : view;
}
