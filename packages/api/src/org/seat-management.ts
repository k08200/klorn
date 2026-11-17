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
 * (INTERACTIVE_TX_OPTIONS). The seat change's audit row is committed under
 * the lock before that call and taken back if Paddle refuses, so a refused
 * call leaves no row behind (seat-change-audit.ts). A call that times out may
 * still have reached Paddle; the answer says so, the audit log keeps it as
 * unconfirmed, and a seat change is "set the count to N", so retrying it is
 * safe.
 *
 * The owner is the organization's billing admin: any owner can remove seats
 * (it lowers the charge; the member floor still holds) or cancel at the
 * period end. Adding seats charges the subscription's payment method at
 * once (prorated) and taking a cancel back restarts billing on it, so only
 * the payer may do either: the owner the team checkout recorded
 * (Organization.payerUserId, stored by the webhook) or, failing that, the
 * owner whose verified Klorn email is the Paddle customer's email. A recorded
 * payer whose email is not Paddle's adds seats only up to
 * recordedPayerSeatCap. The owner who scheduled the pending cancel through
 * Klorn may also take back that cancel; a cancel made in the portal takes the
 * paying email to undo. The customer portal is the Paddle
 * customer's whole account (other subscriptions, invoices, address), so it
 * takes the email match only. Refused payer checks are audited by reason
 * class only, never an email.
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
import { classifyFailure } from "../public-failure.js";
import { captureDbFailure } from "../report-db-failure.js";
import { captureError } from "../sentry.js";
import { type OrgAuditAction, recordOrgAudit } from "./audit.js";
import { seatsActive, subscriptionBills } from "./effective-tier.js";
import { isOrgError, OrgError } from "./org-error.js";
import { type OrgTx, ownerInTx, requireVerifiedEmail, withOrgLock } from "./org-lock.js";
import { requireOwner } from "./org-members.js";
import { MAX_SELF_SERVE_SEATS, MIN_TEAM_SEATS } from "./org-shape.js";
import { recordedPayerSeatCap } from "./seat-cap.js";
import {
  assertNoSeatChangeSince,
  type LiveRead,
  lastSeatChange,
  type PayerBasis,
  paddleRefused,
  recordSeatChangeRequest,
  recordSeatChangeUnconfirmed,
  SEAT_CHANGE_CALL_TIMEOUT_MS,
  type SeatChangeAttempt,
  withdrawSeatChangeRequest,
} from "./seat-change-audit.js";

const CALL = { timeoutMs: SEAT_CHANGE_CALL_TIMEOUT_MS };

export type SeatChangeResult = { status: "pending" | "unchanged"; seats: number };

export interface BillingRow {
  seatsPurchased: number;
  payerUserId: string | null;
  seatsAtAttach: number | null;
  subscriptionStatus: string | null;
  paddleSubscriptionId: string | null;
  paddleCustomerId: string | null;
  subscriptionCancelAt: Date | null;
  cancelRequestedByUserId: string | null;
}

export const BILLING_SELECT = {
  seatsPurchased: true,
  payerUserId: true,
  seatsAtAttach: true,
  subscriptionStatus: true,
  paddleSubscriptionId: true,
  paddleCustomerId: true,
  subscriptionCancelAt: true,
  cancelRequestedByUserId: true,
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
  captureDbFailure("[ORG] Paddle read failed", err, {
    tags: { scope: `org.billing.${step}` },
    extra: { orgId },
  });
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
  captureDbFailure("[ORG] Paddle call failed", err, {
    tags: { scope: `org.billing.${step}` },
    extra: { orgId },
  });
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
    "The billing portal opens only for the email address that pays for the team. That person can also use the link in Paddle's receipt emails.",
  );

const SEATS_INCREASE_PAYER_ONLY = () =>
  new OrgError(
    403,
    "SEATS_INCREASE_PAYER_ONLY",
    "Only the person who pays for the team can add seats, because the card on file is charged right away. Ask them to add seats from their own Klorn account (Paddle's receipt emails go to them). Any owner can remove seats.",
  );

