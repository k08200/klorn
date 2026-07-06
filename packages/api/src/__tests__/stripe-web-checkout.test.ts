import { afterEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_PRO_PRICE_ID",
  "PADDLE_API_KEY",
  "PADDLE_PRO_PRICE_ID",
] as const;
const ORIGINAL: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) ORIGINAL[k] = process.env[k];

function clearAll() {
  for (const k of ENV_KEYS) delete process.env[k];
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
});

// The web paywall degrades to a disabled state when this is false, so a
// native-IAP-only launch (no web provider configured) never shows a dead
// checkout button on web. True when EITHER provider (Stripe or Paddle) can
// complete a checkout.
describe("isWebCheckoutAvailable", () => {
  it("is false with no provider configured at all", async () => {
    clearAll();
    process.env.STRIPE_PRO_PRICE_ID = "price_x";
    vi.resetModules();
    const { isWebCheckoutAvailable } = await import("../stripe.js");
    expect(isWebCheckoutAvailable()).toBe(false);
  });

  it("is false when the Stripe PRO price id is unset (checkout would 400)", async () => {
    clearAll();
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    vi.resetModules();
    const { isWebCheckoutAvailable } = await import("../stripe.js");
    expect(isWebCheckoutAvailable()).toBe(false);
  });

  it("is true when Stripe key and PRO price id are both configured", async () => {
    clearAll();
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    process.env.STRIPE_PRO_PRICE_ID = "price_x";
    vi.resetModules();
    const { isWebCheckoutAvailable } = await import("../stripe.js");
    expect(isWebCheckoutAvailable()).toBe(true);
  });

  it("is true with Paddle configured and no Stripe at all (MoR-only launch)", async () => {
    clearAll();
    process.env.PADDLE_API_KEY = "pdl_test_key";
    process.env.PADDLE_PRO_PRICE_ID = "pri_123";
    vi.resetModules();
    const { isWebCheckoutAvailable } = await import("../stripe.js");
    expect(isWebCheckoutAvailable()).toBe(true);
  });

  it("is false with only a partial Paddle config (key but no price)", async () => {
    clearAll();
    process.env.PADDLE_API_KEY = "pdl_test_key";
    vi.resetModules();
    const { isWebCheckoutAvailable } = await import("../stripe.js");
    expect(isWebCheckoutAvailable()).toBe(false);
  });
});
