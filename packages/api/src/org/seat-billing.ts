/**
 * Klorn Teams seat billing (scaffold): the owner opens a quantity-based
 * Paddle checkout for the organization, and the Paddle webhook writes the
 * organization's seats and subscription state. Seat entitlement is then
 * derived from membership at read time (effective-tier.ts) — nothing here
 * ever writes User.plan.
 *
 * Seat changes after purchase (adding or removing seats) are not built yet:
 * see the proration notes in the PR that added this file.
 */

import type { Prisma } from "@prisma/client";
import {
  createPaddleTeamCheckout,
  hasTeamPrice,
  isTeamSubscriptionEvent,
  TEAM_SEATS_KIND,
  type TeamInterval,
  type TeamSubscriptionData,
  teamBillingInterval,
  teamCheckoutIntervals,
  teamPriceIdFor,
  teamSeatQuantity,
} from "../billing/paddle-team.js";
import { prisma } from "../db.js";
import { captureError } from "../sentry.js";
import { recordOrgAudit } from "./audit.js";
import { subscriptionBills } from "./effective-tier.js";
import { OrgError } from "./org-error.js";
import { withOrgLock } from "./org-lock.js";
import { requireOwner } from "./org-members.js";
import { MAX_SELF_SERVE_SEATS, MIN_TEAM_SEATS } from "./org-shape.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkoutInput(body: unknown): { interval: TeamInterval; seats: number } {
  const input = (body ?? {}) as { interval?: unknown; seats?: unknown };
  if (input.interval !== "month" && input.interval !== "year") {
    throw new OrgError(400, "INVALID_BODY", "interval must be month or year.");
  }
  const seats = input.seats;
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
  return { interval: input.interval, seats };
}

export async function startTeamCheckout(userId: string, body: unknown): Promise<{ url: string }> {
  const { interval, seats } = checkoutInput(body);
  const owner = await requireOwner(userId);
  const priceId = teamPriceIdFor(interval);
  if (!priceId || !teamCheckoutIntervals().includes(interval)) {
    throw new OrgError(
      503,
      "TEAM_CHECKOUT_UNAVAILABLE",
      "Team billing is not available yet. Nothing was charged.",
    );
  }
  if (owner.org.paddleSubscriptionId && subscriptionBills(owner.org.subscriptionStatus)) {
    throw new OrgError(
      409,
      "SUBSCRIPTION_ACTIVE",
      "This organization already has a team subscription.",
    );
  }
  const url = await createPaddleTeamCheckout({ orgId: owner.orgId, priceId, quantity: seats });
  await recordOrgAudit(prisma, {
    orgId: owner.orgId,
    action: "billing.checkout_started",
    actorUserId: userId,
    detail: { interval, seats },
  });
  return { url };
}

export interface TeamSubscriptionEvent {
  eventId: string;
  occurredAt?: string;
  data: TeamSubscriptionData;
}

export type TeamEventOutcome = "applied" | "stale" | "unmapped" | "refused";

function report(message: string, eventId: string): void {
  captureError(new Error(message), {
    tags: { scope: "paddle.webhook.team" },
    extra: { eventId },
  });
}

/**
 * Whether a subscription event belongs to the team path: claimed by the team
 * checkout, on a team price, or for a subscription an organization holds (so
 * a team event that lost its custom data never reaches the Pro path and its
 * customer-id fallback, which writes User.plan).
 */
export async function isTeamSubscription(data: TeamSubscriptionData): Promise<boolean> {
  if (isTeamSubscriptionEvent(data)) return true;
  if (!data.id) return false;
  const held = await prisma.organization.findUnique({
    where: { paddleSubscriptionId: data.id },
    select: { id: true },
  });
  return held !== null;
}

async function orgIdForEvent(data: TeamSubscriptionData): Promise<string | null> {
  const orgId = data.custom_data?.orgId;
  if (typeof orgId === "string" && UUID_RE.test(orgId)) {
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true },
    });
    if (org) return org.id;
  }
  if (!data.id) return null;
  const held = await prisma.organization.findUnique({
    where: { paddleSubscriptionId: data.id },
    select: { id: true },
  });
  return held?.id ?? null;
}

function eventTime(occurredAt: string | undefined): Date | null {
  const parsed = occurredAt ? new Date(occurredAt) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
}

interface StoredSubscription {
  subscriptionEventAt: Date | null;
  paddleSubscriptionId: string | null;
  subscriptionStatus: string | null;
}

