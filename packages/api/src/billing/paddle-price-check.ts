/**
 * Does Paddle actually charge what the site advertises?
 *
 * Nothing else in this repo can answer that. `packages/web/src/lib/pricing.ts`
 * makes our own surfaces agree with each other, and
 * `.github/scripts/check-price-consistency.mjs` makes the static pages agree
 * with that constant — but the number that bills a real person lives on a
 * Paddle price object, outside the repo, editable from a dashboard.
 *
 * That gap is where both incidents happened:
 *
 *   2026-08-12 — the app advertised $7.99 while Paddle charged $8.99.
 *   2026-10-15 — the Paddle price was edited to $29.99 while every page still
 *   said $8.99. Customers were billed MORE than they were quoted, and we
 *   found out because the founder mentioned it.
 *
 * So this runs at boot, fetches the configured price, and says so when the two
 * disagree. It warns and returns — it never throws and never blocks startup.
 * A billing provider being briefly unreachable must not take the API down, and
 * the precedent here is the judge model gate: degrade, not amputate.
 */

import { captureError } from "../sentry.js";

/** Minor units per major unit. Paddle returns amounts as integer cents. */
const CENTS_PER_DOLLAR = 100;

/** Every price surface promises this; the trial lives on the price object. */
const EXPECTED_TRIAL_DAYS = 7;

/** Paddle is not on the request path here; do not wait on it for long. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Dollars in an advertised price string.
 *
 * Accepts both "$30" and the German/French "30 $", because those two landings
 * write prices with a trailing sign and a decimal comma. A dollar-first parser
 * skips them in silence — which is how de and fr came to disagree with their
 * own price card before 2026-10-14.
 */
