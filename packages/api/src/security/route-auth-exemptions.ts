/**
 * The routes the route-auth guard (route-auth-guard.ts) does NOT put behind
 * the active-session check. Everything else requires a live session.
 *
 * Keys are "METHOD /url/template", exactly as Fastify registers the route.
 * HEAD follows GET (Fastify derives a HEAD route from every GET).
 *
 * Every entry names how the route authenticates instead and why it cannot use
 * a session. Adding one is a security decision: the route-inventory test
 * (__tests__/route-auth-inventory.test.ts) fails on an entry that matches no
 * route, so stale exemptions cannot linger after a route is renamed.
 */
export type RouteAuthExemptionKind =
  /** No credentials by design (health probes, login, public demo). */
  | "public"
  /** Part of a login / account-link flow that starts before a session exists. */
  | "oauth-flow"
  /** Verifies a provider signature or shared secret on the request itself. */
  | "webhook-signature"
  /** Requires the CRON_SECRET header (machine-to-machine). */
  | "cron-secret"
  /** Authenticates with a Klorn API key, never a session JWT. */
  | "api-key"
  /** Authenticates with its own single-purpose token (link, unsubscribe, pairing). */
  | "own-token";

export interface RouteAuthExemption {
  readonly kind: RouteAuthExemptionKind;
  readonly why: string;
}

