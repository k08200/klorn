/**
 * The shipped receipt transport (packages/web/src/lib/native/desktop-receipts.ts
 * reportDesktopReceipt): one POST to the receipts endpoint with the session's
 * Bearer token, the endpoint's exact body, `keepalive` so a click's receipt
 * survives a navigation, and an abort signal so a hung request cannot stall
 * the queue. A raw fetch: a 401 is dropped, never retried, and never reaches
 * apiFetch's sign-out redirect.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ prisma: {} }));

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("../../../web/src/lib/api", () => ({
  API_BASE: "https://api.test",
  apiFetch,
  authHeaders: () => ({ "Content-Type": "application/json", Authorization: "Bearer jwt-1" }),
}));

const ID = "0b9f6c1e-4a51-4d1e-9c4f-2f7d1f0a9b3c";
const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<{ status: number }>>();

async function freshModule() {
  vi.resetModules();
  return import("../../../web/src/lib/native/desktop-receipts");
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("reportDesktopReceipt — the shipped transport", () => {
  it("POSTs the endpoint's body with the Bearer token, keepalive and a timeout", async () => {
    fetchMock.mockResolvedValue({ status: 204 });
    const { reportDesktopReceipt, RECEIPTS_PATH } = await freshModule();
    reportDesktopReceipt("clicked", ID);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.test${RECEIPTS_PATH}`);
    expect(RECEIPTS_PATH).toBe("/api/notifications/desktop/receipts");
    expect(init.method).toBe("POST");
    expect(init.keepalive).toBe(true);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toMatchObject({ Authorization: "Bearer jwt-1" });
    expect(JSON.parse(String(init.body))).toEqual({
      app: "windows",
      event: "clicked",
      kind: "notification",
      id: ID,
    });
  });

  it("a 401 is dropped: one request, no retry, no sign-out redirect", async () => {
    fetchMock.mockResolvedValue({ status: 401 });
    const { reportDesktopReceipt } = await freshModule();
    reportDesktopReceipt("shown", ID);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("an id without a receipt sends nothing", async () => {
    const { reportDesktopReceipt } = await freshModule();
    reportDesktopReceipt("shown", `missed:${ID}`);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
