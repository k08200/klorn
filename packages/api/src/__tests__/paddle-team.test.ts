/**
 * Klorn Teams seat billing scaffold (billing/paddle-team.ts): team prices come
 * from env only (unset = checkout off), the checkout is quantity-based and
 * names the organization — never a user, so the Pro webhook path can never
 * map it to an account and write User.plan — and a subscription event is
 * recognised as a team one by its custom data or its price.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPaddleErrorCode, PaddleApiError } from "../billing/paddle.js";
import {
  createPaddleTeamCheckout,
  getPaddleCustomerEmail,
  getPaddleTeamSubscription,
  isTeamSubscriptionEvent,
  SEAT_CHANGE_PRORATION,
  setPaddleSeatQuantity,
  teamBillingInterval,
  teamCancelAt,
  teamCheckoutIntervals,
  teamPriceIdFor,
  teamPriceIds,
  teamSeatQuantity,
} from "../billing/paddle-team.js";

const ORIGINAL_ENV = { ...process.env };
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PAYER_ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  delete process.env.PADDLE_PRO_PRICE_ID;
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
  it("creates a quantity-based transaction that names the organization and its payer, never a Pro userId", async () => {
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
      payerUserId: PAYER_ID,
    });
    expect(url).toBe("https://pay.example/checkout");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      items: [{ price_id: "pri_team_month", quantity: 7 }],
      custom_data: { orgId: ORG_ID, kind: "team_seats", payerUserId: PAYER_ID },
    });
    // The Pro webhook path maps custom_data.userId to an account and writes
    // User.plan: the team checkout never sets that key.
    expect(body.custom_data).not.toHaveProperty("userId");
  });

  it("fails loud when Paddle returns no checkout url", async () => {
    process.env.PADDLE_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ data: {} }) })),
    );
    await expect(
      createPaddleTeamCheckout({
        orgId: ORG_ID,
        priceId: "pri_team_month",
        quantity: 2,
        payerUserId: PAYER_ID,
      }),
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

  it("counts every item only for the organization's own subscription (price rotated)", () => {
    const data = {
      custom_data: { orgId: ORG_ID, kind: "team_seats" },
      items: [{ price: { id: "pri_old_team" }, quantity: 4 }],
    };
    expect(teamSeatQuantity(data)).toBeNull();
    expect(teamSeatQuantity(data, { anyPrice: true })).toBe(4);
    expect(teamSeatQuantity({ custom_data: { kind: "team_seats" } })).toBeNull();
  });

  it("refuses a quantity that is not a whole number from 1 to 10,000", () => {
    process.env.PADDLE_TEAM_PRICE_ID_MONTHLY = "pri_team_month";
    const item = (quantity: number) => ({ items: [{ price: { id: "pri_team_month" }, quantity }] });
    for (const bad of [0, -2, 2.5, 10_001, Number.MAX_SAFE_INTEGER]) {
      expect(teamSeatQuantity(item(bad)), String(bad)).toBeNull();
    }
    expect(
      teamSeatQuantity({
        items: [
          { price: { id: "pri_team_month" }, quantity: 5 },
          { price: { id: "pri_team_month" }, quantity: -2 },
        ],
      }),
    ).toBeNull();
    expect(teamSeatQuantity(item(150))).toBe(150);
  });

  it("never treats the Pro price as a team price", () => {
    process.env.PADDLE_PRO_PRICE_ID = "pri_same";
    process.env.PADDLE_TEAM_PRICE_ID_MONTHLY = "pri_same";
    expect(teamPriceIds().size).toBe(0);
    expect(isTeamSubscriptionEvent({ items: [{ price: { id: "pri_same" }, quantity: 1 }] })).toBe(
      false,
    );
  });
});

describe("a scheduled cancel on a team subscription event", () => {
  it("reads the cancel date, clears it when Paddle says none, and keeps it when the event is silent", () => {
    expect(
      teamCancelAt({
        status: "active",
        scheduled_change: { action: "cancel", effective_at: "2026-12-14T00:00:00Z" },
      })?.toISOString(),
    ).toBe("2026-12-14T00:00:00.000Z");
    expect(teamCancelAt({ status: "active", scheduled_change: null })).toBeNull();
    // A pause is a scheduled change, not a cancel.
    expect(
      teamCancelAt({
        status: "active",
        scheduled_change: { action: "pause", effective_at: "2026-12-14T00:00:00Z" },
      }),
    ).toBeNull();
    expect(
      teamCancelAt({ status: "active", scheduled_change: { action: "cancel", effective_at: "x" } }),
    ).toBeNull();
    expect(teamCancelAt({ status: "active" })).toBeUndefined();
    expect(
      teamCancelAt({
        status: "canceled",
        scheduled_change: { action: "cancel", effective_at: "2026-12-14T00:00:00Z" },
      }),
    ).toBeNull();
  });
});

describe("seat management calls to Paddle", () => {
  function stub(data: unknown) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return { ok: true, status: 200, json: async () => ({ data }) };
      }),
    );
    return calls;
  }

  it("reads the live subscription and customer with a bounded GET and no body", async () => {
    process.env.PADDLE_API_KEY = "test-key";
    const calls = stub({
      status: "active",
      scheduled_change: { action: "cancel", effective_at: "2026-12-14T00:00:00Z" },
      email: "payer@example.com",
      items: [{ price: { id: "pri_team_month" }, quantity: 4 }],
    });
    expect(await getPaddleTeamSubscription("sub_1", { timeoutMs: 6000 })).toEqual({
      status: "active",
      scheduledChange: "cancel",
      cancelEffectiveAt: "2026-12-14T00:00:00Z",
      items: [{ priceId: "pri_team_month", quantity: 4 }],
    });
    expect(await getPaddleCustomerEmail("ctm_1", { timeoutMs: 6000 })).toBe("payer@example.com");
    for (const { init } of calls) {
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.paddle.com/subscriptions/sub_1",
      "https://api.paddle.com/customers/ctm_1",
    ]);
  });

  it("sets the quantity on the given price, prorated now, and never applies a failed charge", async () => {
    process.env.PADDLE_API_KEY = "test-key";
    const calls = stub({});
    await setPaddleSeatQuantity(
      { subscriptionId: "sub_1", priceId: "pri_team_month", quantity: 7 },
      { timeoutMs: 6000 },
    );
    expect(calls[0]?.init.method).toBe("PATCH");
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      items: [{ price_id: "pri_team_month", quantity: 7 }],
      proration_billing_mode: SEAT_CHANGE_PRORATION,
      on_payment_failure: "prevent_change",
    });
    expect(SEAT_CHANGE_PRORATION).toBe("prorated_immediately");
  });
});

describe("Paddle API refusals", () => {
  function refuse(status: number, body: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status, text: async () => body })),
    );
  }

  it("carries the status and Paddle's error code, with the message unchanged", async () => {
    process.env.PADDLE_API_KEY = "test-key";
    refuse(
      400,
      '{"error":{"type":"request_error","code":"subscription_locked_pending_changes","detail":"Cannot update subscription, pending scheduled changes."}}',
    );
    const err = await setPaddleSeatQuantity({
      subscriptionId: "sub_1",
      priceId: "pri_team_month",
      quantity: 4,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaddleApiError);
    expect(err).toMatchObject({ status: 400, code: "subscription_locked_pending_changes" });
    expect((err as Error).message).toMatch(/^Paddle API \/subscriptions\/sub_1 failed: 400 /);
    expect(isPaddleErrorCode(err, "subscription_locked_pending_changes")).toBe(true);
    expect(isPaddleErrorCode(err, "not_found")).toBe(false);
  });

  it("has no code when the body is not Paddle's error envelope", async () => {
    process.env.PADDLE_API_KEY = "test-key";
    refuse(502, "<html>bad gateway</html>");
    const err = await getPaddleTeamSubscription("sub_1").catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502, code: null });
    expect(isPaddleErrorCode(err, "subscription_locked_pending_changes")).toBe(false);
    expect(isPaddleErrorCode(new Error("x"), "subscription_locked_pending_changes")).toBe(false);
  });
});
