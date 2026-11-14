/**
 * The advertised web price, as the API sees it.
 *
 * The source of truth is `packages/web/src/lib/pricing.ts` (`PRO_PRICE_WEB`).
 * The API cannot import it: `@klorn/contract` is type-only by design, and the
 * web package is not present in the API's deployment.
 *
 * So the value is restated here and `__tests__/advertised-price.test.ts` reads
 * PRO_PRICE_WEB out of the web package and fails when the two differ. That
 * test is the guard — `check-price-consistency.mjs` compares the published
 * PAGES to the web constant and never looks at this file. A second copy
 * nobody checks is exactly the drift this whole area exists to prevent; a
 * second copy CI compares is just a cache.
 *
 * Change `PRO_PRICE_WEB` and this together, or CI will say so.
 */
export const ADVERTISED_PRO_PRICE_WEB = "$29.99";

/**
 * Team (company) plan, standard seat (docs/design/pricing-tiers.md, LOCKED
 * 2026-11-11): $30 per seat per month billed monthly, $26 per seat per month
 * billed annually ($312 a year). USD cents. Not on the public site until the
 * price-consistency guard covers them; the Paddle prices are founder work.
 */
export const TEAM_STANDARD_SEAT_MONTHLY_CENTS = 3000;
export const TEAM_STANDARD_SEAT_ANNUAL_PER_MONTH_CENTS = 2600;
