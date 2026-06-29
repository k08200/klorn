"use client";

import { useEffect } from "react";

export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    // When a new service worker takes control the cached app bundle is stale,
    // so reload once to drop the user onto the just-deployed version. Guard
    // against a reload loop with `refreshing`, and only arm this when the page
    // is ALREADY controlled — a first-ever install also fires controllerchange
    // and we must not reload on the very first visit.
    let refreshing = false;
    const onControllerChange = () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    };
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    }

    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | undefined;

    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        if (cancelled) return;
        reg.update();
        interval = setInterval(() => reg.update(), 60 * 60 * 1000); // hourly
      })
      .catch(() => {
        // SW registration failed — not critical
      });

    // The native shell loads a hosted URL and is rarely reloaded by hand, so a
    // deploy that lands while the app is backgrounded would otherwise never be
    // picked up — the user reopens the app and sees the old screen. Re-check for
    // a new service worker every time the app returns to the foreground; if one
    // is found it activates (skipWaiting in sw.js) and the controllerchange
    // handler above reloads to the fresh bundle.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      navigator.serviceWorker.getRegistration("/").then((reg) => reg?.update());
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  return null;
}
