/**
 * Where to send the browser once a Paddle checkout completes.
 *
 * The billing page used to call `window.location.reload()`. That reloads the
 * SAME url — and after a hosted checkout that url still carries the
 * `_ptxn=txn_...` param Paddle's default payment link put there. Paddle.js
 * re-detects the param on the fresh page, reopens the overlay for the
 * already-completed transaction, fires `checkout.completed` again, and reloads
 * again: an infinite loop the customer hits immediately after paying
 * (observed on a live sandbox purchase, 2026-08-13).
 *
 * Stripping `_ptxn` is what breaks the cycle, so the reload has to go through
 * here. Every other param and the hash are preserved — the caller may be deep
 * in a filtered view and should land back where it was.
 */

/** Paddle's default-payment-link transaction param. */
const CHECKOUT_PARAM = "_ptxn";

export function checkoutReturnUrl(currentUrl: string): string {
  let url: URL;
  try {
    url = new URL(currentUrl);
  } catch {
    // Not parseable — reloading an unknown url is worse than doing nothing
    // useful, so fall back to the billing page itself.
    return "/billing";
  }
  url.searchParams.delete(CHECKOUT_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}
