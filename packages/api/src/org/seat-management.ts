/**
 * Klorn Teams seat management after purchase: the owner sets the seat count,
 * cancels at the period end (or takes the cancel back), and opens the Paddle
 * customer portal. Members can do none of it.
 *
 * Paddle is the source of truth for the subscription. Nothing here writes
 * seatsPurchased or subscriptionStatus: a seat change returns "pending" and
 * the subscription.updated webhook (seat-billing.ts) stores the new count.
 * The cancel date is stored at once, like the personal Pro cancel
 * (routes/billing.ts), so the page shows it before the webhook confirms it.
 *
 * Reads from Paddle happen before the organization's lock; each change then
 * runs under the lock with exactly one Paddle call, time-bounded so the lock
 * wait plus the call fit the interactive transaction's 15 s timeout
 * (INTERACTIVE_TX_OPTIONS). The audit row is written before that call in the
 * same transaction, so a refused call leaves no row behind. A call that times
 * out may still have reached Paddle; the answer says so, and a seat change is
 * "set the count to N", so retrying it is safe.
 *
 * The owner is the organization's billing admin: any owner can change seats
 * or cancel on the payment method already on the subscription (Paddle emails
 * its payer a receipt for every prorated charge). The customer portal is
 * different: it is the payer's whole Paddle account (other subscriptions,
 * invoices, address), so it opens only when the owner's verified Klorn email
 * is the Paddle customer's email.
 *
 * Status rules, from Paddle's API: a past_due subscription cannot be updated
 * (seat changes need active or trialing) except to remove a scheduled change,
 * and can be canceled at the period end, after which it stays past_due until
 * the period ends; a paused one can only be canceled immediately, which this
 * route does not do (the portal can). An organization whose subscription
 * still bills is never closed or deleted (subscriptionBills, effective-tier.ts)
 * — a scheduled cancel does not change that until Paddle reports it canceled.
 */

import {
  cancelPaddleSubscription,
  createPaddlePortalUrl,
  undoPaddleCancellation,
} from "../billing/paddle.js";
import {
  getPaddleCustomerEmail,
  getPaddleTeamSubscription,
  type PaddleTeamSubscription,
  setPaddleSeatQuantity,
} from "../billing/paddle-team.js";
import { prisma } from "../db.js";
import { captureError } from "../sentry.js";
import { recordOrgAudit } from "./audit.js";
import { seatsActive, subscriptionBills } from "./effective-tier.js";
import { OrgError } from "./org-error.js";
import { type OrgTx, ownerInTx, requireVerifiedEmail, withOrgLock } from "./org-lock.js";
import { requireOwner } from "./org-members.js";
import { MAX_SELF_SERVE_SEATS, MIN_TEAM_SEATS } from "./org-shape.js";

/** One Paddle call under the lock: the 15 s transaction keeps ~9 s for the lock wait. */
const PADDLE_CALL_TIMEOUT_MS = 6_000;
const CALL = { timeoutMs: PADDLE_CALL_TIMEOUT_MS };

export type SeatChangeResult = { status: "pending" | "unchanged"; seats: number };

interface BillingRow {
  seatsPurchased: number;
  subscriptionStatus: string | null;
  paddleSubscriptionId: string | null;
  paddleCustomerId: string | null;
  subscriptionCancelAt: Date | null;
}

const BILLING_SELECT = {
  seatsPurchased: true,
  subscriptionStatus: true,
  paddleSubscriptionId: true,
  paddleCustomerId: true,
  subscriptionCancelAt: true,
} as const;

function requirePaddleKey(): void {
  if (!(process.env.PADDLE_API_KEY ?? "").trim()) {
    throw new OrgError(
      503,
      "TEAM_BILLING_UNAVAILABLE",
      "Team billing is not available right now. Nothing was changed.",
    );
  }
}

function seatsInput(body: unknown): number {
  const seats = ((body ?? {}) as { seats?: unknown }).seats;
  if (
    typeof seats !== "number" ||
    !Number.isInteger(seats) ||
    seats < MIN_TEAM_SEATS ||
    seats > MAX_SELF_SERVE_SEATS
  ) {
    throw new OrgError(
      400,
      "INVALID_SEATS",
      `Choose ${MIN_TEAM_SEATS}–${MAX_SELF_SERVE_SEATS} seats. Larger teams: contact us.`,
    );
  }
  return seats;
}

const NO_SUBSCRIPTION = () =>
  new OrgError(409, "NO_SUBSCRIPTION", "This organization has no team subscription.");

const NOT_ACTIVE = () =>
  new OrgError(
    409,
    "SUBSCRIPTION_NOT_ACTIVE",
    "Seats can change only while the subscription is active. Whoever pays can fix the payment method in the billing portal.",
  );

const CANCEL_SCHEDULED = () =>
  new OrgError(
    409,
    "CANCEL_SCHEDULED",
    "The subscription is set to end. Keep it first, then change seats.",
  );

