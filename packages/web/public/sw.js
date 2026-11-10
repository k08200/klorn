// Klorn Service Worker — offline caching + push notification support
// v8: icons regenerated to a bigger K on a full-white tile; flush the v7 cache
// so the query-less push icon/badge (/icon-192.png, /badge-96.png) re-fetch.
// v10: stop caching cross-origin requests and non-ok responses. The old
// cache-first .js rule captured cdn.paddle.com/paddle.js — one bad CDN
// response got pinned forever and the checkout overlay died silently on
// every later visit (observed 2026-08-13). The version bump flushes any
// cache poisoned that way.
const CACHE_NAME = "klorn-v10";
const PRECACHE_URLS = ["/", "/chat", "/briefing", "/manifest.json"];

// Install: precache shell
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
      ),
  );
  self.clients.claim();
});

// Fetch: network-first for API, cache-first for static assets
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and API requests from caching
  if (request.method !== "GET") return;
  if (url.pathname.startsWith("/api/")) return;

  // Never intercept cross-origin requests (payment/CDN scripts like
  // cdn.paddle.com). Serving those cache-first pinned one bad response
  // forever; the browser's own HTTP cache handles them correctly.
  if (url.origin !== self.location.origin) return;

  // For navigation requests, try network first then cache
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return res;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match("/"))),
    );
    return;
  }

  // Static assets: network-first for _next (hashed, changes on rebuild), cache-first for others
  if (url.pathname.startsWith("/_next/")) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return res;
        })
        .catch(() => caches.match(request)),
    );
    return;
  }

  if (url.pathname.match(/\.(js|css|svg|png|jpg|ico|woff2?)$/)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((res) => {
            if (res.ok) {
              const clone = res.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            }
            return res;
          }),
      ),
    );
    return;
  }
});

// OS tag for one bell notification. An open tab tags its own notification for
// the same row identically (src/lib/in-page-alerts.ts notificationTag); the tab
// stays quiet while this browser holds a push subscription, and the shared tag
// lets the browser collapse a same-row duplicate. A push without the id (older
// server, or no bell row) stays untagged, exactly as before.
const NOTIFICATION_TAG_PREFIX = "klorn-notification:";
const NOTIFICATION_ID_MAX = 200;

function notificationTag(id) {
  if (typeof id !== "string" || id.length === 0 || id.length > NOTIFICATION_ID_MAX) {
    return undefined;
  }
  return NOTIFICATION_TAG_PREFIX + id;
}

// Decision N1 (2026-11-08): a mail notification offers Reply and Later only
// (Chrome / Windows show two actions reliably). Silent / Mute is gone. Any
// other action id from a payload is dropped.
const MAIL_ACTIONS = ["reply", "later"];
const MAX_ACTIONS = 2;

function mailActions(raw) {
  if (!Array.isArray(raw)) return undefined;
  const actions = raw
    .filter(
      (a) =>
        a &&
        MAIL_ACTIONS.includes(a.action) &&
        typeof a.title === "string" &&
        a.title.length > 0 &&
        a.title.length <= 40,
    )
    .slice(0, MAX_ACTIONS)
    .map((a) => ({ action: a.action, title: a.title }));
  return actions.length > 0 ? actions : undefined;
}

// A path inside this app ("/email/abc?focus=reply"), never another origin:
// openWindow() is handed nothing a payload could turn into an open redirect.
function appPath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return null;
  if (value.includes("\\")) return null;
  try {
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin ? url.pathname + url.search + url.hash : null;
  } catch {
    return null;
  }
}

// Push notifications
self.addEventListener("push", (event) => {
  console.log("[SW] Push event received!", event.data ? "has data" : "no data");
  const rawText = event.data ? event.data.text() : null;

  // Forward to all open tabs: debug info + a refresh signal so an open page
  // refetches its lists when a push lands while the WS was down/backgrounded.
  const debugPromise = self.clients.matchAll({ type: "window" }).then((clients) => {
    for (const c of clients) {
      c.postMessage({
        type: "PUSH_DEBUG",
        msg: "Push event fired!",
        data: rawText,
      });
      c.postMessage({ type: "conversations-updated" });
    }
  });

  let data = {};
  let title = "Klorn";
  let options = {
    body: "You have a new notification",
    // Chrome notifications can't render SVG icons — must be raster (PNG).
    icon: "/icon-192.png",
    badge: "/badge-96.png",
    data: { url: "/chat", deliveryId: null, receiptUrl: null },
  };
  try {
    data = rawText ? JSON.parse(rawText) : {};
    console.log("[SW] Push data parsed:", JSON.stringify(data));
    title = data.title || "Klorn";
    options = {
      body: data.body || "You have a new notification",
      icon: "/icon-192.png",
      badge: "/badge-96.png",
      // Reply / Later on a notification about one mail (decision N1). The
      // server sends them only for a lane-tagged mail push.
      actions: mailActions(data.actions),
      tag: notificationTag(data.bellNotificationId),
      data: {
        url: data.url || "/chat",
        deliveryId: data.deliveryId || null,
        receiptUrl: data.receiptUrl || null,
        replyUrl: data.replyUrl || null,
        laterUrl: data.laterUrl || null,
        laterToken: data.laterToken || null,
      },
    };
  } catch (err) {
    console.error("[SW] Push data parse error:", err);
    // Show fallback notification even if parsing fails
    title = "Klorn — New notification";
    options.body = rawText || "Check Klorn for details";
  }
  event.waitUntil(
    Promise.all([
      debugPromise,
      sendPushReceipt(data, "received"),
      self.registration.showNotification(title, options),
    ]),
  );
});

