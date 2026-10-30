"use client";

import Link from "next/link";
import { useState } from "react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { isSafeBillingRedirect } from "../lib/billing-redirect";
import { useT } from "../lib/i18n";
import { isNativePlatform } from "../lib/native/capacitor";
import { iapAvailable, restoreNativePurchases, startNativePurchase } from "../lib/native/iap";
import { proPrice } from "../lib/pricing";
import { useToast } from "./toast";

const VALUE_PROPS = [
  "paywall.valueProp.interrupt",
  "paywall.valueProp.noise",
  "paywall.valueProp.brief",
  "paywall.valueProp.learns",
] as const;

// Shown by AuthGuard when the signed-in user is not entitled (trial expired /
// never subscribed) and the paywall is on. Web starts a card-required Stripe
// trial; the iOS app uses IAP (wired with RevenueCat at launch).
export default function PaywallScreen() {
  const { toast } = useToast();
  const { t } = useT();
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const native = isNativePlatform();
  // Native IAP is live only once a RevenueCat key is configured; until then the
  // app shows a disabled state (the web build always uses the Stripe path).
  const iapReady = iapAvailable();
  // Web checkout is live only when the server has Stripe fully configured;
  // undefined (older API) is treated as available so the button never
  // regresses on deploy skew.
  const webCheckoutReady = user?.webCheckoutAvailable !== false;
  // Web is cheaper (no store cut) — both values live in lib/pricing.ts.
  const price = proPrice(native);

  const startWebTrial = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const { url } = await apiFetch<{ url: string }>("/api/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ plan: "PRO" }),
      });
      // The URL comes from an API response — same open-redirect guard the
      // /billing page applies, so this path can't be the weak one.
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
        ? t("subscription.toast.unavailable")
        : t("subscription.toast.purchaseFailed"),
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
    toast(t("subscription.toast.noPurchase"), "info");
    setLoading(false);
  };

  return (
    <main className="flex min-h-dvh flex-col justify-center bg-surface-panel px-6 pb-safe pt-safe text-ink">
      <div className="mx-auto w-full max-w-sm">
        <img src="/brand/mark.svg?v=matte2" alt="" className="mb-6 h-12 w-12" />
        <h1 className="text-[28px] font-bold leading-tight tracking-tight text-ink">
          {t("paywall.title")}
        </h1>
        <p className="mt-2 text-sm leading-6 text-ink-mid">{t("paywall.body")}</p>

        <ul className="mt-6 space-y-3">
          {VALUE_PROPS.map((prop) => (
            <li key={prop} className="flex items-start gap-3 text-[15px] text-ink">
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
                className="mt-0.5 shrink-0 text-accent-deep"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span>{t(prop)}</span>
            </li>
          ))}
        </ul>

        <div className="mt-8">
          {(native && !iapReady) || (!native && !webCheckoutReady) ? (
            // Native build without a RevenueCat key yet — no web checkout/link
            // here (App Store anti-steering 3.1.1). Same disabled state on web
            // while Stripe is unconfigured (native-IAP-only launch).
            <button
              type="button"
              disabled
              className="flex min-h-12 w-full items-center justify-center rounded-xl bg-surface-inset text-[15px] font-semibold text-ink-mid"
            >
              {t("billing.subscriptionComingSoon")}
            </button>
          ) : (
            <button
              type="button"
              onClick={native ? startAppPurchase : startWebTrial}
              disabled={loading}
              className="flex min-h-12 w-full items-center justify-center rounded-xl bg-accent-solid text-[15px] font-semibold text-accent-solid-ink transition active:bg-accent-solid-hover disabled:opacity-50"
            >
              {loading ? t("subscription.starting") : t("paywall.startTrial")}
            </button>
          )}
          {native && iapReady && (
            <button
              type="button"
              onClick={restore}
              disabled={loading}
              className="mt-2 flex min-h-9 w-full items-center justify-center text-xs text-ink-mid transition active:text-ink disabled:opacity-50"
            >
              {t("subscription.restore")}
            </button>
          )}
          <p className="mt-3 text-center text-xs text-ink-dim">
            {t("subscription.trialTerms", { price })}
          </p>
        </div>

        <div className="mt-6 flex items-center justify-center gap-4 text-xs text-ink-dim">
          <Link href="/settings" className="transition hover:text-ink-soft">
            {t("settings.title")}
          </Link>
          <span aria-hidden="true">·</span>
          <Link href="/terms" className="transition hover:text-ink-soft">
            {t("auth.terms")}
          </Link>
          <span aria-hidden="true">·</span>
          <Link href="/refund" className="transition hover:text-ink-soft">
            {t("paywall.refunds")}
          </Link>
        </div>
      </div>
    </main>
  );
}