const SEATS_INCREASE_CAPPED = (from: number, cap: number) =>
  new OrgError(
    403,
    "SEATS_INCREASE_CAPPED",
    cap > from
      ? `Without the email address that pays for the team, you can set at most ${cap} seats in this change. The person whose email pays can add more from their own Klorn account.`
      : "Without the email address that pays for the team, you can't add seats now. The person whose email pays can add more from their own Klorn account.",
  );

export function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Why an owner failed the payer check: the class the audit log records, never an email. */
type PayerRefusalReason =
  | "email_not_verified"
  | "no_payer_on_record"
  | "no_payer_email"
  | "not_payer"
  | "recorded_payer_cap"
  | "recorded_payer_portal_cancel";

interface PayerRefusal {
  reason: PayerRefusalReason;
  error: OrgError;
}

/**
 * The owner the team checkout recorded as its buyer (Organization.payerUserId).
 * Callers have already checked that `userId` is an owner (and re-check it
 * under the lock). Enough for a seat increase or a resume, which act on the
 * subscription's own payment method; never for the billing portal, which is
 * the Paddle customer's whole account — and the customer is whoever's email
 * was typed at checkout, which Klorn does not bind to the buyer.
 */
function isRecordedPayer(userId: string, billing: Pick<BillingRow, "payerUserId">): boolean {
  return billing.payerUserId !== null && billing.payerUserId === userId;
}

/**
 * The email payer check: the owner's verified Klorn email is the Paddle
 * customer's email. Null when it is; otherwise the reason and the refusal to
 * answer (`notPayer` unless the email is unverified).
 */
async function emailPayerRefusal(
  userId: string,
  orgId: string,
  customerId: string | null,
  notPayer: () => OrgError,
): Promise<PayerRefusal | null> {
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
    captureDbFailure("[ORG] audit of a refused billing change failed", err, {
      tags: { scope: "org.billing.audit_refusal" },
      extra: { orgId, action },
    });
  }
  throw refusal.error;
}

/**
 * The payer check for a change billed to the subscription's payment method
 * (seat increase, resume): the recorded payer, else the email payer. Answers
 * how it passed; a refusal is audited (reason class only) and thrown.
 */
async function requirePayer(
  userId: string,
  orgId: string,
  billing: BillingRow,
  refused: { action: OrgAuditAction; notPayer: () => OrgError; detail?: Record<string, number> },
): Promise<PayerBasis> {
  if (isRecordedPayer(userId, billing)) return "recorded";
  const refusal = await emailPayerRefusal(
    userId,
    orgId,
    billing.paddleCustomerId,
    refused.notPayer,
  );
  if (refusal) await refuseAudited(orgId, userId, refused.action, refusal, refused.detail);
  return "email";
}

/**
 * The email payer check for a recorded payer whose recorded status is not
 * enough (a seat increase past the cap, the undo of a portal cancel): passes
 * as "email", or audits `reason` (the class, never an email) and refuses.
 */
async function requireEmailOverRecorded(
  userId: string,
  orgId: string,
  billing: BillingRow,
  refused: {
    action: OrgAuditAction;
    reason: PayerRefusalReason;
    error: () => OrgError;
    detail?: Record<string, number>;
  },
): Promise<"email"> {
  const refusal = await emailPayerRefusal(userId, orgId, billing.paddleCustomerId, refused.error);
  if (refusal) {
    await refuseAudited(
      orgId,
      userId,
      refused.action,
      { reason: refused.reason, error: refused.error() },
      refused.detail,
    );
  }
  return "email";
}

/**
 * The payer check for adding seats: the payer (requirePayer), and for a
 * recorded payer past recordedPayerSeatCap, the paying email too. Answers how
 * it passed; a refusal is audited (reason class and counts only) and thrown.
 */
