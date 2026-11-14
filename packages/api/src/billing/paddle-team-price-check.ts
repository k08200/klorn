/**
 * Does Paddle bill the team seat prices the product quotes? The same guard as
 * the Pro price (paddle-price-check.ts), for the two team prices:
 *   PADDLE_TEAM_PRICE_ID_MONTHLY  $30.00 per seat, billed every month
 *   PADDLE_TEAM_PRICE_ID_ANNUAL   $312.00 per seat, billed every year
 * (docs/design/pricing-tiers.md; the amounts come from advertised-price.ts,
 * which team-price-consistency.test.ts holds to the doc).
 *
 * Read once at boot and on every price.updated / price.created webhook (a
 * dashboard edit with no deploy is how both Pro price incidents happened). It
 * logs and alerts on a mismatch; it never throws and never blocks anything.
 * The price's quantity range must allow every self-serve seat count (2–150;
 * Paddle's default range is 1–100). No team trial is promised anywhere, so
 * none is checked. Unset prices (the
 * default until the founder creates them) make it a no-op.
 */

import { MAX_SELF_SERVE_SEATS, MIN_TEAM_SEATS } from "../org/org-shape.js";
import { captureError } from "../sentry.js";
import {
  TEAM_STANDARD_SEAT_ANNUAL_CENTS,
  TEAM_STANDARD_SEAT_MONTHLY_CENTS,
} from "./advertised-price.js";
import {
  comparePriceObject,
  fetchPaddlePrice,
  formatCents,
  type PriceComparison,
  type PriceExpectation,
} from "./paddle-price-check.js";
import {
  TEAM_INTERVALS,
  TEAM_PRICE_ENV,
  type TeamInterval,
  teamPriceIdFor,
} from "./paddle-team.js";

const TEAM_PRICE_CENTS: Record<TeamInterval, number> = {
  month: TEAM_STANDARD_SEAT_MONTHLY_CENTS,
  year: TEAM_STANDARD_SEAT_ANNUAL_CENTS,
};

function expectationFor(interval: TeamInterval): PriceExpectation {
  const cents = TEAM_PRICE_CENTS[interval];
  return {
    cents,
    label: `${formatCents(cents)} per seat per ${interval}`,
    interval,
    trialDays: null,
    envName: TEAM_PRICE_ENV[interval],
    quantity: { min: MIN_TEAM_SEATS, max: MAX_SELF_SERVE_SEATS },
  };
}

/** Compare a Paddle price object with the quoted seat price for `interval`. Pure. */
export function compareTeamPaddlePrice(opts: {
  interval: TeamInterval;
  price: unknown;
}): PriceComparison {
  return comparePriceObject(opts.price, expectationFor(opts.interval));
}

function report(
  result: PriceComparison,
  ctx: { priceId: string; interval: TeamInterval; scope: string; what: string },
): void {
  const sandbox = process.env.PADDLE_ENV === "sandbox";
  const subject = [`[PADDLE] team ${ctx.interval} price ${ctx.priceId}`, ctx.what]
    .filter(Boolean)
    .join(" ");
  if (result.ok) {
    console.log(`${subject} matches ${expectationFor(ctx.interval).label}.`);
    return;
  }
  const summary =
    `${subject} does not match ${expectationFor(ctx.interval).label}: ` +
    result.problems.join(" | ");
  if (sandbox) {
    // A sandbox price is its own object: alerting on it would alarm forever.
    console.log(`${summary} (sandbox, not an alert)`);
    return;
  }
  console.error(summary);
  captureError(new Error(summary), {
    tags: { scope: ctx.scope },
    extra: { priceId: ctx.priceId, interval: ctx.interval, problems: result.problems },
  });
}

export interface TeamPriceCheck {
  interval: TeamInterval;
  priceId: string;
  /** null when Paddle could not be read: "no answer", never "they agree". */
  result: PriceComparison | null;
}

/** Read each configured team price once and report any disagreement. Never throws. */
export async function checkTeamPaddlePrices(
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<TeamPriceCheck[]> {
  if (!(process.env.PADDLE_API_KEY ?? "").trim()) return [];
  const checks: TeamPriceCheck[] = [];
  for (const interval of TEAM_INTERVALS) {
    const priceId = teamPriceIdFor(interval);
    if (!priceId) continue;
    const body = await fetchPaddlePrice(priceId, opts.fetchImpl);
    if (body === null) {
      checks.push({ interval, priceId, result: null });
      continue;
    }
    const result = compareTeamPaddlePrice({
      interval,
      price: (body as { data?: unknown })?.data,
    });
    report(result, { priceId, interval, scope: "billing.paddle.team_price_mismatch", what: "" });
    checks.push({ interval, priceId, result });
  }
  return checks;
}

/**
 * Check a price.updated / price.created webhook against the team seat prices.
 * Returns null when the event is not about a configured team price (the Pro
 * price id is never treated as a team price, as in paddle-team.ts).
 */
export function checkTeamPaddlePriceEvent(opts: {
  eventType: string;
  data: unknown;
}): PriceComparison | null {
  if (opts.eventType !== "price.updated" && opts.eventType !== "price.created") return null;
  const eventPriceId = (opts.data as { id?: unknown } | null)?.id;
  if (typeof eventPriceId !== "string") return null;
  const pro = (process.env.PADDLE_PRO_PRICE_ID ?? "").trim();
  const interval = TEAM_INTERVALS.find(
    (candidate) => teamPriceIdFor(candidate) === eventPriceId && eventPriceId !== pro,
  );
  if (!interval) return null;
  const result = compareTeamPaddlePrice({ interval, price: opts.data });
  report(result, {
    priceId: eventPriceId,
    interval,
    scope: "billing.paddle.team_price_edited_mismatch",
    what: "was edited and",
  });
  return result;
}
