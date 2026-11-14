/**
 * Klorn Teams seat billing on Paddle (scaffold). Quantity-based: one Paddle
 * subscription per organization, quantity = seats. The team prices are the
 * founder's to create in Paddle; their ids come from env only and are unset
 * by default, which turns the checkout off with a clear code:
 *   PADDLE_TEAM_PRICE_ID_MONTHLY  standard seat, $30 / seat / month
 *   PADDLE_TEAM_PRICE_ID_ANNUAL   standard seat, $312 / seat / year
 * (docs/design/pricing-tiers.md). The checkout's custom_data names the
 * organization and never a user, so the Pro webhook path (which maps
 * custom_data.userId to an account and writes User.plan) can never take it.
 */

import { paddleFetch } from "./paddle.js";

export type TeamInterval = "month" | "year";
export const TEAM_INTERVALS: readonly TeamInterval[] = ["month", "year"];
export const TEAM_SEATS_KIND = "team_seats";

export const TEAM_PRICE_ENV: Record<TeamInterval, string> = {
  month: "PADDLE_TEAM_PRICE_ID_MONTHLY",
  year: "PADDLE_TEAM_PRICE_ID_ANNUAL",
};

export function teamPriceIdFor(interval: TeamInterval): string | null {
  const value = (process.env[TEAM_PRICE_ENV[interval]] ?? "").trim();
  return value === "" ? null : value;
}

/** The intervals a team checkout can be opened for right now (none by default). */
export function teamCheckoutIntervals(): TeamInterval[] {
  if (!(process.env.PADDLE_API_KEY ?? "").trim()) return [];
  return TEAM_INTERVALS.filter((interval) => teamPriceIdFor(interval) !== null);
}

export async function createPaddleTeamCheckout(opts: {
  orgId: string;
  priceId: string;
  quantity: number;
}): Promise<string> {
  const data = (await paddleFetch("/transactions", {
    items: [{ price_id: opts.priceId, quantity: opts.quantity }],
    custom_data: { orgId: opts.orgId, kind: TEAM_SEATS_KIND },
  })) as { data?: { checkout?: { url?: string | null } } };
  const url = data?.data?.checkout?.url;
  if (!url) {
    throw new Error(
      "Paddle transaction created but no checkout url returned — set the default payment link in Paddle checkout settings",
    );
  }
  return url;
}

/**
 * How a seat change is billed (Paddle `proration_billing_mode`):
 * prorated_immediately, both directions. Adding seats charges only the rest
 * of the current period now, so a seat is paid for from the day it exists and
 * no new member waits for a renewal; removing seats credits the unused part
 * to the customer's Paddle balance, which the next renewal draws down. Every
 * other mode either charges for days a seat was not held (full_*), lets seats
 * run unbilled until the renewal (*_next_billing_period), or never bills
 * them (do_not_bill).
 */
export const SEAT_CHANGE_PRORATION = "prorated_immediately";

/** The live subscription, read before a seat change (GET /subscriptions/{id}). */
export interface PaddleTeamSubscription {
  status: string | null;
  /** The scheduled change's action ("cancel", "pause", …), or null. */
  scheduledChange: string | null;
  items: Array<{ priceId: string | null; quantity: number | null }>;
}

export async function getPaddleTeamSubscription(
  subscriptionId: string,
  opts: { timeoutMs?: number } = {},
): Promise<PaddleTeamSubscription> {
  const body = (await paddleFetch(
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    undefined,
    "GET",
    opts,
  )) as {
    data?: {
      status?: unknown;
      scheduled_change?: { action?: unknown } | null;
      items?: Array<{ price?: { id?: unknown } | null; quantity?: unknown }> | null;
    };
  };
  const data = body?.data ?? {};
  const action = data.scheduled_change?.action;
  return {
    status: typeof data.status === "string" ? data.status : null,
    scheduledChange: data.scheduled_change
      ? typeof action === "string"
        ? action
        : "unknown"
      : null,
    items: (data.items ?? []).map((item) => ({
      priceId: typeof item.price?.id === "string" ? item.price.id : null,
      quantity: Number.isInteger(item.quantity) ? (item.quantity as number) : null,
    })),
  };
}

/**
 * The Paddle customer's email (GET /customers/{id}), or null when Paddle
 * returns none. The team billing portal opens only for the owner whose
 * verified Klorn email this is.
 */