async function requireIncreasePayer(
  userId: string,
  orgId: string,
  billing: BillingRow,
  from: number,
  to: number,
): Promise<PayerBasis> {
  const action = "billing.seats_increase_refused";
  const basis = await requirePayer(userId, orgId, billing, {
    action,
    notPayer: SEATS_INCREASE_PAYER_ONLY,
    detail: { from, to },
  });
  const cap = recordedPayerSeatCap(from, billing.seatsAtAttach);
  if (basis !== "recorded" || to <= cap) return basis;
  return requireEmailOverRecorded(userId, orgId, billing, {
    action,
    reason: "recorded_payer_cap",
    error: () => SEATS_INCREASE_CAPPED(from, cap),
    detail: { from, to, cap },
  });
}

interface SeatChange {
  subscriptionId: string;
  priceId: string;
  read: LiveRead;
  attempt: SeatChangeAttempt;
}

/** The locked part of a seat change: re-check what may have moved, audit, one Paddle call. */
async function applySeatChange(tx: OrgTx, change: SeatChange): Promise<SeatChangeResult> {
  const { subscriptionId, priceId, attempt } = change;
  const { actorUserId: userId, orgId, to: seats } = attempt;
  await ownerInTx(tx, userId, orgId);
  // What may have moved since the reads before the lock: the subscription, a
  // cancel, a member who joined, another seat change.
  if (seatTarget(await billingInTx(tx, orgId)) !== subscriptionId) throw NOT_ACTIVE();
  await assertMemberFloor(tx, orgId, seats);
  await assertNoSeatChangeSince(tx, orgId, change.read);
  const requestId = await recordSeatChangeRequest(attempt);
  try {
    await setPaddleSeatQuantity({ subscriptionId, priceId, quantity: seats }, CALL);
  } catch (err) {
    // A cancel made in the portal after the live read: Paddle refuses the
    // update while it is pending, so the change itself is the last check. An
    // expected refusal, not a provider fault (no report).
    const pendingCancel = isPaddleErrorCode(err, PENDING_SCHEDULED_CHANGE);
    if (pendingCancel || paddleRefused(err)) {
      await withdrawSeatChangeRequest(requestId, orgId);
      throw pendingCancel ? CANCEL_SCHEDULED() : providerError(err, orgId, "set_seats");
    }
    // No answer, or a Paddle fault: the new count may be live. The request
    // stays on record, with why it is unconfirmed.
    const answer = providerError(err, orgId, "set_seats");
    await recordSeatChangeUnconfirmed(attempt, classifyFailure(err));
    throw answer;
  }
  return { status: "pending", seats };
}

/**
 * Set the organization's seat count to `seats` (owner only). At least two,
 * at most 150, and never fewer than the members. Compared with what Paddle
 * bills now, not with the stored count (which waits for the webhook): no
 * update when Paddle already holds `seats`. Adding seats takes the payer
 * (capped for a recorded payer without the paying email); removing them takes
 * any owner.
 */
