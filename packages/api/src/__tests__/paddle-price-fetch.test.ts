import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkPaddlePriceEvent,
  checkPaddlePriceMatchesAdvertised,
} from "../billing/paddle-price-check.js";

/**
 * The comparator is covered in paddle-price-check.test.ts. This file covers
 * the two things that reach the outside world — the Paddle fetch and the
 * webhook path — which review found had no tests at all while the PR claimed
 * they were exercised through an injected fetchImpl.
 */

const ENV = ["PADDLE_API_KEY", "PADDLE_PRO_PRICE_ID", "PADDLE_ENV"] as const;
const ORIGINAL: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) ORIGINAL[k] = process.env[k];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
  vi.restoreAllMocks();
});

function priceBody(over: Record<string, unknown> = {}) {
  return {
    data: {
      id: "pri_live",
      status: "active",
      tax_mode: "account_setting",
      unit_price: { amount: "2999", currency_code: "USD" },
      billing_cycle: { interval: "month", frequency: 1 },
      trial_period: { interval: "day", frequency: 7 },
      ...over,
    },
  };
}

/** A fetch stand-in that records the call and returns what the test wants. */
function stubFetch(res: Partial<Response> & { jsonValue?: unknown }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: res.ok ?? true,
      status: res.status ?? 200,
      json: async () => res.jsonValue,
      text: async () => (typeof res.jsonValue === "string" ? res.jsonValue : ""),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("checkPaddlePriceMatchesAdvertised", () => {
  it("does nothing, and makes no request, when Paddle is not configured", async () => {
    delete process.env.PADDLE_API_KEY;
    delete process.env.PADDLE_PRO_PRICE_ID;
    const { impl, calls } = stubFetch({ jsonValue: priceBody() });
    const result = await checkPaddlePriceMatchesAdvertised({
      advertised: "$29.99",
      fetchImpl: impl,
    });
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("sends the key as a bearer header and nowhere else", async () => {
    process.env.PADDLE_API_KEY = "pdl_secret_value";
    process.env.PADDLE_PRO_PRICE_ID = "pri_live";
    delete process.env.PADDLE_ENV;
    const { impl, calls } = stubFetch({ jsonValue: priceBody() });
    await checkPaddlePriceMatchesAdvertised({ advertised: "$29.99", fetchImpl: impl });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.paddle.com/prices/pri_live");
    expect(calls[0].url).not.toContain("pdl_secret_value");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer pdl_secret_value",
    );
  });

  it("uses the sandbox host when PADDLE_ENV says so", async () => {
    process.env.PADDLE_API_KEY = "k";
    process.env.PADDLE_PRO_PRICE_ID = "pri_live";
    process.env.PADDLE_ENV = "sandbox";
    const { impl, calls } = stubFetch({ jsonValue: priceBody() });
    await checkPaddlePriceMatchesAdvertised({ advertised: "$29.99", fetchImpl: impl });
    expect(calls[0].url).toContain("sandbox-api.paddle.com");
  });

  // A sandbox price is a different object; alarming on it forever would train
  // everyone to ignore this check.
  it("reports but does not alert on a sandbox mismatch", async () => {
    process.env.PADDLE_API_KEY = "k";
    process.env.PADDLE_PRO_PRICE_ID = "pri_live";
    process.env.PADDLE_ENV = "sandbox";
    const { impl } = stubFetch({
      jsonValue: priceBody({ unit_price: { amount: "100", currency_code: "USD" } }),
    });
    const result = await checkPaddlePriceMatchesAdvertised({
      advertised: "$29.99",
      fetchImpl: impl,
    });
    expect(result?.ok).toBe(false);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("gives no answer rather than a false pass when Paddle refuses the read", async () => {
    process.env.PADDLE_API_KEY = "k";
    process.env.PADDLE_PRO_PRICE_ID = "pri_live";
    delete process.env.PADDLE_ENV;
    const { impl } = stubFetch({ ok: false, status: 403, jsonValue: "forbidden" });
    const result = await checkPaddlePriceMatchesAdvertised({
      advertised: "$29.99",
      fetchImpl: impl,
    });
    expect(result).toBeNull();
  });

  it("never throws when the transport fails", async () => {
    process.env.PADDLE_API_KEY = "k";
    process.env.PADDLE_PRO_PRICE_ID = "pri_live";
    const impl = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    await expect(
      checkPaddlePriceMatchesAdvertised({ advertised: "$29.99", fetchImpl: impl }),
    ).resolves.toBeNull();
  });

  it("never throws when the body is not JSON", async () => {
    process.env.PADDLE_API_KEY = "k";
    process.env.PADDLE_PRO_PRICE_ID = "pri_live";
    const impl = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
        text: async () => "<html>",
      }) as unknown as Response) as unknown as typeof fetch;
    await expect(
      checkPaddlePriceMatchesAdvertised({ advertised: "$29.99", fetchImpl: impl }),
    ).resolves.toBeNull();
  });

  it("reports a live mismatch", async () => {
    process.env.PADDLE_API_KEY = "k";
    process.env.PADDLE_PRO_PRICE_ID = "pri_live";
    delete process.env.PADDLE_ENV;
    const { impl } = stubFetch({
      jsonValue: priceBody({ unit_price: { amount: "899", currency_code: "USD" } }),
    });
    const result = await checkPaddlePriceMatchesAdvertised({
      advertised: "$29.99",
      fetchImpl: impl,
    });
    expect(result?.ok).toBe(false);
    expect(console.error).toHaveBeenCalled();
  });
});

describe("checkPaddlePriceEvent", () => {
  beforeEach(() => {
    process.env.PADDLE_PRO_PRICE_ID = "pri_live";
  });

  // The whole reason this path exists: both incidents were dashboard edits
  // with no deploy, so nothing booted and nothing noticed.
  it("catches a dashboard edit that breaks the advertised price", () => {
    const result = checkPaddlePriceEvent({
      eventType: "price.updated",
      advertised: "$8.99",
      data: priceBody().data,
    });
    expect(result?.ok).toBe(false);
    expect(result?.problems.join(" ")).toMatch(/charges more/i);
  });

  it("passes a dashboard edit that still matches", () => {
    const result = checkPaddlePriceEvent({
      eventType: "price.updated",
      advertised: "$29.99",
      data: priceBody().data,
    });
    expect(result?.ok).toBe(true);
  });

  it("ignores price events for a price we do not bill on", () => {
    const result = checkPaddlePriceEvent({
      eventType: "price.updated",
      advertised: "$29.99",
      data: { ...priceBody().data, id: "pri_some_other" },
    });
    expect(result).toBeNull();
  });

  it("ignores event types that are not about a price", () => {
    for (const eventType of ["subscription.updated", "transaction.completed", "product.updated"]) {
      expect(
        checkPaddlePriceEvent({ eventType, advertised: "$29.99", data: priceBody().data }),
      ).toBeNull();
    }
  });

  it("does nothing when no price id is configured", () => {
    delete process.env.PADDLE_PRO_PRICE_ID;
    expect(
      checkPaddlePriceEvent({
        eventType: "price.updated",
        advertised: "$29.99",
        data: priceBody().data,
      }),
    ).toBeNull();
  });

  it("does not throw on a malformed payload", () => {
    for (const data of [null, undefined, "nope", 42, {}]) {
      expect(() =>
        checkPaddlePriceEvent({ eventType: "price.updated", advertised: "$29.99", data }),
      ).not.toThrow();
    }
  });
});
