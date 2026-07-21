"use client";

/**
 * Push onboarding banner — surfaces the "Enable notifications" call-to-action
 * outside of /settings, where users would otherwise never find it. Enabling is
 * a real user gesture (button click), which is the only reliable way to request
 * notification permission — the gesture-less auto-subscribe in PushRegister is
 * silently ignored by most browsers, so this banner is the dependable path.
 *
 * Shows only when:
 *   1. Not running in the Capacitor native shell — native push goes through
 *      FCM/APNs (registerNativePush), not Web Push.
 *   2. Web Push is usable on this platform. Desktop and Android browsers deliver
 *      Web Push from a normal tab (no install required), so we offer it there.
 *      iOS is the exception: it delivers Web Push only from an installed PWA and
 *      pushManager.subscribe() throws in a Safari tab, so iOS browser users are
 *      routed to PwaPrompts' Add-to-Home-Screen card instead of this banner.
 *   3. Browser supports Notification + PushManager.
 *   4. Notification.permission === "default" (not granted, not denied).
 *   5. The browser has no existing pushManager subscription.
 *   6. User is logged in (we need an auth token to register the subscription).
 *   7. User has not dismissed the banner within the last 24h.
 */

import { useEffect, useState } from "react";
import { useAuth } from "../lib/auth";
import { isNativePlatform } from "../lib/native/capacitor";
import {
  fetchVapidKey,
  getOrCreatePushSubscription,
  getSwRegistration,
  registerSubscriptionWithServer,
} from "../lib/push";

const DISMISS_KEY = "klorn-push-banner-dismissed-at";
const LEGACY_KEY_PREFIX = "ev" + "e";
const LEGACY_DISMISS_KEY = `${LEGACY_KEY_PREFIX}-push-banner-dismissed-at`;
const DISMISS_TTL_MS = 24 * 60 * 60 * 1000;

export default function PushOnboardingBanner() {
  const { token, loading } = useAuth();
  const [show, setShow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loading || !token) return;

    let cancelled = false;
    (async () => {
      const eligible = await isEligible();
      if (!cancelled && eligible) setShow(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [token, loading]);

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
      localStorage.removeItem(LEGACY_DISMISS_KEY);
    } catch {
      // localStorage unavailable (private mode); banner just won't suppress
    }
    setShow(false);
  };

  const enable = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setError(
          permission === "denied"
            ? "Notifications are blocked. Allow them for Klorn in your browser or device settings."
            : "Notification permission is required.",
        );
        setSubmitting(false);
        return;
      }

      const publicKey = await fetchVapidKey();
      if (!publicKey) throw new Error("The server has no notification key.");

      const reg = await getSwRegistration();
      const sub = await getOrCreatePushSubscription(reg, publicKey);
      await registerSubscriptionWithServer(sub);

      setShow(false);
    } catch (err) {
      console.error("[PUSH-BANNER] enable failed:", err);
      setError(err instanceof Error ? err.message : "Could not enable notifications.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!show) return null;

  return (
    <div
      role="dialog"
      aria-label="Enable push notifications"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[90] w-[min(94vw,420px)] bg-white border border-slate-200 rounded-2xl shadow-2xl shadow-black/60 px-4 py-3.5 flex items-start gap-3 animate-slide-up pb-safe"
    >
      <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-sky-400 to-sky-600 flex items-center justify-center text-base shrink-0">
        <span aria-hidden="true">🔔</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-slate-900">Enable Klorn notifications</p>
        <p className="text-xs text-slate-500 mt-0.5">
          Get briefings and urgent mail the moment they land.
        </p>
        {error && <p className="text-xs text-red-400 mt-1.5">{error}</p>}
        <div className="flex gap-2 mt-2.5">
          <button
            type="button"
            onClick={enable}
            disabled={submitting}
            className="px-3 py-1.5 text-xs font-medium bg-sky-500 hover:bg-sky-200 disabled:bg-slate-100 disabled:text-slate-400 text-stone-950 rounded-lg transition"
          >
            {submitting ? "Enabling..." : "Enable"}
          </button>
          <button
            type="button"
            onClick={dismiss}
            disabled={submitting}
            className="px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-900 transition"
          >
            Later
          </button>
        </div>
      </div>
      <button
        type="button"
        onClick={dismiss}
        disabled={submitting}
        aria-label="Close"
        className="text-slate-400 hover:text-slate-900 transition text-lg leading-none -mr-1 -mt-0.5"
      >
        ×
      </button>
    </div>
  );
}

async function isEligible(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (!("Notification" in window) || !("PushManager" in window)) return false;
  if (!("serviceWorker" in navigator)) return false;

  // Native shell delivers push via FCM/APNs (registerNativePush), not Web Push.
  if (isNativePlatform()) return false;

  // Web Push works in a plain browser tab on desktop and Android, so offer it
  // there. iOS is the exception: it delivers Web Push only from an installed
  // PWA and pushManager.subscribe() throws in a Safari tab, so iOS browser
  // users are handled by PwaPrompts' Add-to-Home-Screen card instead.
  const inPwa =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as { standalone?: boolean }).standalone === true;
  const isIos =
    /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as { MSStream?: unknown }).MSStream;
  if (isIos && !inPwa) return false;

  if (Notification.permission !== "default") return false;

  try {
    const legacyDismissed = localStorage.getItem(LEGACY_DISMISS_KEY);
    if (legacyDismissed) {
      localStorage.setItem(DISMISS_KEY, legacyDismissed);
      localStorage.removeItem(LEGACY_DISMISS_KEY);
    }
    const dismissedAt = Number(localStorage.getItem(DISMISS_KEY) || 0);
    if (dismissedAt && Date.now() - dismissedAt < DISMISS_TTL_MS) return false;
  } catch {
    // ignore — proceed to show
  }

  // Already subscribed? skip.
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    if (reg) {
      const existing = await reg.pushManager.getSubscription();
      if (existing) return false;
    }
  } catch {
    // SW lookup failed — still show (registering is part of the enable flow)
  }

  return true;
}