export async function changeSeats(userId: string, body: unknown): Promise<SeatChangeResult> {
  const owner = await requireOwner(userId);
  const seats = seatsInput(body);
  const orgId = owner.orgId;
  const stored = await readBilling(orgId);
  const subscriptionId = seatTarget(stored);
  await assertMemberFloor(prisma, orgId, seats);
  requirePaddleKey();
  const read: LiveRead = { startedAt: new Date(), mark: await lastSeatChange(orgId) };
  const item = await liveSeatItem(subscriptionId, orgId);
  if (item.quantity === seats) {
    return { status: stored.seatsPurchased === seats ? "unchanged" : "pending", seats };
  }
  const payer =
    seats > item.quantity
      ? await requireIncreasePayer(userId, orgId, stored, item.quantity, seats)
      : null;
  const attempt: SeatChangeAttempt = {
    orgId,
    actorUserId: userId,
    from: item.quantity,
    to: seats,
    payer,
  };
  const change: SeatChange = { subscriptionId, priceId: item.priceId, read, attempt };
  return withOrgLock(orgId, (tx) => applySeatChange(tx, change));
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

function parseDate(value: string | null): Date | null {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
}

/** Ask Paddle to cancel at the period end; the date access stops, when Paddle says. */
async function scheduleCancel(subscriptionId: string, orgId: string): Promise<Date | null> {
  let effectiveAt: string | null;
  try {
    ({ effectiveAt } = await cancelPaddleSubscription(subscriptionId, CALL));
  } catch (err) {
    throw providerError(err, orgId, "cancel");
  }
  return parseDate(effectiveAt);
}

/**
 * A cancel already pending in Paddle (made in the portal, its webhook on the
 * way), with its date when Paddle gives one; null when none is.
 */
async function pendingCancel(
  subscriptionId: string,
  orgId: string,
): Promise<{ at: Date | null } | null> {
  let live: PaddleTeamSubscription;
  try {
    live = await getPaddleTeamSubscription(subscriptionId, CALL);
  } catch (err) {
    throw readError(err, orgId, "read_subscription");
  }
  return live.scheduledChange === "cancel" ? { at: parseDate(live.cancelEffectiveAt) } : null;
}

/**
 * Cancel the team subscription at the end of the period already paid for
 * (owner only). Seats stay until then. A second request answers the stored
 * date without asking Paddle again. Paddle is read first: a cancel already
 * pending there (made in the portal) is stored as it is, with no Klorn actor,
 * and not sent again. A cancel Klorn sends records the owner who asked, and
 * when, so that owner can take back this cancel (resumeTeamSubscription).
 */
export async function cancelTeamSubscription(userId: string): Promise<{ cancelAt: string | null }> {
  const owner = await requireOwner(userId);
  const orgId = owner.orgId;
  const stored = await readBilling(orgId);
  const subscriptionId = cancellable(stored);
  if (stored.subscriptionCancelAt) return { cancelAt: stored.subscriptionCancelAt.toISOString() };
  requirePaddleKey();
  const pending = await pendingCancel(subscriptionId, orgId);
  return withOrgLock(orgId, async (tx) => {
    await ownerInTx(tx, userId, orgId);
    const org = await billingInTx(tx, orgId);
    if (cancellable(org) !== subscriptionId) throw NO_SUBSCRIPTION();
    if (org.subscriptionCancelAt) return { cancelAt: org.subscriptionCancelAt.toISOString() };
    const cancelAt = pending
      ? pending.at
      : await sendCancel(tx, { userId, orgId, subscriptionId, status: org.subscriptionStatus });
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
 * Under the lock: audit, record the owner who asked and when (taken before
 * the call, so every event Paddle sends for this cancel is later), then the
 * one Paddle call. A refused call rolls all of it back.
 */
async function sendCancel(
  tx: OrgTx,
  cancel: { userId: string; orgId: string; subscriptionId: string; status: string | null },
): Promise<Date | null> {
  const { userId, orgId } = cancel;
  await recordOrgAudit(tx, {
    orgId,
    action: "billing.cancel_scheduled",
    actorUserId: userId,
    detail: { status: cancel.status },
  });
  await tx.organization.update({
    where: { id: orgId },
    data: { cancelRequestedByUserId: userId, cancelRequestedAt: new Date() },
    select: { id: true },
  });
  return scheduleCancel(cancel.subscriptionId, orgId);
}

const RESUME_PAYER_ONLY = () =>
  new OrgError(
    403,
    "RESUME_PAYER_ONLY",
    "Keeping the subscription restarts billing on the payer's card, so only the person who pays for the team, or the owner who set it to end in Klorn, can do it. Ask the payer to keep it from their own Klorn account (Paddle's receipt emails go to them).",
  );

/** How an owner may take a cancel back: as the payer, or as the owner who scheduled it in Klorn. */
type ResumeBasis = PayerBasis | "canceler";

/**
 * Who may take back the pending cancel. The owner who scheduled it through
 * Klorn (its stored actor) takes back their own decision. The recorded payer
 * may take back a cancel scheduled through Klorn. A cancel made in Paddle's
 * portal (no Klorn actor) is the Paddle customer's own decision — only the
 * paying email reaches the portal — so undoing it takes the paying email,
 * recorded payer or not: the recorded payer may not be the card holder.
 */
function resumeBasis(userId: string, orgId: string, stored: BillingRow): Promise<ResumeBasis> {
  if (stored.cancelRequestedByUserId === userId) return Promise.resolve("canceler");
  const action = "billing.resume_refused";
  if (!isRecordedPayer(userId, stored)) {
    return requirePayer(userId, orgId, stored, { action, notPayer: RESUME_PAYER_ONLY });
  }
  if (stored.cancelRequestedByUserId !== null) return Promise.resolve("recorded");
  return requireEmailOverRecorded(userId, orgId, stored, {
    action,
    reason: "recorded_payer_portal_cancel",
    error: RESUME_PAYER_ONLY,
  });
}

/**
 * Under the lock: a resume that passed on the Klorn cancel's actor (as that
 * actor, or as the recorded payer) needs that Klorn cancel still pending — not
 * removed, or replaced by a portal cancel, meanwhile.
 */
function assertResumeStillHolds(basis: ResumeBasis, org: BillingRow, userId: string): void {
  if (basis === "canceler" && org.cancelRequestedByUserId !== userId) throw RESUME_PAYER_ONLY();
  if (basis === "recorded" && org.cancelRequestedByUserId === null) throw RESUME_PAYER_ONLY();
}

/**
 * Take back a scheduled cancel: billing resumes on the original schedule, on
 * the payer's card, so it takes the payer or the owner who scheduled this
 * cancel through Klorn, and a cancel made in the portal takes the paying
 * email (resumeBasis; re-checked under the lock: an actor forgotten
 * meanwhile, because the cancel was removed or replaced in Paddle, no longer
 * holds). Paddle allows this on a past-due subscription too. With no cancel
 * stored, Paddle is asked: one made in the portal (or whose webhook is late)
 * is still taken back, and nothing to take back answers the same (no payer
 * check: nothing changes), so a retry after a lost answer is not an error.
 */
export async function resumeTeamSubscription(userId: string): Promise<{ resumed: true }> {
  const owner = await requireOwner(userId);
  const orgId = owner.orgId;
  const stored = await readBilling(orgId);
  if (!stored.paddleSubscriptionId) throw NO_SUBSCRIPTION();
  requirePaddleKey();
  if (!stored.subscriptionCancelAt) {
    let live: PaddleTeamSubscription;
    try {
      live = await getPaddleTeamSubscription(stored.paddleSubscriptionId, CALL);
    } catch (err) {
      throw readError(err, orgId, "read_subscription");
    }
    if (live.scheduledChange !== "cancel") return { resumed: true as const };
  }
  const basis = await resumeBasis(userId, orgId, stored);
  return withOrgLock(orgId, async (tx) => {
    await ownerInTx(tx, userId, orgId);
    const org = await billingInTx(tx, orgId);
    // The check above was for this subscription: one that ended and was
    // replaced meanwhile (another payer) is not taken back on its strength.
    if (!org.paddleSubscriptionId || org.paddleSubscriptionId !== stored.paddleSubscriptionId) {
      throw NO_SUBSCRIPTION();
    }
    assertResumeStillHolds(basis, org, userId);
    await recordOrgAudit(tx, {
      orgId,
      action: "billing.cancel_removed",
      actorUserId: userId,
      detail: basis === "canceler" ? { via: "canceler" } : { payer: basis },
    });
    try {
      await undoPaddleCancellation(org.paddleSubscriptionId, CALL);
    } catch (err) {
      throw providerError(err, orgId, "resume");
    }
    await tx.organization.update({
      where: { id: orgId },
      data: { subscriptionCancelAt: null, cancelRequestedByUserId: null, cancelRequestedAt: null },
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
  // Email only, never the recorded payer (see isRecordedPayer).
  const refusal = await emailPayerRefusal(userId, orgId, customerId, PORTAL_PAYER_ONLY);
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