/** A Paddle call that failed: reported, and answered without Paddle's text. */
function providerError(err: unknown, orgId: string, step: string): OrgError {
  captureError(err, { tags: { scope: `org.billing.${step}` }, extra: { orgId } });
  return new OrgError(
    502,
    "BILLING_PROVIDER_ERROR",
    "Paddle didn't confirm the change, so it may not have gone through. Check again in a minute before you retry.",
  );
}

function readBilling(orgId: string): Promise<BillingRow> {
  return prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: BILLING_SELECT });
}

function billingInTx(tx: OrgTx, orgId: string): Promise<BillingRow> {
  return tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: BILLING_SELECT });
}

/** The subscription a seat change may act on: active or trialing, nothing scheduled. */
function seatTarget(org: BillingRow): string {
  if (!org.paddleSubscriptionId || !org.subscriptionStatus) throw NO_SUBSCRIPTION();
  if (!seatsActive(org.subscriptionStatus)) throw NOT_ACTIVE();
  if (org.subscriptionCancelAt) throw CANCEL_SCHEDULED();
  return org.paddleSubscriptionId;
}

async function assertMemberFloor(
  client: Pick<OrgTx, "orgMembership">,
  orgId: string,
  seats: number,
): Promise<void> {
  const members = await client.orgMembership.count({ where: { orgId } });
  if (seats < members) {
    throw new OrgError(
      409,
      "SEATS_BELOW_MEMBERS",
      `The organization has ${members} members. Remove members before you remove their seats.`,
    );
  }
}

/**
 * The live subscription's one seat item (price and quantity), read from
 * Paddle: it must still be active or trialing with nothing scheduled.
 */
async function liveSeatItem(subscriptionId: string, orgId: string) {
  let live: PaddleTeamSubscription;
  try {
    live = await getPaddleTeamSubscription(subscriptionId, CALL);
  } catch (err) {
    throw providerError(err, orgId, "read_subscription");
  }
  if (live.scheduledChange !== null) throw CANCEL_SCHEDULED();
  if (!seatsActive(live.status)) throw NOT_ACTIVE();
  const [item, ...rest] = live.items;
  if (!item?.priceId || item.quantity === null || rest.length > 0) {
    captureError(new Error("team subscription without exactly one seat item"), {
      tags: { scope: "org.billing.seat_item" },
      extra: { orgId, items: live.items.length },
    });
    throw new OrgError(
      409,
      "SEAT_CHANGE_UNSUPPORTED",
      "This subscription can't change seats here. Contact support.",
    );
  }
  return { priceId: item.priceId, quantity: item.quantity };
}

/**
 * Set the organization's seat count to `seats` (owner only). At least two,
 * at most 150, and never fewer than the members. Compared with what Paddle
 * bills now, not with the stored count (which waits for the webhook): no
 * update when Paddle already holds `seats`.
 */
export async function changeSeats(userId: string, body: unknown): Promise<SeatChangeResult> {
  const owner = await requireOwner(userId);
  const seats = seatsInput(body);
  const orgId = owner.orgId;
  const stored = await readBilling(orgId);
  const subscriptionId = seatTarget(stored);
  await assertMemberFloor(prisma, orgId, seats);
  requirePaddleKey();
  const item = await liveSeatItem(subscriptionId, orgId);
  if (item.quantity === seats) {
    return { status: stored.seatsPurchased === seats ? "unchanged" : "pending", seats };
  }
  return withOrgLock(orgId, async (tx) => {
    await ownerInTx(tx, userId, orgId);
    // What may have moved since the reads above: the subscription, a cancel,
    // a member who joined.
    if (seatTarget(await billingInTx(tx, orgId)) !== subscriptionId) throw NOT_ACTIVE();
    await assertMemberFloor(tx, orgId, seats);
    await recordOrgAudit(tx, {
      orgId,
      action: "billing.seats_change_requested",
      actorUserId: userId,
      detail: { from: item.quantity, to: seats },
    });
    try {
      await setPaddleSeatQuantity({ subscriptionId, priceId: item.priceId, quantity: seats }, CALL);
    } catch (err) {
      throw providerError(err, orgId, "set_seats");
    }
    return { status: "pending", seats };
  });
}

/** The subscription a period-end cancel may act on: billing, and not paused. */
function cancellable(org: BillingRow): string {
  if (!org.paddleSubscriptionId || !org.subscriptionStatus) throw NO_SUBSCRIPTION();
  if (org.subscriptionStatus === "canceled") throw NO_SUBSCRIPTION();
  if (org.subscriptionStatus === "paused") {
    throw new OrgError(
      409,
      "SUBSCRIPTION_PAUSED",
      "A paused subscription can only be ended from the billing portal.",
    );
  }
  return org.paddleSubscriptionId;
}

/** Ask Paddle to cancel at the period end; the date access stops, when Paddle says. */
async function scheduleCancel(subscriptionId: string, orgId: string): Promise<Date | null> {
  let effectiveAt: string | null;
  try {
    ({ effectiveAt } = await cancelPaddleSubscription(subscriptionId, CALL));
  } catch (err) {
    throw providerError(err, orgId, "cancel");
  }
  const parsed = effectiveAt ? new Date(effectiveAt) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
}

