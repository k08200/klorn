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
 * The owner is the organization's billing admin: any owner can remove seats
 * (it lowers the charge; the member floor still holds) or cancel at the
 * period end. Adding seats charges the payer's card on file at once
 * (prorated) and taking a cancel back restarts billing on it, so only the
 * payer may do either, and only the payer opens the customer portal (the
 * payer's whole Paddle account: other subscriptions, invoices, address). The
 * payer is the owner the team checkout recorded (Organization.payerUserId,
 * stored by the webhook) or, failing that, the owner whose verified Klorn
 * email is the Paddle customer's email. Refused payer checks are audited by
 * reason class only, never an email.
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
  isPaddleErrorCode,
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
import { type OrgAuditAction, recordOrgAudit } from "./audit.js";
import { seatsActive, subscriptionBills } from "./effective-tier.js";
import { isOrgError, OrgError } from "./org-error.js";
import { type OrgTx, ownerInTx, requireVerifiedEmail, withOrgLock } from "./org-lock.js";
import { requireOwner } from "./org-members.js";
import { MAX_SELF_SERVE_SEATS, MIN_TEAM_SEATS } from "./org-shape.js";

/** One Paddle call under the lock: the 15 s transaction keeps ~9 s for the lock wait. */
const PADDLE_CALL_TIMEOUT_MS = 6_000;
const CALL = { timeoutMs: PADDLE_CALL_TIMEOUT_MS };

export type SeatChangeResult = { status: "pending" | "unchanged"; seats: number };

interface BillingRow {
  seatsPurchased: number;
  payerUserId: string | null;
  subscriptionStatus: string | null;
  paddleSubscriptionId: string | null;
  paddleCustomerId: string | null;
  subscriptionCancelAt: Date | null;
}

const BILLING_SELECT = {
  seatsPurchased: true,
  payerUserId: true,
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

/**
 * A Paddle call that failed before anything was asked to change (a read, or
 * a portal link): reported, and answered as "nothing was changed".
 */
function readError(err: unknown, orgId: string, step: string): OrgError {
  captureError(err, { tags: { scope: `org.billing.${step}` }, extra: { orgId } });
  return new OrgError(
    502,
    "BILLING_PROVIDER_READ_FAILED",
    "Paddle didn't answer, so nothing was changed. Try again in a minute.",
  );
}

/**
 * Paddle refuses any update to a subscription with a scheduled change pending
 * (developer.paddle.com/errors/subscriptions/subscription_locked_pending_changes).
 */
const PENDING_SCHEDULED_CHANGE = "subscription_locked_pending_changes";

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
    throw readError(err, orgId, "read_subscription");
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

const PORTAL_PAYER_ONLY = () =>
  new OrgError(
    409,
    "PORTAL_PAYER_ONLY",
    "The billing portal opens only for the person who pays for the team. They can also use the link in Paddle's receipt emails.",
  );

const SEATS_INCREASE_PAYER_ONLY = () =>
  new OrgError(
    403,
    "SEATS_INCREASE_PAYER_ONLY",
    "Only the person who pays for the team can add seats, because the card on file is charged right away. Ask them to add seats from their own Klorn account (Paddle's receipt emails go to them). Any owner can remove seats.",
  );

function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Why an owner failed the payer check: the class the audit log records, never an email. */
type PayerRefusalReason =
  | "email_not_verified"
  | "no_payer_on_record"
  | "no_payer_email"
  | "not_payer";

interface PayerRefusal {
  reason: PayerRefusalReason;
  error: OrgError;
}

/**
 * The payer check (seat increases, resume, billing portal). Callers have
 * already checked that `userId` is an owner (and re-check it under the lock
 * where they change anything). The owner the team checkout recorded is the
 * payer; otherwise the owner whose verified Klorn email is the Paddle
 * customer's email. Null when the owner pays; otherwise the reason and the
 * refusal to answer (`notPayer` unless the email is unverified).
 */
async function payerRefusal(
  userId: string,
  orgId: string,
  billing: Pick<BillingRow, "payerUserId" | "paddleCustomerId">,
  notPayer: () => OrgError,
): Promise<PayerRefusal | null> {
  if (billing.payerUserId !== null && billing.payerUserId === userId) return null;
  const customerId = billing.paddleCustomerId;
  if (!customerId) return { reason: "no_payer_on_record", error: notPayer() };
  let email: string;
  try {
    email = await requireVerifiedEmail(userId);
  } catch (err) {
    if (isOrgError(err) && err.code === "EMAIL_NOT_VERIFIED") {
      return { reason: "email_not_verified", error: err };
    }
    throw err;
  }
  let payerEmail: string | null;
  try {
    payerEmail = await getPaddleCustomerEmail(customerId, CALL);
  } catch (err) {
    throw readError(err, orgId, "read_customer");
  }
  if (!payerEmail) return { reason: "no_payer_email", error: notPayer() };
  return sameEmail(payerEmail, email) ? null : { reason: "not_payer", error: notPayer() };
}

/**
 * Audit a refused payer check, then refuse. A failed audit write is reported
 * and never turns the refusal into a success.
 */
async function refuseAudited(
  orgId: string,
  userId: string,
  action: OrgAuditAction,
  refusal: PayerRefusal,
  detail: Record<string, number> = {},
): Promise<never> {
  try {
    await recordOrgAudit(prisma, {
      orgId,
      action,
      actorUserId: userId,
      detail: { ...detail, reason: refusal.reason },
    });
  } catch (err) {
    captureError(err, { tags: { scope: "org.billing.audit_refusal" }, extra: { orgId, action } });
  }
  throw refusal.error;
}

/** Refuse an increase unless the owner is the payer; the refusal is audited. */
async function requirePayerForIncrease(
  userId: string,
  orgId: string,
  billing: BillingRow,
  change: { from: number; to: number },
): Promise<void> {
  const refusal = await payerRefusal(userId, orgId, billing, SEATS_INCREASE_PAYER_ONLY);
  if (refusal)
    await refuseAudited(orgId, userId, "billing.seats_increase_refused", refusal, change);
}

const SEATS_CHANGE_ACTION = "billing.seats_change_requested" satisfies OrgAuditAction;

/** The newest seat change requested through Klorn, or null: a mark taken before the live read. */
type SeatChangeMark = { id: string; createdAt: Date } | null;

function lastSeatChange(orgId: string): Promise<SeatChangeMark> {
  return prisma.orgAuditEvent.findFirst({
    where: { orgId, action: SEATS_CHANGE_ACTION },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, createdAt: true },
  });
}

const SEATS_CHANGED = () =>
  new OrgError(
    409,
    "SEATS_CHANGED",
    "The seat count changed while this request was waiting. Check the count and try again.",
  );

/**
 * Under the lock: a seat change committed since `mark` (its audit row is
 * written in the same transaction as its Paddle call) means the live quantity
 * read before the lock is stale, and with it the increase-or-decrease call —
 * so two concurrent decreases cannot add up to an unchecked increase.
 */
async function assertNoSeatChangeSince(
  tx: OrgTx,
  orgId: string,
  mark: SeatChangeMark,
): Promise<void> {
  const since = mark
    ? {
        OR: [
          { createdAt: { gt: mark.createdAt } },
          { createdAt: mark.createdAt, id: { not: mark.id } },
        ],
      }
    : {};
  const newer = await tx.orgAuditEvent.findFirst({
    where: { orgId, action: SEATS_CHANGE_ACTION, ...since },
    select: { id: true },
  });
  if (newer) throw SEATS_CHANGED();
}

interface SeatChange {
  userId: string;
  orgId: string;
  subscriptionId: string;
  item: { priceId: string; quantity: number };
  seats: number;
  mark: SeatChangeMark;
}

/** The locked part of a seat change: re-check what may have moved, audit, one Paddle call. */
async function applySeatChange(tx: OrgTx, change: SeatChange): Promise<SeatChangeResult> {
  const { userId, orgId, subscriptionId, item, seats } = change;
  await ownerInTx(tx, userId, orgId);
  // What may have moved since the reads before the lock: the subscription, a
  // cancel, a member who joined, another seat change.
  if (seatTarget(await billingInTx(tx, orgId)) !== subscriptionId) throw NOT_ACTIVE();
  await assertMemberFloor(tx, orgId, seats);
  await assertNoSeatChangeSince(tx, orgId, change.mark);
  await recordOrgAudit(tx, {
    orgId,
    action: SEATS_CHANGE_ACTION,
    actorUserId: userId,
    detail: { from: item.quantity, to: seats },
  });
  try {
    await setPaddleSeatQuantity({ subscriptionId, priceId: item.priceId, quantity: seats }, CALL);
  } catch (err) {
    // A cancel made in the portal after the live read: Paddle refuses the
    // update while it is pending, so the change itself is the last check. An
    // expected refusal, not a provider fault (no report).
    if (isPaddleErrorCode(err, PENDING_SCHEDULED_CHANGE)) throw CANCEL_SCHEDULED();
    throw providerError(err, orgId, "set_seats");
  }
  return { status: "pending", seats };
}

/**
 * Set the organization's seat count to `seats` (owner only). At least two,
 * at most 150, and never fewer than the members. Compared with what Paddle
 * bills now, not with the stored count (which waits for the webhook): no
 * update when Paddle already holds `seats`. Adding seats takes the payer;
 * removing them takes any owner.
 */
export async function changeSeats(userId: string, body: unknown): Promise<SeatChangeResult> {
  const owner = await requireOwner(userId);
  const seats = seatsInput(body);
  const orgId = owner.orgId;
  const stored = await readBilling(orgId);
  const subscriptionId = seatTarget(stored);
  await assertMemberFloor(prisma, orgId, seats);
  requirePaddleKey();
  const mark = await lastSeatChange(orgId);
  const item = await liveSeatItem(subscriptionId, orgId);
  if (item.quantity === seats) {
    return { status: stored.seatsPurchased === seats ? "unchanged" : "pending", seats };
  }
  if (seats > item.quantity) {
    await requirePayerForIncrease(userId, orgId, stored, {
      from: item.quantity,
      to: seats,
    });
  }
  return withOrgLock(orgId, (tx) =>
    applySeatChange(tx, { userId, orgId, subscriptionId, item, seats, mark }),
  );
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

const RESUME_PAYER_ONLY = () =>
  new OrgError(
    403,
    "RESUME_PAYER_ONLY",
    "Keeping the subscription restarts billing on the payer's card, so only the person who pays for the team can do it. Ask them to keep it from their own Klorn account (Paddle's receipt emails go to them).",
  );

/**
 * Take back a scheduled cancel (the payer only: it restarts billing on their
 * card): billing resumes on the original schedule. Paddle allows this on a past-due subscription too. With no cancel
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
      throw readError(err, orgId, "read_subscription");
    }
    if (live.scheduledChange !== "cancel") return { resumed: true as const };
  }
  requirePaddleKey();
  const refusal = await payerRefusal(userId, orgId, stored, RESUME_PAYER_ONLY);
  if (refusal) await refuseAudited(orgId, userId, "billing.resume_refused", refusal);
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
 * a later owner, or an owner who did not pay, is refused (and audited by
 * reason class). Reads only; no lock.
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
  const refusal = await payerRefusal(userId, orgId, org, PORTAL_PAYER_ONLY);
  if (refusal) await refuseAudited(orgId, userId, "billing.portal_refused", refusal);
  let url: string;
  try {
    url = await createPaddlePortalUrl(customerId, CALL);
  } catch (err) {
    throw readError(err, orgId, "portal");
  }
  if (!isPaddlePortalUrl(url)) {
    throw readError(new Error("Paddle portal url outside paddle.com"), orgId, "portal_url");
  }
  await recordOrgAudit(prisma, { orgId, action: "billing.portal_opened", actorUserId: userId });
  return { url };
}
