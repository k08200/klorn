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
 * Each change runs under the organization's lock, so two of them for one
 * organization are serialized and a seat change sees the member count it is
 * checked against. The Paddle calls inside the lock are time-bounded to fit
 * the interactive transaction's 15 s timeout (INTERACTIVE_TX_OPTIONS).
 * The audit row is written before the Paddle call in the same transaction, so
 * a refused or timed-out call leaves no row behind; a seat change is "set the
 * count to N", so retrying one whose answer was lost is safe.
 *
 * Status rules, from Paddle's API: a past_due subscription cannot be updated
 * (seat changes need active or trialing), but can be canceled at the period
 * end, after which it stays past_due until the period ends; a paused one can
 * only be canceled immediately, which this route does not do (the portal
 * can). An organization whose subscription still bills is never closed or
 * deleted (subscriptionBills, effective-tier.ts) — a scheduled cancel does
 * not change that until Paddle reports the subscription canceled.
 */

import {
  cancelPaddleSubscription,
  createPaddlePortalUrl,
  undoPaddleCancellation,
} from "../billing/paddle.js";
import {
  getPaddleTeamSubscription,
  type PaddleTeamSubscription,
  setPaddleSeatQuantity,
} from "../billing/paddle-team.js";
import { captureError } from "../sentry.js";
import { recordOrgAudit } from "./audit.js";
import { seatsActive } from "./effective-tier.js";
import { OrgError } from "./org-error.js";
import { type OrgTx, ownerInTx, withOrgLock } from "./org-lock.js";
import { requireOwner } from "./org-members.js";
import { MAX_SELF_SERVE_SEATS, MIN_TEAM_SEATS } from "./org-shape.js";

/** Two calls (read, then update) must finish inside the 15 s transaction. */
const PADDLE_CALL_TIMEOUT_MS = 6_000;
const CALL = { timeoutMs: PADDLE_CALL_TIMEOUT_MS };

export type SeatChangeResult = { status: "pending" | "unchanged"; seats: number };

interface BillingRow {
  seatsPurchased: number;
  subscriptionStatus: string | null;
  paddleSubscriptionId: string | null;
  paddleCustomerId: string | null;
  subscriptionCancelAt: Date | null;
  billingUserId: string | null;
}

const BILLING_SELECT = {
  seatsPurchased: true,
  subscriptionStatus: true,
  paddleSubscriptionId: true,
  paddleCustomerId: true,
  subscriptionCancelAt: true,
  billingUserId: true,
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
    "Seats can change only while the subscription is active. Update the payment method first.",
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
    "Paddle did not confirm the change. Nothing was changed here; try again shortly.",
  );
}

function billingInTx(tx: OrgTx, orgId: string): Promise<BillingRow> {
  return tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: BILLING_SELECT });
}

/** The stored subscription a seat change may act on, checked against the members. */
async function storedSeatTarget(tx: OrgTx, orgId: string, seats: number) {
  const org = await billingInTx(tx, orgId);
  if (!org.paddleSubscriptionId || !org.subscriptionStatus) throw NO_SUBSCRIPTION();
  if (!seatsActive(org.subscriptionStatus)) throw NOT_ACTIVE();
  if (org.subscriptionCancelAt) throw CANCEL_SCHEDULED();
  const members = await tx.orgMembership.count({ where: { orgId } });
  if (seats < members) {
    throw new OrgError(
      409,
      "SEATS_BELOW_MEMBERS",
      `The organization has ${members} members. Remove members before you remove their seats.`,
    );
  }
  return { subscriptionId: org.paddleSubscriptionId, purchased: org.seatsPurchased };
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
 * at most 150, and never fewer than the members. No Paddle call when the
 * count is already bought; no second update when Paddle already holds it.
 */
export async function changeSeats(userId: string, body: unknown): Promise<SeatChangeResult> {
  const seats = seatsInput(body);
  const owner = await requireOwner(userId);
  const orgId = owner.orgId;
  return withOrgLock(orgId, async (tx) => {
    await ownerInTx(tx, userId, orgId);
    const target = await storedSeatTarget(tx, orgId, seats);
    if (seats === target.purchased) return { status: "unchanged", seats };
    requirePaddleKey();
    const item = await liveSeatItem(target.subscriptionId, orgId);
    // Paddle already holds this count (an earlier request whose webhook has
    // not arrived yet): nothing to send.
    if (item.quantity === seats) return { status: "pending", seats };
    await recordOrgAudit(tx, {
      orgId,
      action: "billing.seats_change_requested",
      actorUserId: userId,
      detail: { from: target.purchased, to: seats },
    });
    try {
      await setPaddleSeatQuantity(
        { subscriptionId: target.subscriptionId, priceId: item.priceId, quantity: seats },
        CALL,
      );
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

/** Take back a scheduled cancel (owner only): billing resumes on the original schedule. */
export async function resumeTeamSubscription(userId: string): Promise<{ resumed: true }> {
  const owner = await requireOwner(userId);
  const orgId = owner.orgId;
  return withOrgLock(orgId, async (tx) => {
    await ownerInTx(tx, userId, orgId);
    const org = await billingInTx(tx, orgId);
    if (!org.paddleSubscriptionId || !org.subscriptionCancelAt) {
      throw new OrgError(409, "NO_SCHEDULED_CANCEL", "No cancel is scheduled.");
    }
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

/**
 * A Paddle customer-portal link (payment method, invoices) for the owner who
 * set up billing. The portal is the payer's whole Paddle account, so a later
 * owner is refused rather than shown it.
 */
export async function teamBillingPortal(userId: string): Promise<{ url: string }> {
  const owner = await requireOwner(userId);
  const orgId = owner.orgId;
  return withOrgLock(orgId, async (tx) => {
    await ownerInTx(tx, userId, orgId);
    const org = await billingInTx(tx, orgId);
    if (!org.paddleCustomerId) throw NO_SUBSCRIPTION();
    if (org.billingUserId !== userId) {
      throw new OrgError(
        409,
        "PORTAL_PAYER_ONLY",
        "Only the person who set up team billing can open the billing portal. Seats and cancel work here.",
      );
    }
    requirePaddleKey();
    await recordOrgAudit(tx, { orgId, action: "billing.portal_opened", actorUserId: userId });
    try {
      return { url: await createPaddlePortalUrl(org.paddleCustomerId, CALL) };
    } catch (err) {
      throw providerError(err, orgId, "portal");
    }
  });
}