/** Why an event must not be applied to this organization, or null to apply it. */
function refusal(stored: StoredSubscription, data: TeamSubscriptionData): string | null {
  const own = Boolean(data.id) && stored.paddleSubscriptionId === data.id;
  // custom_data alone is not proof: the subscription must be on a team price,
  // or be the one this organization already holds.
  if (!own && !hasTeamPrice(data)) return "team event on a non-team price";
  if (
    !own &&
    stored.paddleSubscriptionId !== null &&
    subscriptionBills(stored.subscriptionStatus)
  ) {
    return "second team subscription for an organization with a live one: refund or cancel it in Paddle";
  }
  if (teamSeatQuantity(data, { anyPrice: own }) === null && (data.items ?? []).length > 0) {
    return "team event with an unusable seat quantity";
  }
  return null;
}

function updateFor(data: TeamSubscriptionData, own: boolean, eventAt: Date | null) {
  const seats = teamSeatQuantity(data, { anyPrice: own });
  const interval = teamBillingInterval(data);
  const update: Prisma.OrganizationUpdateInput = {
    subscriptionStatus: data.status ?? null,
    // canceled is terminal: the id is freed so it cannot be targeted again.
    paddleSubscriptionId: data.status === "canceled" ? null : (data.id ?? undefined),
    paddleCustomerId: data.customer_id ?? undefined,
    ...(seats === null ? {} : { seatsPurchased: seats }),
    ...(interval === null ? {} : { billingInterval: interval }),
    ...(eventAt ? { subscriptionEventAt: eventAt } : {}),
  };
  return { update, seats, interval };
}

/**
 * Apply a team subscription event to its organization, under the
 * organization's lock. Order-safe: an event older than the last one applied
 * is skipped, checked inside the lock. An event that maps to no organization,
 * or that must not be applied (see refusal), is reported — never dropped
 * silently, never mapped to a user — and acknowledged, so Paddle does not
 * retry it forever.
 */
export async function applyTeamSubscriptionEvent(
  event: TeamSubscriptionEvent,
): Promise<TeamEventOutcome> {
  const orgId = await orgIdForEvent(event.data);
  if (!orgId) {
    report("paddle team subscription event for unmapped organization", event.eventId);
    return "unmapped";
  }
  const eventAt = eventTime(event.occurredAt);
  return withOrgLock(orgId, async (tx) => {
    const stored = await tx.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { subscriptionEventAt: true, paddleSubscriptionId: true, subscriptionStatus: true },
    });
    if (eventAt && stored.subscriptionEventAt && eventAt < stored.subscriptionEventAt) {
      return "stale";
    }
    const refused = refusal(stored, event.data);
    if (refused) {
      report(`paddle ${refused}`, event.eventId);
      return "refused";
    }
    const own = Boolean(event.data.id) && stored.paddleSubscriptionId === event.data.id;
    const { update, seats, interval } = updateFor(event.data, own, eventAt);
    if (event.data.id && !own) {
      // paddleSubscriptionId is unique: a drifted copy on another organization
      // would fail this update on every retry. That organization loses it,
      // with its seats, and the drift is reported.
      const drifted = await tx.organization.updateMany({
        where: { paddleSubscriptionId: event.data.id, id: { not: orgId } },
        data: { paddleSubscriptionId: null, subscriptionStatus: null, seatsPurchased: 0 },
      });
      if (drifted.count > 0)
        report("team subscription id moved between organizations", event.eventId);
    }
    await tx.organization.update({ where: { id: orgId }, data: update, select: { id: true } });
    await recordOrgAudit(tx, {
      orgId,
      action: "billing.subscription_changed",
      actorUserId: null,
      detail: { status: event.data.status ?? null, seats, interval },
    });
    return "applied";
  });
}

/** The parts of a Paddle transaction event the team path reads. */
export interface TeamTransactionData {
  subscription_id?: string | null;
  custom_data?: { orgId?: unknown; kind?: unknown } | null;
}

/**
 * For a team transaction, the organization owner to tell about a failed
 * payment (null when there is none); false when it is not a team transaction,
 * so the Pro path handles it.
 */
export async function teamOwnerForTransaction(
  data: TeamTransactionData,
): Promise<string | null | false> {
  const subscriptionId = data.subscription_id ?? null;
  const held = subscriptionId
    ? await prisma.organization.findUnique({
        where: { paddleSubscriptionId: subscriptionId },
        select: { id: true },
      })
    : null;
  const claimedOrg =
    data.custom_data?.kind === TEAM_SEATS_KIND && typeof data.custom_data.orgId === "string"
      ? data.custom_data.orgId
      : null;
  const orgId = held?.id ?? (claimedOrg && UUID_RE.test(claimedOrg) ? claimedOrg : null);
  if (!orgId) return data.custom_data?.kind === TEAM_SEATS_KIND ? null : false;
  const owner = await prisma.orgMembership.findFirst({
    where: { orgId, role: "OWNER" },
    select: { userId: true },
  });
  return owner?.userId ?? null;
}
