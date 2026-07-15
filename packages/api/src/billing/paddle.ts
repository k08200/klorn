import crypto from "node:crypto";
import { timingSafeEqualStr } from "../timing-safe-equal.js";

/**
 * Paddle Billing (merchant-of-record) — the web payment provider.
 *
 * Paddle is the legal seller, so no local business registration is needed.
 * Everything here is env-driven and absent-safe: with no PADDLE_* env set,
 * isPaddleConfigured() is false and every surface stays inert, mirroring
 * how stripe.ts behaves without STRIPE_SECRET_KEY. Required env at launch:
 *   PADDLE_API_KEY        server-side API key (Paddle → Developer tools)
 *   PADDLE_PRO_PRICE_ID   the $7.99/mo price (pri_…) with the 7-day trial
 *   PADDLE_WEBHOOK_SECRET notification endpoint secret (webhook signature)
 *   PADDLE_ENV            "sandbox" for the sandbox account; unset = live
 */

// Paddle signs webhooks with ts + HMAC; reject anything older than this to
// bound replay of a captured payload (Paddle's own guidance is 5 seconds for
// real-time needs; we allow generous clock skew since dedup also guards us).
const SIGNATURE_MAX_AGE_SECONDS = 300;

export function isPaddleConfigured(): boolean {
  return Boolean(process.env.PADDLE_API_KEY && process.env.PADDLE_PRO_PRICE_ID);
}

function apiBase(): string {
  return process.env.PADDLE_ENV === "sandbox"
    ? "https://sandbox-api.paddle.com"
    : "https://api.paddle.com";
}

/**
 * Verify a Paddle-Signature header ("ts=<unix>;h1=<hex>") against the raw
 * request body: h1 = HMAC-SHA256(secret, `${ts}:${rawBody}`). Constant-time
 * compare — this header is the only gate on a route that grants PRO.
 */
export function verifyPaddleSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  nowMs: number = Date.now(),
): boolean {
  if (!header) return false;
  const parts = new Map<string, string>();
  for (const piece of header.split(";")) {
    const eq = piece.indexOf("=");
    if (eq > 0) parts.set(piece.slice(0, eq).trim(), piece.slice(eq + 1).trim());
  }
  const ts = Number(parts.get("ts"));
  const h1 = parts.get("h1");
  if (!Number.isFinite(ts) || !h1) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - ts) > SIGNATURE_MAX_AGE_SECONDS) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${ts}:${rawBody}`).digest("hex");
  return timingSafeEqualStr(h1, expected);
}

async function paddleFetch(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.PADDLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Body may carry request ids useful for support; it never contains our key.
    const detail = await res.text().catch(() => "");
    throw new Error(`Paddle API ${path} failed: ${res.status} ${detail.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Create a hosted-checkout transaction for the PRO subscription and return
 * the checkout URL (same contract as the Stripe path: POST /api/billing/
 * checkout → { url }). Requires the "default payment link" domain to be
 * configured in Paddle → Checkout settings, otherwise Paddle omits the URL —
 * we fail loud so the founder sees the misconfiguration at test time.
 * custom_data.userId is what the webhook uses to map the subscription back
 * to the Klorn account, so it must always be set here.
 */
export async function createPaddleCheckout(opts: {
  userId: string;
  email: string;
}): Promise<string> {
  const data = (await paddleFetch("/transactions", {
    items: [{ price_id: process.env.PADDLE_PRO_PRICE_ID, quantity: 1 }],
    custom_data: { userId: opts.userId },
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
 * Create a customer-portal session (manage/cancel subscription) and return
 * the overview URL. Same contract as the Stripe billing-portal path.
 */
export async function createPaddlePortalUrl(customerId: string): Promise<string> {
  const data = (await paddleFetch(
    `/customers/${encodeURIComponent(customerId)}/portal-sessions`,
    {},
  )) as { data?: { urls?: { general?: { overview?: string | null } } } };
  const url = data?.data?.urls?.general?.overview;
  if (!url) throw new Error("Paddle portal session returned no overview url");
  return url;
}
