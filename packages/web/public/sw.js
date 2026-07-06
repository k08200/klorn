// Klorn Service Worker — offline caching + push notification support
// v8: icons regenerated to a bigger K on a full-white tile; flush the v7 cache
// so the query-less push icon/badge (/icon-192.png, /badge-96.png) re-fetch.
const CACHE_NAME = "klorn-v9";
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
      // One-tap "Later"/"Mute" buttons for firewall interrupts (server only
      // sends these when the push maps 1:1 to an attention item).
      actions: Array.isArray(data.actions) ? data.actions : undefined,
      data: {
        url: data.url || "/chat",
        deliveryId: data.deliveryId || null,
        receiptUrl: data.receiptUrl || null,
        overrideUrl: data.overrideUrl || null,
        overrideToken: data.overrideToken || null,
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

  // One-tap tier override from an action button: retier in the background and
  // do NOT open the app. The capability token authenticates (the SW has no
  // session); only the reversible tiers are offered.
  if (
    (event.action === "queue" || event.action === "silent") &&
    data.overrideUrl &&
    data.overrideToken &&
    isSameOrigin(data.overrideUrl)
  ) {
    const tier = event.action === "queue" ? "QUEUE" : "SILENT";
    event.waitUntil(
      Promise.all([
        sendPushReceipt(data, "clicked"),
        fetch(data.overrideUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: data.overrideToken, tier }),
        }).catch((err) => console.warn("[SW] tier override failed:", err)),
      ]),
    );
    return;
  }

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

// Only ever POST the capability token to our own origin — defends against a
// misconfigured server base URL sending the token off-origin.
function isSameOrigin(url) {
  try {
    return new URL(url, self.location.origin).origin === self.location.origin;
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