export const ROUTE_AUTH_EXEMPTIONS: Readonly<Record<string, RouteAuthExemption>> = {
  // --- Health probes: uptime monitors and Render call these without credentials.
  "GET /api/health": {
    kind: "public",
    why: "Liveness probe for Render and uptime monitors; returns no user data.",
  },
  "GET /api/health/ready": {
    kind: "public",
    why: "Readiness probe (503 while the database is down); returns no user data.",
  },
  "GET /api/health/schedulers": {
    kind: "public",
    why: "Scheduler liveness for external monitors; scheduler names and tick times only.",
  },

  // --- Sign-in and sign-up: there is no session yet.
  "GET /api/auth/signup-status": {
    kind: "public",
    why: "The login page reads it before sign-in to hide the sign-up tab; a boolean only.",
  },
  "GET /api/auth/providers": {
    kind: "public",
    why: "The login page reads it before sign-in to render the provider buttons.",
  },
  "POST /api/auth/register": {
    kind: "public",
    why: "Creates the account and its first session; rate-limited.",
  },
  "POST /api/auth/login": {
    kind: "public",
    why: "Password sign-in mints the session; rate-limited and locked out on failures.",
  },
  "POST /api/auth/forgot-password": {
    kind: "public",
    why: "Signed-out password recovery; mails a one-time token, same answer for any address.",
  },
  "POST /api/auth/reset-password": {
    kind: "own-token",
    why: "Authenticated by the one-time reset token (hashed at rest); revokes every session.",
  },
  "GET /api/auth/verify-email": {
    kind: "own-token",
    why: "Authenticated by the one-time verification token from the email link.",
  },
  "POST /api/auth/logout": {
    kind: "own-token",
    why: "Deletes only the device row of the presented token; must succeed for an already-ended session.",
  },
  "GET /api/auth/google/login": {
    kind: "oauth-flow",
    why: "Starts Google sign-in before any session exists; issues a short-lived signed state.",
  },
  "GET /api/auth/google/callback": {
    kind: "oauth-flow",
    why: "Google's redirect target; authenticated by the signed, short-lived OAuth state.",
  },
  "GET /api/auth/desktop-nonce": {
    kind: "oauth-flow",
    why: "Desktop/mobile sign-in start; issues a nonce bound to the app's PKCE challenge.",
  },
  "GET /api/auth/desktop-token/:nonce": {
    kind: "own-token",
    why: "The app's poll; requires an issued nonce plus the PKCE verifier header.",
  },
  "POST /api/auth/desktop-confirm": {
    kind: "own-token",
    why: "The browser confirms a desktop sign-in with the single-use confirmation id.",
  },
  "POST /api/auth/exchange-code": {
    kind: "own-token",
    why: "Redeems the single-use OAuth exchange code (browser-bound for web sign-ins).",
  },
  "GET /api/auth/outlook/callback": {
    kind: "oauth-flow",
    why: "Microsoft's redirect target; authenticated by the signed, short-lived OAuth state.",
  },
  "GET /api/auth/apple/login": {
    kind: "oauth-flow",
    why: "Starts Sign in with Apple before any session exists (dark behind its flag).",
  },
  "POST /api/auth/apple/callback": {
    kind: "oauth-flow",
    why: "Apple's form_post target; authenticated by the signed OAuth state (dark behind its flag).",
  },
  "GET /api/auth/naver/login": {
    kind: "oauth-flow",
    why: "Starts Naver sign-in before any session exists (dark behind its flag).",
  },
  "GET /api/auth/naver/callback": {
    kind: "oauth-flow",
    why: "Naver's redirect target; authenticated by the signed OAuth state (dark behind its flag).",
  },

  // --- Notification actions from the service worker / OS, which hold no session.
  "POST /api/notifications/push/receipts/:deliveryId": {
    kind: "own-token",
    why: "The 128-bit delivery id is the capability; a one-way receipt flag, no data returned.",
  },
  "POST /api/notifications/push/tier-override": {
    kind: "own-token",
    why: "Authenticated by the signed tier-override token in the body.",
  },
  "POST /api/notifications/push/later": {
    kind: "own-token",
    why: "Authenticated by the signed push-later token in the body.",
  },
  "POST /api/notifications/push/rotate": {
    kind: "own-token",
    why: "pushsubscriptionchange has no session; the old high-entropy endpoint URL is the credential.",
  },

  // --- Provider webhooks: each verifies its own signature or shared secret.
  "POST /api/webhook/stripe": {
    kind: "webhook-signature",
    why: "Verifies the Stripe-Signature header over the raw body.",
  },
  "POST /api/webhook/paddle": {
    kind: "webhook-signature",
    why: "Verifies the Paddle-Signature header over the raw body.",
  },
  "POST /api/webhook/revenuecat": {
    kind: "webhook-signature",
    why: "Requires the shared RevenueCat secret in the Authorization header (timing-safe).",
  },
  "POST /api/gmail/push": {
    kind: "webhook-signature",
    why: "Google Pub/Sub push; verifies the Google-signed OIDC token or the shared push secret.",
  },
  "POST /api/mailbox/inbound/resend": {
    kind: "webhook-signature",
    why: "Resend Inbound; verifies the Svix signature headers (dark behind its flag).",
  },
  "POST /api/telegram/webhook": {
    kind: "webhook-signature",
    why: "Requires X-Telegram-Bot-Api-Secret-Token to match the configured secret.",
  },
  "POST /api/phone/gather": {
    kind: "webhook-signature",
    why: "Twilio callback; verifies X-Twilio-Signature over the URL and form params.",
  },
  "POST /api/phone/status": {
    kind: "webhook-signature",
    why: "Twilio callback; verifies X-Twilio-Signature over the URL and form params.",
  },

  // --- Machine-to-machine.
  "POST /api/cron/briefing-tick": {
    kind: "cron-secret",
    why: "External cron; requires X-Cron-Secret to match BRIEFING_CRON_SECRET (timing-safe).",
  },
  "POST /api/mcp": {
    kind: "api-key",
    why: "MCP server; authenticates a Klorn API key, which a session guard would reject.",
  },
  "GET /api/mcp": {
    kind: "api-key",
    why: "Answers 405 (POST-only transport) to MCP clients holding an API key, never a session.",
  },
  "DELETE /api/mcp": {
    kind: "api-key",
    why: "Answers 405 (POST-only transport) to MCP clients holding an API key, never a session.",
  },

  // --- Login-free marketing demo.
  "POST /api/playground/classify": {
    kind: "public",
    why: "The landing page's login-free classifier demo; tightly rate-limited, no user data.",
  },
  "POST /api/playground/feedback": {
    kind: "public",
    why: "Feedback on the login-free classifier demo; rate-limited, no user data.",
  },
};

function exemptionKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`;
}

function isMethodExempt(method: string, url: string): boolean {
  const upper = method.toUpperCase();
  const lookup = upper === "HEAD" ? "GET" : upper;
  return Object.hasOwn(ROUTE_AUTH_EXEMPTIONS, exemptionKey(lookup, url));
}

/**
 * True when every method of the route is exempt. A multi-method route with one
 * exempt method stays guarded — the guard is per route, not per method.
 */
export function isRouteAuthExempt(method: string | readonly string[], url: string): boolean {
  const methods = typeof method === "string" ? [method] : method;
  return methods.length > 0 && methods.every((m) => isMethodExempt(m, url));
}
