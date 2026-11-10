/**
 * Decision N1 in the service worker (packages/web/public/sw.js), executed in a
 * sandbox with a stub `self`:
 *   - a mail push shows the sender title and the subject + reason body;
 *   - only Reply and Later are shown (at most two); Silent / Mute never;
 *   - Reply opens the reader with the reply composer focused;
 *   - Later POSTs the push-later token, only to this origin or the API origin
 *     the page configured, and opens the mail when it cannot;
 *   - nothing a payload says can make openWindow() leave the app's origin.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const SW_SOURCE = readFileSync(resolve(__dirname, "../../../web/public/sw.js"), "utf8");
const ORIGIN = "https://app.klorn.ai";
const API = "https://api.klorn.ai";

type Handler = (event: unknown) => void;

function loadServiceWorker(opts: { rotateUrl?: string; laterStatus?: number } = {}) {
  const handlers = new Map<string, Handler>();
  const showNotification = vi.fn(async () => {});
  const openWindow = vi.fn(async () => null);
  const fetch = vi.fn(async (url: string) => ({
    ok: url.endsWith("/push/later") ? (opts.laterStatus ?? 200) < 300 : true,
  }));
  const cache = {
    match: async () => (opts.rotateUrl ? new Response(opts.rotateUrl) : undefined),
    put: async () => {},
  };
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

async function show(sw: Sw, payload: unknown) {
  await dispatch(sw, "push", { data: { text: () => JSON.stringify(payload) } });
  const [title, options] = sw.showNotification.mock.calls[0] as unknown as [
    string,
    Record<string, unknown>,
  ];
  return { title, options };
}

async function click(sw: Sw, payload: unknown, action: string) {
  const { options } = await show(sw, payload);
  await dispatch(sw, "notificationclick", {
    notification: { data: options.data, close: vi.fn() },
    action,
  });
}

const MAIL = {
  title: "Alice",
  body: "Contract\nSignature needed today",
  url: "/email/email-1",
  actions: [
    { action: "reply", title: "Reply" },
    { action: "later", title: "Later" },
  ],
  replyUrl: "/email/email-1?focus=reply",
  laterUrl: `${API}/api/notifications/push/later`,
  laterToken: "later-token",
  deliveryId: null,
  receiptUrl: null,
};

const laterCalls = (sw: Sw) =>
  sw.fetch.mock.calls.filter(([url]) => String(url).endsWith("/push/later"));

describe("sw.js — mail notification content and actions", () => {
  it("shows the sender as the title and the subject + reason as the body", async () => {
    const { title, options } = await show(loadServiceWorker(), MAIL);
    expect(title).toBe("Alice");
    expect(options.body).toBe("Contract\nSignature needed today");
    expect(options.actions).toEqual(MAIL.actions);
  });

  it("drops Silent / Mute / unknown actions and shows at most two", async () => {
    const { options } = await show(loadServiceWorker(), {
      ...MAIL,
      actions: [
        { action: "silent", title: "Mute" },
        { action: "queue", title: "Later" },
        { action: "reply", title: "Reply" },
        { action: "later", title: "Later" },
        { action: "reply", title: "Again" },
      ],
    });
    expect(options.actions).toEqual(MAIL.actions);
  });

  it("a push without actions shows none", async () => {
    const { options } = await show(loadServiceWorker(), { title: "Klorn", body: "x" });
    expect(options.actions).toBeUndefined();
  });
});

describe("sw.js — action clicks", () => {
  it("Reply opens the reader with the reply composer focused", async () => {
    const sw = loadServiceWorker();
    await click(sw, MAIL, "reply");
    expect(sw.openWindow).toHaveBeenCalledWith("/email/email-1?focus=reply");
    expect(laterCalls(sw)).toHaveLength(0);
  });

  it("a plain click opens that mail", async () => {
    const sw = loadServiceWorker();
    await click(sw, MAIL, "");
    expect(sw.openWindow).toHaveBeenCalledWith("/email/email-1");
  });

  it("Later posts the token to the configured API origin and opens nothing", async () => {
    const sw = loadServiceWorker({ rotateUrl: `${API}/api/notifications/push/rotate` });
    await click(sw, MAIL, "later");
    expect(laterCalls(sw)).toHaveLength(1);
    const [url, init] = laterCalls(sw)[0] as unknown as [string, { method: string; body: string }];
    expect(url).toBe(MAIL.laterUrl);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ token: "later-token" });
    expect(sw.openWindow).not.toHaveBeenCalled();
  });

  it("Later to a same-origin URL is allowed without any configuration", async () => {
    const sw = loadServiceWorker();
    await click(sw, { ...MAIL, laterUrl: `${ORIGIN}/api/notifications/push/later` }, "later");
    expect(laterCalls(sw)).toHaveLength(1);
  });

  it("never sends the token to a foreign origin: opens the mail instead", async () => {
    const sw = loadServiceWorker({ rotateUrl: `${API}/api/notifications/push/rotate` });
    await click(
      sw,
      { ...MAIL, laterUrl: "https://evil.example/api/notifications/push/later" },
      "later",
    );
    expect(laterCalls(sw)).toHaveLength(0);
    expect(sw.openWindow).toHaveBeenCalledWith("/email/email-1");
  });

  it("opens the mail when the Later request is refused", async () => {
    const sw = loadServiceWorker({ rotateUrl: `${API}/x`, laterStatus: 401 });
    await click(sw, MAIL, "later");
    expect(laterCalls(sw)).toHaveLength(1);
    expect(sw.openWindow).toHaveBeenCalledWith("/email/email-1");
  });

  it("a legacy Mute / queue click no longer retiers: it just opens the page", async () => {
    const sw = loadServiceWorker();
    await click(sw, { ...MAIL, overrideUrl: `${ORIGIN}/x`, overrideToken: "t" }, "silent");
    expect(sw.fetch).not.toHaveBeenCalledWith(`${ORIGIN}/x`, expect.anything());
    expect(sw.openWindow).toHaveBeenCalledWith("/email/email-1");
  });

  it.each([
    "https://evil.example/phish",
    "//evil.example/phish",
    "/\\evil.example",
    "javascript:alert(1)",
  ])("never opens a payload URL outside the app (%s)", async (bad) => {
    const sw = loadServiceWorker();
    await click(sw, { ...MAIL, url: bad, replyUrl: bad }, "reply");
    expect(sw.openWindow).toHaveBeenCalledWith("/chat");
  });
});
