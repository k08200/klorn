import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_KEY = process.env.STRIPE_SECRET_KEY;
const ORIGINAL_PRICE = process.env.STRIPE_PRO_PRICE_ID;

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.STRIPE_SECRET_KEY;
  } else {
    process.env.STRIPE_SECRET_KEY = ORIGINAL_KEY;
  }
  if (ORIGINAL_PRICE === undefined) {
    delete process.env.STRIPE_PRO_PRICE_ID;
  } else {
    process.env.STRIPE_PRO_PRICE_ID = ORIGINAL_PRICE;
  }
});

// The web paywall degrades to a disabled state when this is false, so a
// native-IAP-only launch (no Stripe configured) never shows a dead checkout
// button on web.
describe("isWebCheckoutAvailable", () => {
  it("is false when STRIPE_SECRET_KEY is unset", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_PRO_PRICE_ID = "price_x";
    vi.resetModules();
    const { isWebCheckoutAvailable } = await import("../stripe.js");
    expect(isWebCheckoutAvailable()).toBe(false);
  });

  it("is false when the PRO price id is unset (checkout would 400)", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    delete process.env.STRIPE_PRO_PRICE_ID;
    vi.resetModules();
    const { isWebCheckoutAvailable } = await import("../stripe.js");
    expect(isWebCheckoutAvailable()).toBe(false);
  });

  it("is true when both the key and the PRO price id are configured", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    process.env.STRIPE_PRO_PRICE_ID = "price_x";
    vi.resetModules();
    const { isWebCheckoutAvailable } = await import("../stripe.js");
    expect(isWebCheckoutAvailable()).toBe(true);
  });
});
