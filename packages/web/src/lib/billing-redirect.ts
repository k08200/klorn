/**
 * Guard for the URL the checkout endpoint hands back.
 *
 * It exists to stop an open redirect: the value comes from an API response, so
 * it must never be able to send a signed-in user to an arbitrary origin.
 *
 * The allow-list used to be the payment providers' own hosts, which was right
 * while checkout was Paddle-hosted. It stopped being right when Paddle's
 * "default payment link" was pointed at app.klorn.ai/billing (2026-08-12):
 * Paddle now returns OUR origin with a `_ptxn` transaction param, Paddle.js on
 * that page opens the overlay, and the old guard rejected it as unsafe — the
 * upgrade button failed with "Unsafe billing redirect URL" on every click.
 *
 * So: same-origin is allowed, plus the provider hosts for the Stripe path and
 * for any Paddle-hosted link. Everything else is still refused.
 */

const PROVIDER_HOSTS = [".stripe.com", ".paddle.com"] as const;

export function isSafeBillingRedirect(url: string, currentOrigin: string): boolean {
  let parsed: URL;
  let origin: URL;
  try {
    parsed = new URL(url);
    origin = new URL(currentOrigin);
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:") return false;

  // Same origin — the default-payment-link case. Compare host AND protocol, not
  // just hostname: a match on hostname alone would let http://app.klorn.ai
  // through on a downgraded link.
  if (parsed.host === origin.host && origin.protocol === "https:") return true;

  const host = parsed.hostname;
  if (host === "paddle.com" || host === "stripe.com") return true;
  return PROVIDER_HOSTS.some((suffix) => host.endsWith(suffix));
}
