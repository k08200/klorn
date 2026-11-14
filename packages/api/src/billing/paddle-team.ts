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

const PRICE_ENV: Record<TeamInterval, string> = {
  month: "PADDLE_TEAM_PRICE_ID_MONTHLY",
  year: "PADDLE_TEAM_PRICE_ID_ANNUAL",
};

export function teamPriceIdFor(interval: TeamInterval): string | null {
  const value = (process.env[PRICE_ENV[interval]] ?? "").trim();
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

/** The parts of a Paddle subscription event the team path reads. */
export interface TeamSubscriptionData {
  id?: string;
  status?: string;
  customer_id?: string;
  custom_data?: { orgId?: unknown; kind?: unknown; userId?: unknown } | null;
  items?: Array<{ price?: { id?: string } | null; quantity?: number }> | null;
  billing_cycle?: { interval?: string; frequency?: number } | null;
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