export async function getPaddleCustomerEmail(
  customerId: string,
  opts: { timeoutMs?: number } = {},
): Promise<string | null> {
  const body = (await paddleFetch(
    `/customers/${encodeURIComponent(customerId)}`,
    undefined,
    "GET",
    opts,
  )) as { data?: { email?: unknown } };
  const email = body?.data?.email;
  return typeof email === "string" && email.trim() !== "" ? email : null;
}

/**
 * Set the seat count: the subscription's one item, on its own price, at
 * `quantity`. Paddle replaces the item list, so the price id is the one the
 * subscription already bills on (never chosen by a client, never the newest
 * configured price, which would quietly move the organization to it). A failed
 * proration charge leaves the subscription as it was (prevent_change).
 */
export async function setPaddleSeatQuantity(
  opts: { subscriptionId: string; priceId: string; quantity: number },
  call: { timeoutMs?: number } = {},
): Promise<void> {
  await paddleFetch(
    `/subscriptions/${encodeURIComponent(opts.subscriptionId)}`,
    {
      items: [{ price_id: opts.priceId, quantity: opts.quantity }],
      proration_billing_mode: SEAT_CHANGE_PRORATION,
      on_payment_failure: "prevent_change",
    },
    "PATCH",
    call,
  );
}

/** The parts of a Paddle subscription event the team path reads. */
export interface TeamSubscriptionData {
  id?: string;
  status?: string;
  customer_id?: string;
  custom_data?: { orgId?: unknown; kind?: unknown; userId?: unknown } | null;
  items?: Array<{ price?: { id?: string } | null; quantity?: number }> | null;
  billing_cycle?: { interval?: string; frequency?: number } | null;
  scheduled_change?: { action?: string; effective_at?: string | null } | null;
}

/**
 * When a scheduled period-end cancel takes effect: a Date, null when the event
 * says there is none (or the subscription is already canceled), undefined when
 * the event does not say (the stored value is kept).
 */
export function teamCancelAt(data: TeamSubscriptionData): Date | null | undefined {
  if (data.status === "canceled") return null;
  if (data.scheduled_change === undefined) return undefined;
  const change = data.scheduled_change;
  if (change?.action !== "cancel" || !change.effective_at) return null;
  const at = new Date(change.effective_at);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** Per item, Paddle quantities outside this are refused rather than stored. */
const MAX_ITEM_QUANTITY = 10_000;

/** The configured team prices — never the Pro price, even if set to the same id. */
export function teamPriceIds(): Set<string> {
  const pro = (process.env.PADDLE_PRO_PRICE_ID ?? "").trim();
  return new Set(
    TEAM_INTERVALS.map(teamPriceIdFor).filter((id): id is string => id !== null && id !== pro),
  );
}

/** True when an item of the event is on a team price. */
export function hasTeamPrice(data: TeamSubscriptionData): boolean {
  const prices = teamPriceIds();
  return (data.items ?? []).some((item) => prices.has(item.price?.id ?? ""));
}

/** Claimed as a team event by the checkout's custom data, or on a team price. */
export function isTeamSubscriptionEvent(data: TeamSubscriptionData): boolean {
  return data.custom_data?.kind === TEAM_SEATS_KIND || hasTeamPrice(data);
}

function itemQuantity(item: { quantity?: number }): number | null {
  const q = item.quantity;
  return Number.isInteger(q) && (q as number) >= 1 && (q as number) <= MAX_ITEM_QUANTITY
    ? (q as number)
    : null;
}

/**
 * Seats bought: the quantity on the team-price items — or on every item when
 * `anyPrice` (the organization's own stored subscription, after a price
 * rotation). null when there is none, or any counted quantity is not a whole
 * number from 1 to 10,000: such an event is not applied.
 */
export function teamSeatQuantity(
  data: TeamSubscriptionData,
  opts: { anyPrice?: boolean } = {},
): number | null {
  const prices = teamPriceIds();
  const items = (data.items ?? []).filter(
    (item) => opts.anyPrice === true || prices.has(item.price?.id ?? ""),
  );
  if (items.length === 0) return null;
  const quantities = items.map(itemQuantity);
  if (quantities.some((q) => q === null)) return null;
  return (quantities as number[]).reduce((sum, q) => sum + q, 0);
}

export function teamBillingInterval(data: TeamSubscriptionData): TeamInterval | null {
  const interval = data.billing_cycle?.interval;
  return interval === "month" || interval === "year" ? interval : null;
}
