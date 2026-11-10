/**
 * The service worker (packages/web/public/sw.js) and an open tab must give one
 * bell notification the SAME OS tag, so a Web Push and an in-page notification
 * for the same PUSH mail never stack as two (the OS replaces same-tag
 * notifications). The shipped sw.js is executed in a sandbox with a stub
 * `self`, and its tag is compared with the tab's notificationTag().
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { notificationTag } from "../../../web/src/lib/in-page-alerts";

const SW_SOURCE = readFileSync(resolve(__dirname, "../../../web/public/sw.js"), "utf8");
const ORIGIN = "https://app.klorn.ai";

type Handler = (event: unknown) => void;

interface SwHarness {
  handlers: Map<string, Handler>;
  showNotification: ReturnType<typeof vi.fn>;
  openWindow: ReturnType<typeof vi.fn>;
  clients: Array<{ url: string; focus: ReturnType<typeof vi.fn>; postMessage: () => void }>;
}

function loadServiceWorker(clientUrls: string[] = []): SwHarness {
  const handlers = new Map<string, Handler>();
  const showNotification = vi.fn(async () => {});
  const openWindow = vi.fn(async () => null);
  const clients = clientUrls.map((url) => ({
    url,
    focus: vi.fn(async () => null),
    postMessage() {},
  }));
  const self = {
    addEventListener: (type: string, fn: Handler) => handlers.set(type, fn),
    skipWaiting: () => {},
    location: { origin: ORIGIN },
    registration: { showNotification },
    clients: { matchAll: async () => clients, openWindow, claim: () => {} },
  };
  runInNewContext(SW_SOURCE, {
    self,
    caches: {},
    fetch: vi.fn(async () => ({ ok: true })),
    console: { log() {}, warn() {}, error() {} },
    URL,
    Response,
  });
  return { handlers, showNotification, openWindow, clients };
}

async function dispatch(
  sw: SwHarness,
  type: string,
  event: Record<string, unknown>,
): Promise<void> {
  const pending: Promise<unknown>[] = [];
  sw.handlers.get(type)?.({ ...event, waitUntil: (p: Promise<unknown>) => pending.push(p) });
  await Promise.all(pending);
}

async function push(
  sw: SwHarness,
  payload: unknown,
): Promise<{ title: string; options: Record<string, unknown> }> {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  await dispatch(sw, "push", { data: { text: () => text } });
  expect(sw.showNotification).toHaveBeenCalledTimes(1);
  const [title, options] = sw.showNotification.mock.calls[0] as [string, Record<string, unknown>];
  return { title, options };
}

const PUSH_MAIL = {
  title: "Klorn — Kim",
  body: "Q4 budget",
  url: "/inbox/firewall",
  bellNotificationId: "notif-1",
  deliveryId: "delivery-1",
  receiptUrl: null,
};

describe("sw.js push — OS tag", () => {
  let sw: SwHarness;
  beforeEach(() => {
    sw = loadServiceWorker();
  });

  it("tags a push with the same tag the tab uses for that bell notification", async () => {
    const { title, options } = await push(sw, PUSH_MAIL);
    expect(title).toBe("Klorn — Kim");
    expect(options.tag).toBe(notificationTag("notif-1"));
    expect(options.body).toBe("Q4 budget");
  });

  it("leaves a push without a bell id untagged, exactly as before (older server payloads)", async () => {
    const { bellNotificationId: _omit, ...legacy } = PUSH_MAIL;
    const { options } = await push(sw, legacy);
    expect(options.tag).toBeUndefined();
  });

  it("ignores a bell id that is not a short non-empty string", async () => {
    for (const bad of [42, "", "x".repeat(201), { id: "n" }]) {
      const fresh = loadServiceWorker();
      const { options } = await push(fresh, { ...PUSH_MAIL, bellNotificationId: bad });
      expect(options.tag).toBeUndefined();
    }
  });

  it("still shows the untagged fallback for an unparseable payload", async () => {
    const { title, options } = await push(sw, "not json");
    expect(title).toBe("Klorn — New notification");
    expect(options.tag).toBeUndefined();
  });
});

describe("sw.js notificationclick — unchanged by the tag", () => {
  async function clickTaggedPush(clientUrls: string[]): Promise<SwHarness> {
    const sw = loadServiceWorker(clientUrls);
    const { options } = await push(sw, PUSH_MAIL);
    expect(options.tag).toBe(notificationTag("notif-1"));
    const notification = { data: options.data, tag: options.tag, close: vi.fn() };
    await dispatch(sw, "notificationclick", { notification, action: "" });
    expect(notification.close).toHaveBeenCalled();
    return sw;
  }

  it("focuses an open tab already on the notification's URL", async () => {
    const sw = await clickTaggedPush([`${ORIGIN}/today`, `${ORIGIN}/inbox/firewall`]);
    expect(sw.clients[1].focus).toHaveBeenCalled();
    expect(sw.clients[0].focus).not.toHaveBeenCalled();
    expect(sw.openWindow).not.toHaveBeenCalled();
  });

  it("opens the notification's URL when no tab is on it", async () => {
    const sw = await clickTaggedPush([`${ORIGIN}/today`]);
    expect(sw.openWindow).toHaveBeenCalledWith("/inbox/firewall");
  });
});