/**
 * Cancel the team subscription at the end of the period already paid for
 * (owner only). Seats stay until then. A second request answers the stored
 * date without asking Paddle again.
 */
export async function cancelTeamSubscription(userId: string): Promise<{ cancelAt: string | null }> {
  const owner = await requireOwner(userId);
  const orgId = owner.orgId;
  return withOrgLock(orgId, async (tx) => {
    await ownerInTx(tx, userId, orgId);
    const org = await billingInTx(tx, orgId);
    const subscriptionId = cancellable(org);
    if (org.subscriptionCancelAt) return { cancelAt: org.subscriptionCancelAt.toISOString() };
    requirePaddleKey();
    await recordOrgAudit(tx, {
      orgId,
      action: "billing.cancel_scheduled",
      actorUserId: userId,
      detail: { status: org.subscriptionStatus },
    });
    const cancelAt = await scheduleCancel(subscriptionId, orgId);
    if (cancelAt) {
      await tx.organization.update({
        where: { id: orgId },
        data: { subscriptionCancelAt: cancelAt },
        select: { id: true },
      });
    }
    return { cancelAt: cancelAt ? cancelAt.toISOString() : null };
  });
}

/**
 * Take back a scheduled cancel (owner only): billing resumes on the original
 * schedule. Paddle allows this on a past-due subscription too. With no cancel
 * stored, Paddle is asked: one made in the portal (or whose webhook is late)
 * is still taken back, and nothing to take back answers the same, so a retry
 * after a lost answer is not an error.
 */
export async function resumeTeamSubscription(userId: string): Promise<{ resumed: true }> {
  const owner = await requireOwner(userId);
  const orgId = owner.orgId;
  const stored = await readBilling(orgId);
  if (!stored.paddleSubscriptionId) throw NO_SUBSCRIPTION();
  if (!stored.subscriptionCancelAt) {
    requirePaddleKey();
    let live: PaddleTeamSubscription;
    try {
      live = await getPaddleTeamSubscription(stored.paddleSubscriptionId, CALL);
    } catch (err) {
      throw providerError(err, orgId, "read_subscription");
    }
    if (live.scheduledChange !== "cancel") return { resumed: true as const };
  }
  return withOrgLock(orgId, async (tx) => {
    await ownerInTx(tx, userId, orgId);
    const org = await billingInTx(tx, orgId);
    if (!org.paddleSubscriptionId) throw NO_SUBSCRIPTION();
    requirePaddleKey();
    await recordOrgAudit(tx, { orgId, action: "billing.cancel_removed", actorUserId: userId });
    try {
      await undoPaddleCancellation(org.paddleSubscriptionId, CALL);
    } catch (err) {
      throw providerError(err, orgId, "resume");
    }
    await tx.organization.update({
      where: { id: orgId },
      data: { subscriptionCancelAt: null },
      select: { id: true },
    });
    return { resumed: true as const };
  });
}

const PORTAL_PAYER_ONLY = () =>
  new OrgError(
    409,
    "PORTAL_PAYER_ONLY",
    "The billing portal opens only for the email address that pays for the team. That person can also use the link in Paddle's receipt emails.",
  );

function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Only Paddle's own portal host, over https, is handed to the client. */
function isPaddlePortalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && /(^|\.)paddle\.com$/.test(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * A Paddle customer-portal link (payment method, invoices) while the team
 * subscription still bills, for an owner whose verified Klorn email is the
 * Paddle customer's: the portal shows that person's whole Paddle account, so
 * a later owner, or an owner who did not pay, is refused. Reads only; no lock.
 */
export async function teamBillingPortal(userId: string): Promise<{ url: string }> {
  const owner = await requireOwner(userId);
  const orgId = owner.orgId;
  const org = await readBilling(orgId);
  const customerId = org.paddleCustomerId;
  if (!customerId || !org.paddleSubscriptionId || !subscriptionBills(org.subscriptionStatus)) {
    throw NO_SUBSCRIPTION();
  }
  requirePaddleKey();
  const email = await requireVerifiedEmail(userId);
  let payerEmail: string | null;
  try {
    payerEmail = await getPaddleCustomerEmail(customerId, CALL);
  } catch (err) {
    throw providerError(err, orgId, "read_customer");
  }
  if (!payerEmail || !sameEmail(payerEmail, email)) throw PORTAL_PAYER_ONLY();
  let url: string;
  try {
    url = await createPaddlePortalUrl(customerId, CALL);
  } catch (err) {
    throw providerError(err, orgId, "portal");
  }
  if (!isPaddlePortalUrl(url)) {
    throw providerError(new Error("Paddle portal url outside paddle.com"), orgId, "portal_url");
  }
  await recordOrgAudit(prisma, { orgId, action: "billing.portal_opened", actorUserId: userId });
  return { url };
}
