import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, isEntitlementRefusal, type Transport } from "./client";
import { endpoints } from "./endpoints";
import { createMockTransport, MOCK_TOKEN } from "./mock/transport";

function recording(response: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport: Transport = async (url, init) => {
    calls.push({ url, init });
    return response();
  };
  return { calls, transport };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("api client", () => {
  it("sends the Bearer token and JSON to the configured base", async () => {
    const { calls, transport } = recording(() => json(200, { ok: true }));
    const api = createApiClient({ baseUrl: "https://api.test", getToken: () => "jwt", transport });
    await api.post("/api/x", { a: 1 });
    expect(calls[0]?.url).toBe("https://api.test/api/x");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer jwt");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(calls[0]?.init.body).toBe('{"a":1}');
  });

  it("omits the token on anonymous calls", async () => {
    const { calls, transport } = recording(() => json(200, {}));
    const api = createApiClient({ baseUrl: "https://api.test", getToken: () => "jwt", transport });
    await api.get("/api/auth/providers", { anonymous: true });
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("a 401 on a data call ends the session; on login it does not", async () => {
    const onUnauthorized = vi.fn();
    const { transport } = recording(() => json(401, { error: "Not authenticated" }));
    const api = createApiClient({
      baseUrl: "https://a",
      getToken: () => "jwt",
      transport,
      onUnauthorized,
    });
    await expect(api.get("/api/auth/me")).rejects.toMatchObject({
      kind: "unauthorized",
      status: 401,
    });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    await expect(api.post("/api/auth/login", {})).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("maps HTTP errors with the server message", async () => {
    const { transport } = recording(() => json(429, { error: "Too many" }));
    const api = createApiClient({ baseUrl: "https://a", getToken: () => null, transport });
    const err = await api.get("/api/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ kind: "http", status: 429, serverMessage: "Too many" });
  });

  it("keeps the server's machine-readable code", async () => {
    const { transport } = recording(() =>
      json(403, { error: "Pro only", code: "ENTITLEMENT_REQUIRED" }),
    );
    const api = createApiClient({ baseUrl: "https://a", getToken: () => null, transport });
    const err = await api.get("/api/x").catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 403, serverMessage: "Pro only" });
    expect((err as ApiError).serverCode).toBe("ENTITLEMENT_REQUIRED");
    // Absent or not a string: no code.
    const bare = recording(() => json(500, { error: "x", code: 7 }));
    const other = createApiClient({
      baseUrl: "https://a",
      getToken: () => null,
      transport: bare.transport,
    });
    expect(
      ((await other.get("/api/x").catch((e: unknown) => e)) as ApiError).serverCode,
    ).toBeNull();
  });

  it("maps a failed fetch to an offline error", async () => {
    const api = createApiClient({
      baseUrl: "https://a",
      getToken: () => null,
      transport: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const err = (await api.get("/api/x").catch((e: unknown) => e)) as ApiError;
    expect(err.kind).toBe("network");
    expect(err.isOffline).toBe(true);
  });

  it("times out", async () => {
    const api = createApiClient({
      baseUrl: "https://a",
      getToken: () => null,
      timeoutMs: 20,
      transport: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    });
    await expect(api.get("/api/slow")).rejects.toMatchObject({ kind: "timeout", isOffline: true });
  });

  it("builds the real routes", async () => {
    const { calls, transport } = recording(() => json(200, { ok: true }));
    const ep = endpoints(createApiClient({ baseUrl: "https://a", getToken: () => "t", transport }));
    await ep.mail.list({ tier: "PUSH", page: 2, inbox: "all", search: " x " });
    await ep.mail.firewall("primary");
    await ep.calendar.events(new Date("2026-10-16T00:00:00Z"), new Date("2026-10-17T00:00:00Z"));
    await ep.triage.done("att 1");
    await ep.triage.moveLane("e1", "SILENT");
    await ep.triage.snooze("att-1", new Date("2026-10-16T12:00:00Z"));
    await ep.triage.pinSender("e1", "PUSH");
    await ep.auth.desktopToken("n1", "verifier");
    await ep.triage.doneByEmail("e 2");
    await ep.triage.snoozeByEmail("e2", new Date("2026-10-16T12:00:00Z"));
    await ep.compose.send({
      to: "a@b.example",
      subject: "s",
      body: "b",
      linkedInboxAccountId: "w",
    });
    expect(calls.map((c) => `${c.init.method} ${c.url.replace("https://a", "")}`)).toEqual([
      // hideHandled=1: Done / Later from any device are left out by the server.
      "GET /api/email?search=x&page=2&tier=PUSH&hideHandled=1",
      "GET /api/inbox/firewall?inbox=primary",
      "GET /api/calendar?start=2026-10-16T00%3A00%3A00.000Z&end=2026-10-17T00%3A00%3A00.000Z",
      "POST /api/inbox/firewall/att%201/dismiss",
      "POST /api/inbox/firewall/email/e1",
      "POST /api/inbox/firewall/att-1/snooze",
      "POST /api/email/e1/pin-tier",
      "GET /api/auth/desktop-token/n1",
      "POST /api/inbox/firewall/email/e%202/dismiss",
      "POST /api/inbox/firewall/email/e2/snooze",
      "POST /api/email/send",
    ]);
    expect(calls[9]?.init.body).toBe('{"snoozeUntil":"2026-10-16T12:00:00.000Z"}');
    expect(JSON.parse(String(calls[10]?.init.body))).toEqual({
      to: "a@b.example",
      subject: "s",
      body: "b",
      linkedInboxAccountId: "w",
    });
    expect(calls[4]?.init.body).toBe('{"tier":"SILENT"}');
    expect((calls[7]?.init.headers as Record<string, string>)["x-desktop-verifier"]).toBe(
      "verifier",
    );
    expect(calls[7]?.init.headers).not.toHaveProperty("Authorization");
    expect(ep.auth.socialLoginUrl("apple", "n", "ai.klorn.app")).toBe(
      "https://a/api/auth/apple/login?source=desktop&nonce=n&appScheme=ai.klorn.app",
    );
  });
});

describe("mock transport", () => {
  const now = Date.parse("2026-10-16T01:28:00Z");
  const client = (scenario: "default" | "empty" | "error") =>
    endpoints(
      createApiClient({
        baseUrl: "https://mock",
        getToken: () => MOCK_TOKEN,
        transport: createMockTransport({ scenario: () => scenario, now: () => now }),
      }),
    );

  it("serves realistic fixtures typed by the contract", async () => {
    const ep = client("default");
    const fw = await ep.mail.firewall();
    expect(fw.tiers.PUSH[0]?.tierReason).toBeTruthy();
    expect(fw.tiers.AUTO).toEqual([]);
    const counts = await ep.mail.laneCounts();
    expect(Object.keys(counts.counts).sort()).toEqual([
      "INFO",
      "MEETING",
      "PUSH",
      "QUEUE",
      "SILENT",
    ]);
  });

  it("empty and error scenarios", async () => {
    expect((await client("empty").assistant.pendingActions()).actions).toEqual([]);
    await expect(client("error").mail.firewall()).rejects.toMatchObject({ status: 500 });
  });

  it("refuses unauthenticated data reads", async () => {
    const ep = endpoints(
      createApiClient({
        baseUrl: "https://mock",
        getToken: () => null,
        transport: createMockTransport({ scenario: () => "default" }),
      }),
    );
    await expect(ep.auth.me()).rejects.toMatchObject({ status: 401 });
  });
});

describe("isEntitlementRefusal: the only refusal that means needs-Pro", () => {
  const http = (status: number, serverCode: string | null) =>
    new ApiError("http", status, `HTTP ${status}`, "server text", serverCode);

  it("is a 403 that carries ENTITLEMENT_REQUIRED", () => {
    expect(isEntitlementRefusal(http(403, "ENTITLEMENT_REQUIRED"))).toBe(true);
  });

  it("is not any other 403 (forbidden row, demo user, CSRF)", () => {
    expect(isEntitlementRefusal(http(403, null))).toBe(false);
    expect(isEntitlementRefusal(http(403, "SOMETHING_ELSE"))).toBe(false);
  });

  it("is not a 402 (the API never answers 402 to a client) or a server error", () => {
    expect(isEntitlementRefusal(http(402, null))).toBe(false);
    expect(isEntitlementRefusal(http(402, "ENTITLEMENT_REQUIRED"))).toBe(false);
    expect(isEntitlementRefusal(http(500, "ENTITLEMENT_REQUIRED"))).toBe(false);
  });

  it("is not a non-API error", () => {
    expect(isEntitlementRefusal(new Error("ENTITLEMENT_REQUIRED"))).toBe(false);
    expect(isEntitlementRefusal(null)).toBe(false);
  });
});
