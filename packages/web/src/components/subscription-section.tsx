"use client";

import { useState } from "react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { isNativePlatform } from "../lib/native/capacitor";
import { iapAvailable, restoreNativePurchases, startNativePurchase } from "../lib/native/iap";
import { useToast } from "./toast";

const PRO_PLANS = new Set(["PRO", "TEAM", "ENTERPRISE"]);

const VALUE_PROPS = [
  "Real-time push for mail that actually matters",
  "Auto-handle the noise while you're away",
  "Send, reply, and integrations",
];

// The in-app path to subscribe / manage a subscription. On the web it uses
// Stripe (checkout + portal); in the native app it uses RevenueCat IAP (Apple
// anti-steering — no web link). Lives in Settings so users can reach billing
// without waiting for the forced paywall.
export function SubscriptionSection() {
  const { user } = useAuth();
  const { toast } = useToast();
  const native = isNativePlatform();
  const [loading, setLoading] = useState(false);

  if (!user) return null;
  const isPro = PRO_PLANS.has(user.plan) || user.role === "ADMIN";
  // Web checkout is live only when the server has Stripe fully configured;
  // undefined (older API) is treated as available (deploy-skew safe).
  const webCheckoutReady = user.webCheckoutAvailable !== false;
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

  const startAppPurchase = async () => {
    if (loading) return;
    setLoading(true);
    const outcome = await startNativePurchase(user.id);
    if (outcome === "purchased") {
      window.location.reload();
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

  const manageWeb = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const { url } = await apiFetch<{ url: string }>("/api/billing/portal", { method: "POST" });
      window.location.href = url;
    } catch {
      toast("Could not open the billing portal.", "error");
      setLoading(false);
    }
  };

  const restore = async () => {
    if (loading) return;
    setLoading(true);
    const ok = await restoreNativePurchases(user.id);
    if (ok) {
      window.location.reload();
      return;
    }
    toast("No previous purchase found.", "info");
    setLoading(false);
  };

  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-semibold text-slate-500">Subscription</h2>
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-5">
        {isPro ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-base font-semibold text-slate-900">Klorn Pro</p>
              <p className="mt-0.5 text-xs text-slate-400">Active — thanks for supporting Klorn.</p>
            </div>
            {native ? (
              <button
                type="button"
                onClick={restore}
                disabled={loading}
                className="min-h-10 rounded-lg border border-slate-200 px-4 text-sm text-slate-500 transition hover:bg-slate-100 disabled:opacity-50"
              >
                Restore purchase
              </button>
            ) : (
              <button
                type="button"
                onClick={manageWeb}
                disabled={loading}
                className="min-h-10 rounded-lg border border-slate-200 px-4 text-sm text-slate-500 transition hover:bg-slate-100 disabled:opacity-50"
              >
                Manage subscription
              </button>
            )}
          </div>
        ) : (
          <div>
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-base font-semibold text-slate-900">Klorn Pro</p>
              <p className="text-sm text-slate-500">
                <span className="text-xl font-bold text-slate-900">{price}</span>/mo
              </p>
            </div>
            <p className="mt-1 text-xs text-slate-400">
              7 days free, then {price}/month. Cancel anytime.
            </p>
            <ul className="mt-4 space-y-2">
              {VALUE_PROPS.map((prop) => (
                <li key={prop} className="flex items-start gap-2.5 text-sm text-slate-500">
                  <svg
                    aria-hidden="true"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="mt-0.5 shrink-0 text-sky-400"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>{prop}</span>
                </li>
              ))}
            </ul>
            {(native && !iapAvailable()) || (!native && !webCheckoutReady) ? (
              <button
                type="button"
                disabled
                className="mt-5 flex min-h-11 w-full items-center justify-center rounded-lg bg-sky-400/60 text-sm font-semibold text-stone-950"
              >
                Subscription coming soon
              </button>
            ) : (
              <button
                type="button"
                onClick={native ? startAppPurchase : startWebTrial}
                disabled={loading}
                className="mt-5 flex min-h-11 w-full items-center justify-center rounded-lg bg-sky-500 text-sm font-semibold text-stone-950 transition hover:bg-sky-500 disabled:opacity-50"
              >
                {loading ? "Starting..." : "Start 7-day free trial"}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
