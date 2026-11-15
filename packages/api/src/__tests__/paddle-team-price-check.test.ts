import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Team seat prices: does Paddle bill what docs/design/pricing-tiers.md and
 * the Team settings page quote ($30 a seat a month, $312 a seat a year)? Same
 * guard as the Pro price (paddle-price-fetch.test.ts), run once at boot and on
 * every price.updated webhook. Paddle is never reached: fetch is injected.
 */

const captured = vi.hoisted(() => [] as Array<{ err: unknown; ctx: unknown }>);
vi.mock("../sentry.js", () => ({
  captureError: vi.fn((err: unknown, ctx: unknown) => captured.push({ err, ctx })),
}));

import {
  TEAM_STANDARD_SEAT_ANNUAL_CENTS,
  TEAM_STANDARD_SEAT_ANNUAL_PER_MONTH_CENTS,
  TEAM_STANDARD_SEAT_MONTHLY_CENTS,
} from "../billing/advertised-price.js";
import {
  checkTeamPaddlePriceEvent,
  checkTeamPaddlePrices,
  compareTeamPaddlePrice,
} from "../billing/paddle-team-price-check.js";

const ENV = [
  "PADDLE_API_KEY",
  "PADDLE_ENV",
  "PADDLE_PRO_PRICE_ID",
  "PADDLE_TEAM_PRICE_ID_MONTHLY",
  "PADDLE_TEAM_PRICE_ID_ANNUAL",
] as const;
const ORIGINAL: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) {
    ORIGINAL[k] = process.env[k];
    delete process.env[k];
  }
  captured.length = 0;
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

function price(over: Record<string, unknown> = {}) {
  return {
    id: "pri_team_month",
    status: "active",
    tax_mode: "account_setting",
    unit_price: { amount: "3000", currency_code: "USD" },
    billing_cycle: { interval: "month", frequency: 1 },
    trial_period: null,
    quantity: { minimum: 1, maximum: 150 },
    ...over,
  };
}

const ANNUAL = {
  id: "pri_team_year",
  unit_price: { amount: "31200", currency_code: "USD" },
  billing_cycle: { interval: "year", frequency: 1 },
};

/** Answers each price id with the object the test gives, and records the calls. */
function paddle(byId: Record<string, unknown>) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    const id = decodeURIComponent(url.split("/prices/")[1] ?? "");
    const data = byId[id];
    if (data === undefined) {
      return { ok: false, status: 404, text: async () => "not found" } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ data }) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("advertised team prices", () => {
  it("derive the annual charge from the per-month annual price, in one place", () => {
    expect(TEAM_STANDARD_SEAT_MONTHLY_CENTS).toBe(3000);
    expect(TEAM_STANDARD_SEAT_ANNUAL_PER_MONTH_CENTS).toBe(2600);
    expect(TEAM_STANDARD_SEAT_ANNUAL_CENTS).toBe(TEAM_STANDARD_SEAT_ANNUAL_PER_MONTH_CENTS * 12);
    expect(TEAM_STANDARD_SEAT_ANNUAL_CENTS).toBe(31200);
  });
});

describe("compareTeamPaddlePrice", () => {
  it("agrees with $30 a month and $312 a year, with no trial required", () => {
    expect(compareTeamPaddlePrice({ interval: "month", price: price() })).toEqual({
      ok: true,
      problems: [],
    });
    expect(compareTeamPaddlePrice({ interval: "year", price: price(ANNUAL) }).ok).toBe(true);
  });

  it("names a different amount, cycle, currency, tax mode or status", () => {
    const amount = compareTeamPaddlePrice({
      interval: "month",
      price: price({ unit_price: { amount: "2999", currency_code: "USD" } }),
    });
    expect(amount.ok).toBe(false);
    expect(amount.problems.join(" ")).toContain("$29.99");
    expect(amount.problems.join(" ")).toContain("$30.00");

    // $312 billed monthly is the right number on the wrong cycle.
    const cycle = compareTeamPaddlePrice({
      interval: "year",
      price: price({ ...ANNUAL, billing_cycle: { interval: "month", frequency: 1 } }),
    });
    expect(cycle.problems.join(" ")).toMatch(/per year/);

    const many = compareTeamPaddlePrice({
      interval: "month",
      price: price({
        unit_price: { amount: "3000", currency_code: "EUR" },
        tax_mode: "external",
        status: "archived",
      }),
    });
    expect(many.problems.join(" ")).toContain("EUR");
    expect(many.problems.join(" ")).toMatch(/tax/i);
    expect(many.problems.join(" ")).toContain("PADDLE_TEAM_PRICE_ID_MONTHLY");
  });

  it("names a quantity range that cannot sell every seat count from 2 to 150", () => {
    // Paddle's default range is 1–100: seats 101–150 would fail at Paddle.
    const narrow = compareTeamPaddlePrice({
      interval: "month",
      price: price({ quantity: { minimum: 1, maximum: 100 } }),
    });
    expect(narrow.ok).toBe(false);
    expect(narrow.problems.join(" ")).toMatch(/1–100.*2–150/);
    const floor = compareTeamPaddlePrice({
      interval: "month",
      price: price({ quantity: { minimum: 3, maximum: 150 } }),
    });
    expect(floor.ok).toBe(false);
    const missing = compareTeamPaddlePrice({ interval: "month", price: price({ quantity: null }) });
    expect(missing.problems.join(" ")).toMatch(/quantity range/);
  });

  it("treats an unreadable response as unconfirmed, never as agreeing", () => {
    for (const bad of [null, "nope", {}]) {
      expect(compareTeamPaddlePrice({ interval: "month", price: bad }).ok).toBe(false);
    }
  });
});

