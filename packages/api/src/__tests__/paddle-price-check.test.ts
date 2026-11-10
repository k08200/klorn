import { describe, expect, it } from "vitest";
import { comparePaddlePrice, parseAdvertisedAmount } from "../billing/paddle-price-check.js";

/**
 * The 2026-08-12 incident: the app advertised $7.99 while Paddle charged
 * $8.99. lib/pricing.ts was created so the pages agree with each other, and
 * check-price-consistency.mjs so the static pages agree with lib/pricing.ts —
 * but neither can see the Paddle price object, which is where the number that
 * actually bills someone lives. These are the checks for that last gap.
 */

/** The shape Paddle returns from GET /prices/{id}, trimmed to what we read. */
function paddlePrice(over: Record<string, unknown> = {}) {
  return {
    id: "pri_01abc",
    status: "active",
    unit_price: { amount: "3000", currency_code: "USD" },
    billing_cycle: { interval: "month", frequency: 1 },
    trial_period: { interval: "day", frequency: 7 },
    tax_mode: "account_setting",
    ...over,
  };
}

describe("parseAdvertisedAmount", () => {
  it("reads the plain dollar form", () => {
    expect(parseAdvertisedAmount("$30")).toBe(30);
    expect(parseAdvertisedAmount("$34.99")).toBe(34.99);
  });

  // de and fr write prices as "30 $". A dollar-first parser skips them
  // silently, which is how those two landings came to disagree with their own
  // price card before 2026-10-14.
  it("reads the European trailing-sign form", () => {
    expect(parseAdvertisedAmount("30 $")).toBe(30);
    expect(parseAdvertisedAmount("8,99 $")).toBe(8.99);
  });

  it("refuses anything it cannot read rather than guessing", () => {
    expect(() => parseAdvertisedAmount("")).toThrow();
    expect(() => parseAdvertisedAmount("free")).toThrow();
    expect(() => parseAdvertisedAmount("$0")).toThrow();
  });
});

