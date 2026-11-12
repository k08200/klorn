/**
 * The service worker's click receipt (packages/web/public/sw.js), executed in a
 * sandbox with a stub `self`. Production has recorded zero web-push clicks
 * (PushDeliveryLog.clickedAt) while the same browser posts "received" for
 * nearly every push, so this pins the click path end to end on the SW side:
 * a click POSTs `{ event: "clicked" }` to the receipt URL the push carried (the
 * same request the "received" receipt makes) alongside opening the page, for a
 * plain click and for each action. The server side is pinned by
 * routes-notifications.test.ts ("records push receipts without auth") and
 * push-delivery.test.ts (recordPushReceipt "clicked").
 *
 * Also: a meeting push opens the event page in the app (background.ts), and an
 * https join link handed to the SW as a url is still refused.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const SW_SOURCE = readFileSync(resolve(__dirname, "../../../web/public/sw.js"), "utf8");
const ORIGIN = "https://app.klorn.ai";
const API = "https://api.klorn.ai";
const RECEIPT_URL = `${API}/api/notifications/push/receipts/delivery-1`;

type Handler = (event: unknown) => void;

function loadServiceWorker() {
  const handlers = new Map<string, Handler>();
  const showNotification = vi.fn(async () => {});
  const openWindow = vi.fn(async () => null);
  const fetch = vi.fn(async () => ({ ok: true }));
  const cache = { match: async () => undefined, put: async () => {} };
  const self = {
    addEventListener: (type: string, fn: Handler) => handlers.set(type, fn),
    skipWaiting: () => {},
    location: { origin: ORIGIN },
    registration: { showNotification },
    clients: { matchAll: async () => [], openWindow, claim: () => {} },
  };
  runInNewContext(SW_SOURCE, {
    self,
    caches: { open: async () => cache },
    fetch,
    console: { log() {}, warn() {}, error() {} },
    URL,
    Response,
  });
  return { handlers, showNotification, openWindow, fetch };
}

type Sw = ReturnType<typeof loadServiceWorker>;

async function dispatch(sw: Sw, type: string, event: Record<string, unknown>): Promise<void> {
  const pending: Promise<unknown>[] = [];
  sw.handlers.get(type)?.({ ...event, waitUntil: (p: Promise<unknown>) => pending.push(p) });
  await Promise.all(pending);
}

/** Show the push, then click the notification the browser stored, as Chrome does. */
async function pushThenClick(sw: Sw, payload: unknown, action = ""): Promise<void> {
  await dispatch(sw, "push", { data: { text: () => JSON.stringify(payload) } });
  const [, options] = sw.showNotification.mock.calls[0] as unknown as [
    string,
    { data: Record<string, unknown> },
  ];
  // A notification's data is structured-cloned by the browser.
  const stored = structuredClone(options.data);
  await dispatch(sw, "notificationclick", { notification: { data: stored, close() {} }, action });
}

function receipts(sw: Sw): Array<{ url: string; event: string }> {
  return sw.fetch.mock.calls
    .filter(([url]) => url === RECEIPT_URL)
    .map(([url, init]) => ({
      url: String(url),
      event: JSON.parse((init as { body: string }).body).event,
    }));
}

const MAIL = {
  title: "Kim",
  body: "Contract\nSignature needed today",
  url: "/email/email-1",
  actions: [
    { action: "reply", title: "Reply" },
    { action: "later", title: "Later" },
  ],
  replyUrl: "/email/email-1?focus=reply",
  bellNotificationId: "notif-1",
  deliveryId: "delivery-1",
  receiptUrl: RECEIPT_URL,
};

describe("sw.js — click receipt", () => {
  it("a plain click posts 'clicked' to the receipt URL and opens the mail", async () => {
    const sw = loadServiceWorker();
    await pushThenClick(sw, MAIL);
    expect(receipts(sw)).toEqual([
      { url: RECEIPT_URL, event: "received" },
      { url: RECEIPT_URL, event: "clicked" },
    ]);
    const clickedCall = sw.fetch.mock.calls.find(
      ([url, init]) =>
        url === RECEIPT_URL && JSON.parse((init as { body: string }).body).event === "clicked",
    );
    expect(clickedCall?.[1]).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(sw.openWindow).toHaveBeenCalledWith("/email/email-1");
  });

  it.each(["reply", "later"])("the %s action posts 'clicked' too", async (action) => {
    const sw = loadServiceWorker();
    await pushThenClick(sw, MAIL, action);
    expect(receipts(sw).map((r) => r.event)).toEqual(["received", "clicked"]);
  });

  it("a push without a receipt URL posts nothing and still opens", async () => {
    const sw = loadServiceWorker();
    await pushThenClick(sw, { ...MAIL, receiptUrl: null });
    expect(sw.fetch).not.toHaveBeenCalled();
    expect(sw.openWindow).toHaveBeenCalledWith("/email/email-1");
  });
});

describe("sw.js — meeting push target", () => {
  it("opens the event page the server names", async () => {
    const sw = loadServiceWorker();
    await pushThenClick(sw, {
      title: "Meeting in 3 min",
      body: "Standup",
      url: "/calendar/cal-row-1",
      deliveryId: "delivery-1",
      receiptUrl: RECEIPT_URL,
    });
    expect(sw.openWindow).toHaveBeenCalledWith("/calendar/cal-row-1");
  });

  it("never opens an https join link handed to it as the url", async () => {
    const sw = loadServiceWorker();
    await pushThenClick(sw, {
      title: "Meeting in 3 min",
      body: "Standup",
      url: "https://meet.google.com/abc-defg-hij",
    });
    expect(sw.openWindow).toHaveBeenCalledWith("/chat");
  });
});