describe("checkTeamPaddlePrices", () => {
  it("does nothing while the key or the team prices are unset", async () => {
    const { impl, calls } = paddle({});
    expect(await checkTeamPaddlePrices({ fetchImpl: impl })).toEqual([]);
    process.env.PADDLE_API_KEY = "test-key";
    expect(await checkTeamPaddlePrices({ fetchImpl: impl })).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("reads each configured team price once and stays quiet when both agree", async () => {
    process.env.PADDLE_API_KEY = "test-key";
    process.env.PADDLE_TEAM_PRICE_ID_MONTHLY = "pri_team_month";
    process.env.PADDLE_TEAM_PRICE_ID_ANNUAL = "pri_team_year";
    const { impl, calls } = paddle({ pri_team_month: price(), pri_team_year: price(ANNUAL) });
    const results = await checkTeamPaddlePrices({ fetchImpl: impl });
    expect(results.map((r) => [r.interval, r.result?.ok])).toEqual([
      ["month", true],
      ["year", true],
    ]);
    expect(calls).toEqual([
      "https://api.paddle.com/prices/pri_team_month",
      "https://api.paddle.com/prices/pri_team_year",
    ]);
    expect(captured).toEqual([]);
  });

  it("alerts on a mismatch, and never throws", async () => {
    process.env.PADDLE_API_KEY = "test-key";
    process.env.PADDLE_TEAM_PRICE_ID_MONTHLY = "pri_team_month";
    const { impl } = paddle({
      pri_team_month: price({ unit_price: { amount: "3500", currency_code: "USD" } }),
    });
    const [only] = await checkTeamPaddlePrices({ fetchImpl: impl });
    expect(only?.result?.ok).toBe(false);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.ctx).toMatchObject({
      tags: { scope: "billing.paddle.team_price_mismatch" },
      extra: { priceId: "pri_team_month", interval: "month" },
    });
  });

  it("answers no result when Paddle cannot be read, and does not alert from the sandbox", async () => {
    process.env.PADDLE_API_KEY = "test-key";
    process.env.PADDLE_TEAM_PRICE_ID_MONTHLY = "pri_team_month";
    const down = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const [unread] = await checkTeamPaddlePrices({ fetchImpl: down });
    expect(unread?.result).toBeNull();

    process.env.PADDLE_ENV = "sandbox";
    const { impl, calls } = paddle({
      pri_team_month: price({ unit_price: { amount: "100", currency_code: "USD" } }),
    });
    const [sandbox] = await checkTeamPaddlePrices({ fetchImpl: impl });
    expect(sandbox?.result?.ok).toBe(false);
    expect(calls[0]).toContain("sandbox-api.paddle.com");
    expect(captured).toEqual([]);
  });
});

describe("checkTeamPaddlePriceEvent", () => {
  it("checks an edited team price and ignores every other price", () => {
    process.env.PADDLE_TEAM_PRICE_ID_ANNUAL = "pri_team_year";
    expect(
      checkTeamPaddlePriceEvent({ eventType: "price.updated", data: price({ id: "pri_other" }) }),
    ).toBeNull();
    expect(
      checkTeamPaddlePriceEvent({ eventType: "subscription.updated", data: price(ANNUAL) }),
    ).toBeNull();
    expect(checkTeamPaddlePriceEvent({ eventType: "price.updated", data: price(ANNUAL) })?.ok).toBe(
      true,
    );
    const edited = checkTeamPaddlePriceEvent({
      eventType: "price.updated",
      data: price({ ...ANNUAL, unit_price: { amount: "36000", currency_code: "USD" } }),
    });
    expect(edited?.ok).toBe(false);
    expect(captured[0]?.ctx).toMatchObject({
      tags: { scope: "billing.paddle.team_price_edited_mismatch" },
    });
  });
});
