import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = ["PADDLE_API_KEY", "PADDLE_PRO_PRICE_ID", "PADDLE_ENV"] as const;
const ORIGINAL: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) ORIGINAL[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
  vi.unstubAllGlobals();
});

function sign(rawBody: string, secret: string, ts: number): string {
  const h1 = crypto.createHmac("sha256", secret).update(`${ts}:${rawBody}`).digest("hex");
  return `ts=${ts};h1=${h1}`;
}

describe("isPaddleConfigured", () => {
  it("is false with no env at all", async () => {
    delete process.env.PADDLE_API_KEY;
    delete process.env.PADDLE_PRO_PRICE_ID;
    const { isPaddleConfigured } = await import("../billing/paddle.js");
    expect(isPaddleConfigured()).toBe(false);
  });

  it("is false with only the API key (no price)", async () => {
    process.env.PADDLE_API_KEY = "pdl_test_key";
    delete process.env.PADDLE_PRO_PRICE_ID;
    const { isPaddleConfigured } = await import("../billing/paddle.js");
    expect(isPaddleConfigured()).toBe(false);
  });

  it("is true with API key and PRO price id", async () => {
    process.env.PADDLE_API_KEY = "pdl_test_key";
    process.env.PADDLE_PRO_PRICE_ID = "pri_123";
    const { isPaddleConfigured } = await import("../billing/paddle.js");
    expect(isPaddleConfigured()).toBe(true);
  });
});

describe("verifyPaddleSignature", () => {
  const secret = "pdl_ntfset_secret";
  const body = '{"event_id":"evt_1","event_type":"subscription.activated"}';
  const nowMs = 1_700_000_000_000;
  const ts = Math.floor(nowMs / 1000);

  it("accepts a valid signature", async () => {
    const { verifyPaddleSignature } = await import("../billing/paddle.js");
    expect(verifyPaddleSignature(body, sign(body, secret, ts), secret, nowMs)).toBe(true);
  });

  it("rejects a signature computed with a different secret", async () => {
    const { verifyPaddleSignature } = await import("../billing/paddle.js");
    expect(verifyPaddleSignature(body, sign(body, "wrong", ts), secret, nowMs)).toBe(false);
  });

  it("rejects when the body was tampered with", async () => {
    const { verifyPaddleSignature } = await import("../billing/paddle.js");
    const sig = sign(body, secret, ts);
    expect(verifyPaddleSignature(`${body} `, sig, secret, nowMs)).toBe(false);
  });

  it("rejects a missing or malformed header", async () => {
    const { verifyPaddleSignature } = await import("../billing/paddle.js");
    expect(verifyPaddleSignature(body, undefined, secret, nowMs)).toBe(false);
    expect(verifyPaddleSignature(body, "", secret, nowMs)).toBe(false);
    expect(verifyPaddleSignature(body, "garbage", secret, nowMs)).toBe(false);
    expect(verifyPaddleSignature(body, "ts=abc;h1=", secret, nowMs)).toBe(false);
  });

  it("rejects a stale timestamp (replay guard)", async () => {
    const { verifyPaddleSignature } = await import("../billing/paddle.js");
    const staleTs = ts - 3600;
    expect(verifyPaddleSignature(body, sign(body, secret, staleTs), secret, nowMs)).toBe(false);
  });
});

describe("createPaddleCheckout", () => {
  it("POSTs a transaction with the PRO price and userId custom_data, returns the checkout url", async () => {
    process.env.PADDLE_API_KEY = "pdl_test_key";
    process.env.PADDLE_PRO_PRICE_ID = "pri_123";
    delete process.env.PADDLE_ENV;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ data: { checkout: { url: "https://buy.paddle.com/txn_1" } } }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { createPaddleCheckout } = await import("../billing/paddle.js");

    const url = await createPaddleCheckout({ userId: "u-1", email: "t@e.com" });

    expect(url).toBe("https://buy.paddle.com/txn_1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toBe("https://api.paddle.com/transactions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer pdl_test_key");
    const sent = JSON.parse(init.body as string);
    expect(sent.items).toEqual([{ price_id: "pri_123", quantity: 1 }]);
    expect(sent.custom_data).toEqual({ userId: "u-1" });
  });

  it("uses the sandbox API base when PADDLE_ENV=sandbox", async () => {
    process.env.PADDLE_API_KEY = "pdl_test_key";
    process.env.PADDLE_PRO_PRICE_ID = "pri_123";
    process.env.PADDLE_ENV = "sandbox";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ data: { checkout: { url: "https://sandbox-buy.paddle.com/t" } } }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { createPaddleCheckout } = await import("../billing/paddle.js");
    await createPaddleCheckout({ userId: "u-1", email: "t@e.com" });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      "https://sandbox-api.paddle.com/transactions",
    );
  });

  it("throws on a non-2xx API response (no silent failure)", async () => {
    process.env.PADDLE_API_KEY = "pdl_test_key";
    process.env.PADDLE_PRO_PRICE_ID = "pri_123";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 403,
        json: async () => ({}),
        text: async () => "forbidden",
      })),
    );
    const { createPaddleCheckout } = await import("../billing/paddle.js");
    await expect(createPaddleCheckout({ userId: "u-1", email: "t@e.com" })).rejects.toThrow(/403/);
  });

  it("throws when the response has no checkout url (default payment link not configured)", async () => {
    process.env.PADDLE_API_KEY = "pdl_test_key";
    process.env.PADDLE_PRO_PRICE_ID = "pri_123";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 201,
        json: async () => ({ data: { checkout: { url: null } } }),
        text: async () => "",
      })),
    );
    const { createPaddleCheckout } = await import("../billing/paddle.js");
    await expect(createPaddleCheckout({ userId: "u-1", email: "t@e.com" })).rejects.toThrow(
      /checkout url/i,
    );
  });
});

describe("createPaddlePortalUrl", () => {
  it("creates a customer portal session and returns the overview url", async () => {
    process.env.PADDLE_API_KEY = "pdl_test_key";
    process.env.PADDLE_PRO_PRICE_ID = "pri_123";
    delete process.env.PADDLE_ENV;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({
        data: { urls: { general: { overview: "https://customer-portal.paddle.com/x" } } },
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { createPaddlePortalUrl } = await import("../billing/paddle.js");

    const url = await createPaddlePortalUrl("ctm_1");

    expect(url).toBe("https://customer-portal.paddle.com/x");
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      "https://api.paddle.com/customers/ctm_1/portal-sessions",
    );
  });
});
