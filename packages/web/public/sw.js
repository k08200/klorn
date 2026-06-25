// Klorn Service Worker — offline caching + push notification support
// v7: flush the v6 cache so the stale crescent push icon/badge (/icon-192.png,
// /badge-96.png — no query token) is re-fetched as the matte K mark.
const CACHE_NAME = "klorn-v7";
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

  // For navigation requests, try network first then cache
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
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
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
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
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            return res;
          }),
      ),
    );
    return;
  }
});

// Push notifications
self.addEventListener("push", (event) => {
  console.log("[SW] Push event received!", event.data ? "has data" : "no data");
  const rawText = event.data ? event.data.text() : null;

  // Forward to all open tabs so user can see in browser console
  const debugPromise = self.clients.matchAll({ type: "window" }).then((clients) => {
    for (const c of clients) {
      c.postMessage({
        type: "PUSH_DEBUG",
        msg: "Push event fired!",
        data: rawText,
      });
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
      data: {
        url: data.url || "/chat",
        deliveryId: data.deliveryId || null,
        receiptUrl: data.receiptUrl || null,
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

// Notification click → open app
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.url || "/chat";
  event.waitUntil(
    Promise.all([
      sendPushReceipt(data, "clicked"),
      self.clients.matchAll({ type: "window" }).then((clients) => {
        for (const client of clients) {
          if (client.url.includes(url) && "focus" in client) return client.focus();
        }
        return self.clients.openWindow(url);
      }),
    ]),
  );
});

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
