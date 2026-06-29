"use client";

import Link from "next/link";
import { useState } from "react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { isNativePlatform } from "../lib/native/capacitor";
import { iapAvailable, restoreNativePurchases, startNativePurchase } from "../lib/native/iap";
import { useToast } from "./toast";

const VALUE_PROPS = [
  "Only get interrupted by mail that actually matters",
  "Klorn auto-handles the noise while you're away",
  "A morning brief of what needs a decision",
  "Learns your calls and gets sharper over time",
];

// Shown by AuthGuard when the signed-in user is not entitled (trial expired /
// never subscribed) and the paywall is on. Web starts a card-required Stripe
// trial; the iOS app uses IAP (wired with RevenueCat at launch).
export default function PaywallScreen() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const native = isNativePlatform();
  // Native IAP is live only once a RevenueCat key is configured; until then the
  // app shows a disabled state (the web build always uses the Stripe path).
  const iapReady = iapAvailable();
  // Web is cheaper (no Apple cut). Founding price is locked in for early users.
  const price = native ? "$9.99" : "$7.99";

  const startWebTrial = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const { url } = await apiFetch<{ url: string }>("/api/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ plan: "PRO" }),
      });
      window.location.href = url;
    } catch {
      toast("Could not start checkout. Please try again.", "error");
      setLoading(false);
    }
  };

  // The entitlement is granted server-side by the RevenueCat webhook, which can
  // lag a second or two after the purchase. Poll /me until it lands (≤ ~8s)
  // before reloading, so a slow webhook doesn't bounce the user back here.
  const reloadWhenEntitled = async () => {
    for (let i = 0; i < 8; i++) {
      try {
        const data = await apiFetch<{ user?: { entitled?: boolean } }>("/api/auth/me");
        if (data.user?.entitled) break;
      } catch {
        // ignore and retry
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    window.location.reload();
  };

  // Native: purchase via RevenueCat (StoreKit/Play Billing).
  const startAppPurchase = async () => {
    if (loading || !user) return;
    setLoading(true);
    const outcome = await startNativePurchase(user.id);
    if (outcome === "purchased") {
      await reloadWhenEntitled();
      return;
    }
    if (outcome === "cancelled") {
      setLoading(false);
      return;
    }
    toast(
      outcome === "unavailable"
        ? "Subscriptions aren't available right now."
        : "Could not complete the purchase. Please try again.",
      "error",
    );
    setLoading(false);
  };

  const restore = async () => {
    if (loading || !user) return;
    setLoading(true);
    const ok = await restoreNativePurchases(user.id);
    if (ok) {
      await reloadWhenEntitled();
      return;
    }
    toast("No previous purchase found.", "info");
    setLoading(false);
  };

  return (
    <main className="flex min-h-dvh flex-col justify-center bg-[#0f1115] px-6 pb-safe pt-safe text-stone-100">
      <div className="mx-auto w-full max-w-sm">
        <img src="/brand/mark.svg?v=matte2" alt="" className="mb-6 h-12 w-12" />
        <span className="inline-flex items-center rounded-full bg-amber-400/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-300">
          Founding price
        </span>
        <h1 className="mt-3 text-[28px] font-bold leading-tight tracking-tight text-stone-50">
          Start your 7-day free trial
        </h1>
        <p className="mt-2 text-sm leading-6 text-stone-400">
          Klorn Pro is your AI email firewall — it decides what reaches you and handles the rest.
        </p>

        <ul className="mt-6 space-y-3">
          {VALUE_PROPS.map((prop) => (
            <li key={prop} className="flex items-start gap-3 text-[15px] text-stone-200">
              <svg
                aria-hidden="true"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="mt-0.5 shrink-0 text-amber-400"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span>{prop}</span>
            </li>
          ))}
        </ul>

        <div className="mt-8">
          {native && !iapReady ? (
            // Native build without a RevenueCat key yet — no web checkout/link
            // here (App Store anti-steering 3.1.1).
            <button
              type="button"
              disabled
              className="flex min-h-12 w-full items-center justify-center rounded-xl bg-amber-400/60 text-[15px] font-semibold text-stone-950"
            >
              Subscription coming soon
            </button>
          ) : (
            <button
              type="button"
              onClick={native ? startAppPurchase : startWebTrial}
              disabled={loading}
              className="flex min-h-12 w-full items-center justify-center rounded-xl bg-amber-400 text-[15px] font-semibold text-stone-950 transition active:bg-amber-300 disabled:opacity-50"
            >
              {loading ? "Starting..." : "Start free trial"}
            </button>
          )}
          {native && iapReady && (
            <button
              type="button"
              onClick={restore}
              disabled={loading}
              className="mt-2 flex min-h-9 w-full items-center justify-center text-xs text-stone-400 transition active:text-stone-200 disabled:opacity-50"
            >
              Restore purchase
            </button>
          )}
          <p className="mt-3 text-center text-xs text-stone-500">
            7 days free, then {price}/month — locked in for early members. Cancel anytime.
          </p>
        </div>

        <div className="mt-6 flex items-center justify-center gap-4 text-xs text-stone-500">
          <Link href="/settings" className="transition hover:text-stone-300">
            Settings
          </Link>
          <span aria-hidden="true">·</span>
          <Link href="/terms" className="transition hover:text-stone-300">
            Terms
          </Link>
        </div>
      </div>
    </main>
  );
}