function openOrFocus(url) {
  return self.clients.matchAll({ type: "window" }).then((clients) => {
    for (const client of clients) {
      if (client.url.includes(url) && "focus" in client) return client.focus();
    }
    return self.clients.openWindow(url);
  });
}

// "Later" (decision N1): the mail's later-today reminder, set in the
// background without opening the app. The signed push-later token in the body
// is the credential (the SW has no session); it names exactly one mail of one
// user. Whenever the request cannot be made or fails, open the mail instead,
// so the tap is never silently lost.
async function remindLater(data, fallbackUrl) {
  if (!data.laterUrl || !data.laterToken || !(await isTrustedActionUrl(data.laterUrl))) {
    return openOrFocus(fallbackUrl);
  }
  try {
    const res = await fetch(data.laterUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: data.laterToken }),
    });
    if (!res.ok) return openOrFocus(fallbackUrl);
  } catch (err) {
    console.warn("[SW] Later failed:", err);
    return openOrFocus(fallbackUrl);
  }
}

// Notification click → open the mail (or the push's page)
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = appPath(data.url) || "/chat";

  if (event.action === "later") {
    event.waitUntil(Promise.all([sendPushReceipt(data, "clicked"), remindLater(data, url)]));
    return;
  }

  // Reply: the reader on that mail with the reply composer focused. Sending
  // stays a deliberate tap in the app.
  const target = event.action === "reply" ? appPath(data.replyUrl) || url : url;
  event.waitUntil(Promise.all([sendPushReceipt(data, "clicked"), openOrFocus(target)]));
});

// The capability token is only ever POSTed to this app's own origin or to the
// API origin the page configured (the rotate URL it posts after registration,
// see "Subscription rotation" below) — never to wherever a payload points.
async function isTrustedActionUrl(url) {
  let origin;
  try {
    origin = new URL(url, self.location.origin).origin;
  } catch {
    return false;
  }
  if (origin === self.location.origin) return true;
  const rotateUrl = await readRotateUrl();
  if (!rotateUrl) return false;
  try {
    return new URL(rotateUrl).origin === origin;
  } catch {
    return false;
  }
}

function sendPushReceipt(data, event) {
  if (!data || !data.deliveryId || !data.receiptUrl) return Promise.resolve();
  return fetch(data.receiptUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event }),
  }).catch((err) => {
    console.warn("[SW] Push receipt failed:", err);
  });
}

// ── Subscription rotation ───────────────────────────────────────────────
// Push services can replace a subscription while the app is closed
// (key rotation, browser update). Without this handler the server keeps
// the dead endpoint, gets 410s, deletes the row — and the phone silently
// stops receiving pushes until the user happens to reopen the web app.
// The page posts the rotate URL after registration (no tokens — the old
// endpoint itself is the capability that authenticates the swap).
const CONFIG_CACHE = "klorn-sw-config-v1";
const ROTATE_URL_KEY = "/__klorn/rotate-url";

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type !== "klorn-config" || typeof data.rotateUrl !== "string") return;
  event.waitUntil(
    caches
      .open(CONFIG_CACHE)
      .then((cache) => cache.put(ROTATE_URL_KEY, new Response(data.rotateUrl))),
  );
});

async function readRotateUrl() {
  try {
    const cache = await caches.open(CONFIG_CACHE);
    const res = await cache.match(ROTATE_URL_KEY);
    return res ? await res.text() : null;
  } catch {
    return null;
  }
}

self.addEventListener("pushsubscriptionchange", (event) => {
  const oldSubscription = event.oldSubscription;
  event.waitUntil(
    (async () => {
      const appServerKey =
        oldSubscription?.options?.applicationServerKey ||
        (event.newSubscription && event.newSubscription.options
          ? event.newSubscription.options.applicationServerKey
          : null);
      if (!appServerKey) return; // app-open re-registration will heal it
      const newSub =
        event.newSubscription ||
        (await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: appServerKey,
        }));
      const rotateUrl = await readRotateUrl();
      if (!rotateUrl || !oldSubscription) return;
      const json = newSub.toJSON();
      await fetch(rotateUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          oldEndpoint: oldSubscription.endpoint,
          endpoint: json.endpoint,
          keys: json.keys,
        }),
      }).catch((err) => console.warn("[SW] Subscription rotate failed:", err));
    })(),
  );
});