describe("comparePaddlePrice", () => {
  it("passes when Paddle bills exactly what the site advertises", () => {
    const result = comparePaddlePrice({ advertised: "$30", price: paddlePrice() });
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  // The whole point. Paddle stores minor units, so a $30 page against a
  // $8.99 price object is amount "899" — this is the 2026-08-12 shape.
  it("catches Paddle charging less than the page advertises", () => {
    const result = comparePaddlePrice({
      advertised: "$30",
      price: paddlePrice({ unit_price: { amount: "899", currency_code: "USD" } }),
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("8.99");
    expect(result.problems.join(" ")).toContain("$30");
  });

  // The direction with actual legal exposure: billed more than quoted.
  it("catches Paddle charging more than the page advertises", () => {
    const result = comparePaddlePrice({
      advertised: "$8.99",
      price: paddlePrice(),
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/charges more/i);
  });

  // The site quotes dollars. A price object in another currency is not a
  // mismatch the amount check can see.
  it("catches a non-USD price object", () => {
    const result = comparePaddlePrice({
      advertised: "$30",
      price: paddlePrice({ unit_price: { amount: "3000", currency_code: "EUR" } }),
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("EUR");
  });

  // Every price surface says "7-day Pro trial". createPaddleCheckout sends
  // only price_id and quantity, so the trial exists on the price object or it
  // does not exist at all, and the first charge lands immediately.
  it("catches a price created without the 7-day trial", () => {
    const result = comparePaddlePrice({
      advertised: "$30",
      price: paddlePrice({ trial_period: null }),
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/trial/i);
  });

  it("catches a trial of the wrong length", () => {
    const result = comparePaddlePrice({
      advertised: "$30",
      price: paddlePrice({ trial_period: { interval: "day", frequency: 14 } }),
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/14/);
  });

  it("catches an archived price still wired up", () => {
    const result = comparePaddlePrice({
      advertised: "$30",
      price: paddlePrice({ status: "archived" }),
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/archived/i);
  });

  // Paddle is a third party; a shape change must not read as "price agrees".
  it("reports rather than passes when the response is not the expected shape", () => {
    for (const bad of [null, undefined, {}, { unit_price: {} }, "nope", 42]) {
      const result = comparePaddlePrice({ advertised: "$30", price: bad });
      expect(result.ok).toBe(false);
      expect(result.problems.length).toBeGreaterThan(0);
    }
  });

  it("collects every problem rather than stopping at the first", () => {
    const result = comparePaddlePrice({
      advertised: "$30",
      price: paddlePrice({
        status: "archived",
        unit_price: { amount: "899", currency_code: "EUR" },
        trial_period: null,
      }),
    });
    expect(result.problems.length).toBeGreaterThanOrEqual(4);
  });
});

describe("billing_cycle", () => {
  // $29.99 a YEAR matches on amount and is a different product. Review found
  // this; the first version of the comparator passed it.
  it("catches a yearly cycle quoted as monthly", () => {
    const result = comparePaddlePrice({
      advertised: "$29.99",
      price: paddlePrice({
        unit_price: { amount: "2999", currency_code: "USD" },
        billing_cycle: { interval: "year", frequency: 1 },
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/year/);
  });

  it("catches a one-time price (no billing_cycle)", () => {
    const result = comparePaddlePrice({
      advertised: "$29.99",
      price: paddlePrice({
        unit_price: { amount: "2999", currency_code: "USD" },
        billing_cycle: null,
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/one-time/);
  });

  it("catches billing every 3 months", () => {
    const result = comparePaddlePrice({
      advertised: "$29.99",
      price: paddlePrice({
        unit_price: { amount: "2999", currency_code: "USD" },
        billing_cycle: { interval: "month", frequency: 3 },
      }),
    });
    expect(result.ok).toBe(false);
  });
});

describe("tax_mode", () => {
  // "external" bills the quoted price PLUS tax, so the card is charged more
  // than any page says — the same class of problem as a wrong amount.
  it("catches tax added on top of the quoted price", () => {
    const result = comparePaddlePrice({
      advertised: "$29.99",
      price: paddlePrice({
        unit_price: { amount: "2999", currency_code: "USD" },
        tax_mode: "external",
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/tax/i);
  });
});

describe("amount formatting and precision", () => {
  it("prints whole cents rather than a truncated float", () => {
    const result = comparePaddlePrice({
      advertised: "$29.99",
      price: paddlePrice({ unit_price: { amount: "2950", currency_code: "USD" } }),
    });
    expect(result.problems.join(" ")).toContain("$29.50");
    expect(result.problems.join(" ")).not.toContain("$29.5 ");
  });

  it("accepts a one-week trial as seven days", () => {
    const result = comparePaddlePrice({
      advertised: "$29.99",
      price: paddlePrice({
        unit_price: { amount: "2999", currency_code: "USD" },
        trial_period: { interval: "week", frequency: 1 },
      }),
    });
    expect(result.ok).toBe(true);
  });

  it("rejects fractional minor units rather than rounding them away", () => {
    const result = comparePaddlePrice({
      advertised: "$29.99",
      price: paddlePrice({ unit_price: { amount: "2999.4", currency_code: "USD" } }),
    });
    expect(result.ok).toBe(false);
  });
});

describe("tax_mode account_setting", () => {
  // The Paddle default defers to the account-level choice, which the price
  // object does not carry. Accepted rather than raised — alarming on the
  // default value would fire for most correctly-configured accounts and teach
  // everyone to ignore this check. Verifying the account default is a one-off
  // founder step, not a per-boot alarm.
  it("does not fail the comparison", () => {
    const result = comparePaddlePrice({
      advertised: "$29.99",
      price: paddlePrice({
        unit_price: { amount: "2999", currency_code: "USD" },
        tax_mode: "account_setting",
      }),
    });
    expect(result.ok).toBe(true);
  });

  it("still fails on an explicitly external price", () => {
    const result = comparePaddlePrice({
      advertised: "$29.99",
      price: paddlePrice({
        unit_price: { amount: "2999", currency_code: "USD" },
        tax_mode: "external",
      }),
    });
    expect(result.ok).toBe(false);
  });
});
