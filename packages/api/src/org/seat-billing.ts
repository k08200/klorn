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
import { OrgError } from "./org-error.js";
import { withOrgLock } from "./org-lock.js";
import { requireOwner } from "./org-members.js";
import { MAX_SELF_SERVE_SEATS, MIN_TEAM_SEATS } from "./org-shape.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A subscription in these states still bills (or can recover): no second checkout. */
const LIVE_STATUSES = new Set(["active", "trialing", "past_due", "paused"]);

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
  if (owner.org.paddleSubscriptionId && LIVE_STATUSES.has(owner.org.subscriptionStatus ?? "")) {
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

async function orgForEvent(data: TeamSubscriptionData) {
  const orgId = data.custom_data?.orgId;
  const select = { id: true, subscriptionEventAt: true } as const;
  if (typeof orgId === "string" && UUID_RE.test(orgId)) {
    return prisma.organization.findUnique({ where: { id: orgId }, select });
  }
  if (data.id) {
    return prisma.organization.findUnique({ where: { paddleSubscriptionId: data.id }, select });
  }
  return null;
}

function updateFor(data: TeamSubscriptionData, eventAt: Date | null) {
  const seats = teamSeatQuantity(data);
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
 * Apply a team subscription event to its organization. Order-safe: an event
 * older than the last one applied is skipped (seats and status follow the
 * newest event). An event that maps to no organization is reported, never
 * dropped silently and never mapped to a user.
 */
export async function applyTeamSubscriptionEvent(
  event: TeamSubscriptionEvent,
): Promise<"applied" | "stale" | "unmapped"> {
  const org = await orgForEvent(event.data);
  if (!org) {
    captureError(new Error("paddle team subscription event for unmapped organization"), {
      tags: { scope: "paddle.webhook.team" },
      extra: { eventId: event.eventId },
    });
    return "unmapped";
  }
  const parsed = event.occurredAt ? new Date(event.occurredAt) : null;
  const eventAt = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
  if (eventAt && org.subscriptionEventAt && eventAt < org.subscriptionEventAt) return "stale";

  const { update, seats, interval } = updateFor(event.data, eventAt);
  await withOrgLock(org.id, async (tx) => {
    if (event.data.id) {
      // paddleSubscriptionId is unique: a drifted copy on another organization
      // would make this update fail on every Paddle retry. Free it, and say so.
      const drifted = await tx.organization.updateMany({
        where: { paddleSubscriptionId: event.data.id, id: { not: org.id } },
        data: { paddleSubscriptionId: null },
      });
      if (drifted.count > 0) {
        captureError(new Error("paddle team subscription id moved between organizations"), {
          tags: { scope: "paddle.webhook.team" },
          extra: { eventId: event.eventId },
        });
      }
    }
    await tx.organization.update({ where: { id: org.id }, data: update, select: { id: true } });
    await recordOrgAudit(tx, {
      orgId: org.id,
      action: "billing.subscription_changed",
      actorUserId: null,
      detail: { status: event.data.status ?? null, seats, interval },
    });
  });
  return "applied";
}