export function parseAdvertisedAmount(price: string): number {
  const digits = String(price ?? "")
    .replace(/[^0-9.,]/g, "")
    .replace(",", ".");
  const parsed = Number(digits);
  if (!digits || !Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Unreadable advertised price: ${JSON.stringify(price)}`);
  }
  return parsed;
}

/** Minor units as a dollar string — 2950 is "$29.50", never "$29.5". */
function formatCents(cents: number): string {
  return `$${(cents / CENTS_PER_DOLLAR).toFixed(2)}`;
}

export interface PriceComparison {
  ok: boolean;
  /** Every disagreement found, not just the first. */
  problems: string[];
}

/**
 * Compare a Paddle price object against the advertised string.
 *
 * Pure, so the interesting cases are testable without a network or a key. The
 * `price` argument is deliberately `unknown`: it comes from a third party, and
 * a response shape we do not recognise must read as "cannot confirm", never as
 * "agrees".
 */
export function comparePaddlePrice(opts: { advertised: string; price: unknown }): PriceComparison {
  const problems: string[] = [];

  let advertisedAmount: number;
  try {
    advertisedAmount = parseAdvertisedAmount(opts.advertised);
  } catch (err) {
    return { ok: false, problems: [(err as Error).message] };
  }

  if (typeof opts.price !== "object" || opts.price === null) {
    return {
      ok: false,
      problems: [
        `Paddle price response was ${typeof opts.price}, not an object — cannot confirm what is charged`,
      ],
    };
  }

  const price = opts.price as {
    status?: unknown;
    tax_mode?: unknown;
    unit_price?: { amount?: unknown; currency_code?: unknown };
    billing_cycle?: { interval?: unknown; frequency?: unknown } | null;
    trial_period?: { interval?: unknown; frequency?: unknown } | null;
  };

  // --- what it charges -----------------------------------------------------
  // Compared in integer cents. The advertised string is the one with a decimal
  // point, so it is the one converted; comparing dollars would make 29.99 a
  // float on both sides for no reason.
  const advertisedCents = Math.round(advertisedAmount * CENTS_PER_DOLLAR);
  const rawAmount = price.unit_price?.amount;
  if (typeof rawAmount !== "string" && typeof rawAmount !== "number") {
    problems.push("Paddle price has no unit_price.amount — cannot confirm what is charged");
  } else {
    const cents = Number(rawAmount);
    if (!Number.isFinite(cents) || !Number.isInteger(cents)) {
      problems.push(`Paddle unit_price.amount is not whole minor units: ${String(rawAmount)}`);
    } else if (cents !== advertisedCents) {
      const direction = cents > advertisedCents ? "charges more than" : "charges less than";
      problems.push(
        `Paddle ${direction} the site advertises: billing ${formatCents(cents)} ` +
          `against an advertised ${opts.advertised}.` +
          (cents > advertisedCents
            ? " Customers are being billed above the price they were quoted."
            : ""),
      );
    }
  }

  // --- in what currency ----------------------------------------------------
  const currency = price.unit_price?.currency_code;
  if (currency !== "USD") {
    problems.push(`Paddle price is in ${String(currency)}, but every surface quotes US dollars`);
  }

  // --- how often -----------------------------------------------------------
  // Every surface says "/month". $29.99 on a yearly cycle, or a null cycle
  // (one-time charge), matches on amount and is still the wrong product.
  const cycle = price.billing_cycle;
  if (!cycle) {
    problems.push(
      "Paddle price has no billing_cycle — it is a one-time charge, but every surface says per month",
    );
  } else if (cycle.interval !== "month" || Number(cycle.frequency) !== 1) {
    problems.push(
      `Paddle bills every ${String(cycle.frequency)} ${String(cycle.interval)}(s), ` +
        `but every surface says per month`,
    );
  }

  // --- plus tax, or including it -------------------------------------------
  // tax_mode "external" means the customer pays the quoted price PLUS tax, so
  // the amount above is not what lands on the card. The pages quote one number.
  //
  // "account_setting" is the Paddle default and defers to the account-level
  // choice, which this object cannot tell us — so it could BE exclusive, and
  // the case above would slip through. It is logged rather than raised: the
  // default value would alarm on most correctly-configured accounts, and a
  // check that fires on the normal case gets ignored, which is how the sandbox
  // branch above is argued too. Verifying the account default is a one-off
  // founder step recorded in the PR, not something to re-alarm on every boot.
  if (price.tax_mode === "external") {
    problems.push(
      'Paddle tax_mode is "external" — tax is added on top of the quoted price, ' +
        "so the customer pays more than any page says",
    );
  } else if (price.tax_mode === "account_setting") {
    console.log(
      "[PADDLE] price tax_mode is account_setting — inclusive vs exclusive is set " +
        "on the account and cannot be confirmed from the price object",
    );
  }

  // --- with what trial -----------------------------------------------------
  // createPaddleCheckout sends only price_id and quantity, so a price without
  // a trial bills immediately while the pages promise seven free days.
  const trial = price.trial_period;
  if (!trial) {
    problems.push(
      `Paddle price has no trial_period, but every price surface promises a ` +
        `${EXPECTED_TRIAL_DAYS}-day trial — the first charge lands immediately`,
    );
  } else {
    // A one-week trial IS seven days; alarming on it would be noise.
    const days =
      trial.interval === "day"
        ? Number(trial.frequency)
        : trial.interval === "week"
          ? Number(trial.frequency) * 7
          : Number.NaN;
    if (days !== EXPECTED_TRIAL_DAYS) {
      problems.push(
        `Paddle trial is ${String(trial.frequency)} ${String(trial.interval)}(s), ` +
          `but the pages promise ${EXPECTED_TRIAL_DAYS} days`,
      );
    }
  }

  // --- and is it even live -------------------------------------------------
  if (price.status !== "active") {
    problems.push(
      `Paddle price status is "${String(price.status)}" — an archived or ` +
        `inactive price is still wired to PADDLE_PRO_PRICE_ID`,
    );
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Fetch the configured price and report any disagreement. Never throws.
 *
 * Returns the comparison when one was made, or null when there was nothing to
 * check (Paddle not configured) or the fetch failed — the caller treats both
 * as "no answer", which is different from "they agree".
 */
export async function checkPaddlePriceMatchesAdvertised(opts: {
  advertised: string;
  fetchImpl?: typeof fetch;
}): Promise<PriceComparison | null> {
  const apiKey = process.env.PADDLE_API_KEY;
  const priceId = process.env.PADDLE_PRO_PRICE_ID;
  if (!apiKey || !priceId) return null;

  // A sandbox price is a different object with its own amount; comparing it to
  // the production constant would alarm forever and train everyone to ignore
  // this check, which is worse than not having it.
  const sandbox = process.env.PADDLE_ENV === "sandbox";
  const base = sandbox ? "https://sandbox-api.paddle.com" : "https://api.paddle.com";
  const doFetch = opts.fetchImpl ?? fetch;

  let body: unknown;
  try {
    const res = await doFetch(`${base}/prices/${encodeURIComponent(priceId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      // Without this an unresponsive Paddle leaves the promise pending for the
      // process lifetime. It is void-ed at boot, so nothing would ever notice.
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Never echo the key; Paddle's body carries request ids worth having.
      const detail = await res.text().catch(() => "");
      const line = `[PADDLE] could not read price ${priceId}: ${res.status} ${detail.slice(0, 200)}`;
      console.warn(line);
      // 4xx is us, not them: a key without the Price:Read permission disables
      // this guard permanently and silently. 5xx and network errors are
      // transient and must not page anyone.
      if (res.status >= 400 && res.status < 500) {
        captureError(new Error(line), {
          tags: { scope: "billing.paddle.price_unreadable" },
          extra: { priceId, status: res.status },
        });
      }
      return null;
    }
    body = await res.json();
  } catch (err) {
    console.warn(`[PADDLE] price check could not reach Paddle: ${(err as Error).message}`);
    return null;
  }

  if (sandbox) {
    const result = comparePaddlePrice({
      advertised: opts.advertised,
      price: (body as { data?: unknown })?.data,
    });
    console.log(
      result.ok
        ? `[PADDLE] sandbox price ${priceId} matches ${opts.advertised}.`
        : `[PADDLE] sandbox price ${priceId} differs from ${opts.advertised} (not an alert in sandbox): ${result.problems.join(" | ")}`,
    );
    return result;
  }

  const price = (body as { data?: unknown })?.data;
  const result = comparePaddlePrice({ advertised: opts.advertised, price });

  if (!result.ok) {
    const summary = `[PADDLE] advertised price and Paddle price disagree: ${result.problems.join(" | ")}`;
    console.error(summary);
    captureError(new Error(summary), {
      tags: { scope: "billing.paddle.price_mismatch" },
      extra: { priceId, advertised: opts.advertised, problems: result.problems },
    });
  } else {
    console.log(`[PADDLE] price ${priceId} matches the advertised ${opts.advertised}.`);
  }

  return result;
}

/**
 * Report a price webhook that disagrees with the advertised price.
 *
 * This is the path that actually matters. Both incidents were **dashboard
 * edits with no deploy** — 2026-08-12 and 2026-10-15 — so a boot-time check
 * would not have fired for either of them until the next unrelated restart.
 * Paddle emits `price.updated` / `price.created` when someone edits a price,
 * and the event carries the price object inline, so this needs no API call,
 * no key permission and no network.
 *
 * Returns null when the event is not about the price we bill on.
 */
export function checkPaddlePriceEvent(opts: {
  eventType: string;
  data: unknown;
  advertised: string;
}): PriceComparison | null {
  if (opts.eventType !== "price.updated" && opts.eventType !== "price.created") {
    return null;
  }
  const priceId = process.env.PADDLE_PRO_PRICE_ID;
  const eventPriceId = (opts.data as { id?: unknown } | null)?.id;
  // Other prices may exist (sandbox fixtures, old archived ones). Only the one
  // checkout actually uses can put us in breach of what the pages say.
  if (!priceId || eventPriceId !== priceId) return null;

  const result = comparePaddlePrice({ advertised: opts.advertised, price: opts.data });
  if (!result.ok) {
    const summary =
      `[PADDLE] price ${priceId} was edited and no longer matches the advertised ` +
      `${opts.advertised}: ${result.problems.join(" | ")}`;
    console.error(summary);
    captureError(new Error(summary), {
      tags: { scope: "billing.paddle.price_edited_mismatch" },
      extra: { priceId, advertised: opts.advertised, problems: result.problems },
    });
  } else {
    console.log(`[PADDLE] price ${priceId} was edited and still matches ${opts.advertised}.`);
  }
  return result;
}
