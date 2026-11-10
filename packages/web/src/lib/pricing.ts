/**
 * The displayed Pro price, in one place.
 *
 * It used to be a string literal in three components, each carrying a comment
 * telling the next reader to keep the others in sync. They drifted anyway: on
 * 2026-08-12 the app advertised $7.99 while the Paddle price, the Terms page
 * and both landings all said $8.99 — an advertised price that did not match
 * what the customer would actually be charged.
 *
 * Anything user-facing that quotes a price imports from here.
 */

/**
 * Web checkout, billed through Paddle.
 *
 * Raised from $8.99 to $29.99 on 2026-10-14 (founder): the category sits at $30
 * (Fyxer, Superhuman, Shortwave) and the old number read as a toy.
 *
 * Anyone already subscribed at $8.99 keeps that price until Paddle is told
 * otherwise, and raising an existing subscriber's price needs its own notice.
 * Check Paddle for live subscriptions before assuming there are none — a live
 * transaction was verified on 2026-08-22.
 *
 * This string must match the amount on the Paddle price behind
 * PADDLE_PRO_PRICE_ID. They are not wired together: Paddle owns the amount,
 * this owns what the page claims, and on 2026-08-12 they disagreed in
 * production for long enough to advertise a price nobody was charged.
 */
export const PRO_PRICE_WEB = "$29.99";

/**
 * In-app purchase on iOS/Android. Higher because the store takes a cut.
 *
 * NOT derived from the web price: store pricing is tier-based, so this has to
 * match the tier actually configured in App Store Connect / Play Console.
 *
 * Moved $9.99 → $34.99 with the web raise on 2026-10-14. At $9.99 the native
 * paywall was quoting a third of the web price, which is not a discount, it is
 * two different public prices for one product. $34.99 is a real Apple price
 * point above $29.99; IAP is dark until a RevenueCat key exists (see
 * iapAvailable()), so nothing can be bought at this number yet — but the tier
 * must be created in App Store Connect / Play Console BEFORE it goes live, or
 * the store charges whatever its own tier says and this string is a lie.
 */
export const PRO_PRICE_NATIVE = "$34.99";

/** The price to show for the surface the user is on. */
export function proPrice(native: boolean): string {
  return native ? PRO_PRICE_NATIVE : PRO_PRICE_WEB;
}
