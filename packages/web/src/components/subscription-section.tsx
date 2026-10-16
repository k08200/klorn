"use client";

import { useState } from "react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { isSafeBillingRedirect } from "../lib/billing-redirect";
import { useT } from "../lib/i18n";
import { isNativePlatform } from "../lib/native/capacitor";
import { iapAvailable, restoreNativePurchases, startNativePurchase } from "../lib/native/iap";
import { proPrice } from "../lib/pricing";
import { useSubscriptionState } from "../lib/subscription";
import { SubscriptionManager } from "./subscription-manager";
import { useToast } from "./toast";

const PRO_PLANS = new Set(["PRO", "TEAM", "ENTERPRISE"]);

const VALUE_PROPS = [
  "subscription.valueProp.push",
  "subscription.valueProp.noise",
  "subscription.valueProp.send",
] as const;

// The in-app path to subscribe / manage a subscription. On the web it uses
// Stripe (checkout + portal); in the native app it uses RevenueCat IAP (Apple
// anti-steering — no web link). Lives in Settings so users can reach billing
// without waiting for the forced paywall.
export function SubscriptionSection() {
  const { user } = useAuth();
  const { toast } = useToast();
  const { t } = useT();
  const native = isNativePlatform();
  const [loading, setLoading] = useState(false);
  // Provider state for the manager below. The hook runs before the early
  // return so hook order stays stable; it skips the fetch for signed-out and
  // native sessions, which have nothing to manage here.
  const { state: subscription, reload: reloadSubscription } = useSubscriptionState(
    Boolean(user) && !native,
  );

  if (!user) return null;
  const isPro = PRO_PLANS.has(user.plan) || user.role === "ADMIN";
  // Web checkout is live only when the server has Stripe fully configured;
  // undefined (older API) is treated as available (deploy-skew safe).
  const webCheckoutReady = user.webCheckoutAvailable !== false;
  const price = proPrice(native);

  const startWebTrial = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const { url } = await apiFetch<{ url: string }>("/api/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ plan: "PRO" }),
      });
      // Same guard as /billing: the URL comes from an API response, so it must
      // never be able to send a signed-in user to an arbitrary origin.
      if (url && isSafeBillingRedirect(url, window.location.origin)) {
        window.location.href = url;
        return;
      }
      toast(t("billing.error.unsafeRedirect"), "error");
      setLoading(false);
    } catch {
      toast(t("subscription.toast.checkoutFailed"), "error");
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
        ? t("subscription.toast.unavailable")
        : t("subscription.toast.purchaseFailed"),
      "error",
    );
    setLoading(false);
  };

  const restore = async () => {
    if (loading) return;
    setLoading(true);
    const ok = await restoreNativePurchases(user.id);
    if (ok) {
      window.location.reload();
      return;
    }
    toast(t("subscription.toast.noPurchase"), "info");
    setLoading(false);
  };

  return (
    <section className="mb-8">
      <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink-dim">
        {t("subscription.title")}
      </h2>
      <div className="panel-elevated rounded-2xl border border-line/70 bg-surface-panel p-5">
        {isPro ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-base font-semibold text-ink">Klorn Pro</p>
              <p className="mt-0.5 text-xs text-ink-dim">{t("subscription.active")}</p>
            </div>
            {native ? (
              <button
                type="button"
                onClick={restore}
                disabled={loading}
                className="ease-strong min-h-10 rounded-lg border border-line bg-surface-panel/70 px-4 text-sm text-ink-mid shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-surface-panel hover:text-ink active:scale-[0.97] disabled:opacity-50"
              >
                {t("subscription.restore")}
              </button>
            ) : (
              // Real provider state, not an inference from user.plan: a beta
              // grant, an ADMIN account or an IAP subscriber viewed on web has
              // no web billing record, and offering them a portal button here
              // only ever produced "No billing account".
              <SubscriptionManager state={subscription} onChanged={reloadSubscription} />
            )}
          </div>
        ) : (
          <div>
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-base font-semibold text-ink">Klorn Pro</p>
              <p className="text-sm text-ink-mid">
                <span className="text-xl font-bold text-ink">{price}</span>
                {t("billing.plan.pro.period")}
              </p>
            </div>
            <p className="mt-1 text-xs text-ink-dim">{t("subscription.trialTerms", { price })}</p>
            <ul className="mt-4 space-y-2">
              {VALUE_PROPS.map((prop) => (
                <li key={prop} className="flex items-start gap-2.5 text-sm text-ink-mid">
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
                    className="mt-0.5 shrink-0 text-accent-deep"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>{t(prop)}</span>
                </li>
              ))}
            </ul>
            {(native && !iapAvailable()) || (!native && !webCheckoutReady) ? (
              <button
                type="button"
                disabled
                className="mt-5 flex min-h-11 w-full items-center justify-center rounded-lg border border-line bg-surface-hover text-sm font-semibold text-ink-dim"
              >
                {t("billing.subscriptionComingSoon")}
              </button>
            ) : (
              <button
                type="button"
                onClick={native ? startAppPurchase : startWebTrial}
                disabled={loading}
                className="glow-primary ease-strong mt-5 flex min-h-11 w-full items-center justify-center rounded-lg bg-accent-solid text-sm font-semibold text-accent-solid-ink transition duration-150 hover:bg-accent-solid-hover active:scale-[0.97] disabled:opacity-50"
              >
                {loading ? t("subscription.starting") : t("billing.startTrial")}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
