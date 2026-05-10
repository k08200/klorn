"use client";

/**
 * Push onboarding banner — surfaces the "Enable notifications" call-to-action
 * outside of /settings, where users would otherwise never find it.
 *
 * Shows only when:
 *   1. Page is running as installed PWA (display-mode: standalone) — required
 *      because iOS Safari refuses pushManager.subscribe() outside a PWA.
 *   2. Browser supports Notification + PushManager.
 *   3. Notification.permission === "default" (not granted, not denied).
 *   4. The browser has no existing pushManager subscription.
 *   5. User is logged in (we need an auth token to register the subscription).
 *   6. User has not dismissed the banner within the last 24h.
 */

import { useEffect, useState } from "react";
import { API_BASE, authHeaders } from "../lib/api";
import { useAuth } from "../lib/auth";

const DISMISS_KEY = "eve-push-banner-dismissed-at";
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
            ? "iPhone 설정 → EVE → 알림에서 허용해주세요"
            : "알림 권한이 필요합니다",
        );
        setSubmitting(false);
        return;
      }

      // Use the explicit /sw.js registration so we get the SW that has the
      // push event handler (navigator.serviceWorker.ready can resolve to a
      // different SW that ignores push events).
      let reg = await navigator.serviceWorker.getRegistration("/");
      if (!reg) {
        reg = await navigator.serviceWorker.register("/sw.js");
        await navigator.serviceWorker.ready;
      }

      const vapidRes = await fetch(`${API_BASE}/api/notifications/vapid-key`, {
        headers: authHeaders(),
      });
      if (!vapidRes.ok) throw new Error("VAPID key fetch failed");
      const { publicKey } = (await vapidRes.json()) as { publicKey?: string };
      if (!publicKey) throw new Error("VAPID key missing on server");

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
      });

      const subJson = sub.toJSON();
      const regRes = await fetch(`${API_BASE}/api/notifications/push/subscribe`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: subJson.endpoint, keys: subJson.keys }),
      });
      if (!regRes.ok) throw new Error(`Server registration failed (${regRes.status})`);

      setShow(false);
    } catch (err) {
      console.error("[PUSH-BANNER] enable failed:", err);
      setError(err instanceof Error ? err.message : "알림 등록 실패");
    } finally {
      setSubmitting(false);
    }
  };

  if (!show) return null;

  return (
    <div
      role="dialog"
      aria-label="Enable push notifications"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[90] w-[min(94vw,420px)] bg-stone-950 border border-stone-700 rounded-2xl shadow-2xl shadow-black/60 px-4 py-3.5 flex items-start gap-3 animate-slide-up pb-safe"
    >
      <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-base shrink-0">
        <span aria-hidden="true">🔔</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-stone-100">EVE 알림 켜기</p>
        <p className="text-xs text-stone-400 mt-0.5">브리핑과 긴급 메일을 폰으로 바로 받아보세요</p>
        {error && <p className="text-xs text-red-400 mt-1.5">{error}</p>}
        <div className="flex gap-2 mt-2.5">
          <button
            type="button"
            onClick={enable}
            disabled={submitting}
            className="px-3 py-1.5 text-xs font-medium bg-amber-300 hover:bg-amber-200 disabled:bg-stone-700 disabled:text-stone-500 text-stone-950 rounded-lg transition"
          >
            {submitting ? "Enabling..." : "알림 켜기"}
          </button>
          <button
            type="button"
            onClick={dismiss}
            disabled={submitting}
            className="px-3 py-1.5 text-xs font-medium text-stone-400 hover:text-stone-200 transition"
          >
            나중에
          </button>
        </div>
      </div>
      <button
        type="button"
        onClick={dismiss}
        disabled={submitting}
        aria-label="Close"
        className="text-stone-500 hover:text-stone-200 transition text-lg leading-none -mr-1 -mt-0.5"
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

  // Only show inside an installed PWA — iOS Safari rejects subscribe() outside.
  const inPwa =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as { standalone?: boolean }).standalone === true;
  if (!inPwa) return false;

  if (Notification.permission !== "default") return false;

  try {
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

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
