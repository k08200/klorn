/**
 * Klorn Teams seat billing scaffold (billing/paddle-team.ts): team prices come
 * from env only (unset = checkout off), the checkout is quantity-based and
 * names the organization — never a user, so the Pro webhook path can never
 * map it to an account and write User.plan — and a subscription event is
 * recognised as a team one by its custom data or its price.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPaddleTeamCheckout,
  isTeamSubscriptionEvent,
  teamBillingInterval,
  teamCheckoutIntervals,
  teamPriceIdFor,
  teamSeatQuantity,
} from "../billing/paddle-team.js";

const ORIGINAL_ENV = { ...process.env };
const ORG_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  delete process.env.PADDLE_TEAM_PRICE_ID_MONTHLY;
  delete process.env.PADDLE_TEAM_PRICE_ID_ANNUAL;
  delete process.env.PADDLE_API_KEY;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe("team prices from env", () => {
  it("offers no checkout while the prices or the API key are unset", () => {
    expect(teamPriceIdFor("month")).toBeNull();
    expect(teamCheckoutIntervals()).toEqual([]);
    process.env.PADDLE_TEAM_PRICE_ID_MONTHLY = "pri_team_month";
    expect(teamCheckoutIntervals()).toEqual([]);
    process.env.PADDLE_API_KEY = "test-key";
    expect(teamCheckoutIntervals()).toEqual(["month"]);
    process.env.PADDLE_TEAM_PRICE_ID_ANNUAL = "pri_team_year";
    expect(teamCheckoutIntervals()).toEqual(["month", "year"]);
    expect(teamPriceIdFor("year")).toBe("pri_team_year");
  });

  it("treats a blank env value as unset", () => {
    process.env.PADDLE_API_KEY = "test-key";
    process.env.PADDLE_TEAM_PRICE_ID_MONTHLY = "   ";
    expect(teamPriceIdFor("month")).toBeNull();
    expect(teamCheckoutIntervals()).toEqual([]);
  });
});

describe("team checkout", () => {
  it("creates a quantity-based transaction that names the organization, not a user", async () => {
    process.env.PADDLE_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { checkout: { url: "https://pay.example/checkout" } } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const url = await createPaddleTeamCheckout({
      orgId: ORG_ID,
      priceId: "pri_team_month",
      quantity: 7,
    });
    expect(url).toBe("https://pay.example/checkout");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      items: [{ price_id: "pri_team_month", quantity: 7 }],
      custom_data: { orgId: ORG_ID, kind: "team_seats" },
    });
    expect(body.custom_data).not.toHaveProperty("userId");
  });

  it("fails loud when Paddle returns no checkout url", async () => {
    process.env.PADDLE_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ data: {} }) })),
    );
    await expect(
      createPaddleTeamCheckout({ orgId: ORG_ID, priceId: "pri_team_month", quantity: 2 }),
    ).rejects.toThrow(/no checkout url/);
  });
});

describe("recognising a team subscription event", () => {
  it("knows it by the custom data the team checkout set", () => {
    expect(isTeamSubscriptionEvent({ custom_data: { orgId: ORG_ID, kind: "team_seats" } })).toBe(
      true,
    );
  });

  it("knows it by a team price even without custom data", () => {
    process.env.PADDLE_TEAM_PRICE_ID_ANNUAL = "pri_team_year";
    expect(
      isTeamSubscriptionEvent({ items: [{ price: { id: "pri_team_year" }, quantity: 3 }] }),
    ).toBe(true);
  });

  it("leaves a Pro subscription event to the Pro path", () => {
    process.env.PADDLE_TEAM_PRICE_ID_MONTHLY = "pri_team_month";
    expect(
      isTeamSubscriptionEvent({
        custom_data: { userId: "11111111-1111-4111-8111-111111111111" },
        items: [{ price: { id: "pri_pro" }, quantity: 1 }],
      }),
    ).toBe(false);
    expect(isTeamSubscriptionEvent({})).toBe(false);
  });

  it("reads the seat count from the team items and the interval from the billing cycle", () => {
    process.env.PADDLE_TEAM_PRICE_ID_MONTHLY = "pri_team_month";
    const data = {
      custom_data: { orgId: ORG_ID, kind: "team_seats" },
      items: [
        { price: { id: "pri_team_month" }, quantity: 5 },
        { price: { id: "pri_addon" }, quantity: 1 },
      ],
      billing_cycle: { interval: "month", frequency: 1 },
    };
    expect(teamSeatQuantity(data)).toBe(5);
    expect(teamBillingInterval(data)).toBe("month");
    expect(teamBillingInterval({ billing_cycle: { interval: "year" } })).toBe("year");
    expect(teamBillingInterval({ billing_cycle: { interval: "week" } })).toBeNull();
  });

  it("falls back to every item's quantity when the team price env changed", () => {
    const data = {
      custom_data: { orgId: ORG_ID, kind: "team_seats" },
      items: [{ price: { id: "pri_old_team" }, quantity: 4 }],
    };
    expect(teamSeatQuantity(data)).toBe(4);
    expect(teamSeatQuantity({ custom_data: { kind: "team_seats" } })).toBeNull();
  });
});
