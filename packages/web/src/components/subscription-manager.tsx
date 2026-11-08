"use client";

import { useState } from "react";
import { apiFetch } from "../lib/api";
import { isSafeBillingRedirect } from "../lib/billing-redirect";
import { useT } from "../lib/i18n";
import { isNativePlatform } from "../lib/native/capacitor";
import {
  formatBillingDate,
  hasPendingCancel,
  isPaidPlan,
  type SubscriptionState,
  subscriptionStatusLine,
} from "../lib/subscription";
import { useConfirm } from "./confirm-dialog";
import { useToast } from "./toast";

const BUTTON =
  "ease-strong min-h-11 rounded-control border border-line bg-surface-panel/70 px-4 py-2 text-role-body font-medium text-ink-mid shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-surface-panel hover:text-ink active:scale-[0.97] focus-ring disabled:opacity-50";

/**
 * The one-line answer to "what happens next, and when" — renewal date, trial
 * first charge, pending cancellation, or a payment problem.
 *
 * Split out of the action group so the page can place it under the plan name,
 * where it belongs: it describes the subscription, not the buttons.
 */
export function SubscriptionStatusLine({ state }: { state: SubscriptionState }) {
  const { t, locale } = useT();
  if (isNativePlatform()) return null;
  const line = subscriptionStatusLine(state, locale);
  if (!line) return null;
  const attention = state.subscriptionStatus === "past_due" || hasPendingCancel(state);
  return (
    <p
      className={`mt-1.5 text-role-caption ${attention ? "font-medium text-state-warn-ink" : "text-ink-mid"}`}
    >
      {line.date ? t(line.key, { date: line.date }) : t(line.key)}
    </p>
  );
}

/**
 * Subscription state + the actions on it, shared by /billing and Settings so
 * the two surfaces can never disagree about what a subscriber sees.
 *
 * Cancelling is in-app (POST /api/billing/cancel) rather than a bounce to the
 * provider portal: it always schedules for the period end, which is what the
 * refund policy promises, and it shows the exact end date in the confirm. The
 * portal stays available for what we deliberately do NOT reimplement —
 * payment method changes and invoice downloads.
 *
 * Nothing renders inside the native app: App Store anti-steering (3.1.1)
 * forbids pointing at web billing, and IAP subscriptions are managed by the
 * store, not by us.
 */
export function SubscriptionManager({
  state,
  onChanged,
}: {
  state: SubscriptionState;
  /** Refetch the surface's billing state. Awaited before buttons re-enable. */
  onChanged: () => Promise<void> | void;
}) {
  const { t, locale } = useT();
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [busy, setBusy] = useState(false);

  if (isNativePlatform()) return null;

  const pendingCancel = hasPendingCancel(state);
  const canCancel = Boolean(state.canCancelInApp) && !pendingCancel;

  async function openPortal() {
    if (busy) return;
    setBusy(true);
    try {
      const { url } = await apiFetch<{ url: string }>("/api/billing/portal", {
        method: "POST",
        body: JSON.stringify({}),
      });
      // The URL comes from an API response, so it is never trusted blindly.
      if (url && isSafeBillingRedirect(url, window.location.origin)) {
        window.location.href = url;
        return;
      }
      toast(t("billing.error.unsafeRedirect"), "error");
    } catch {
      toast(t("billing.error.portalFailed"), "error");
    }
    setBusy(false);
  }

  async function cancelSubscription() {
    if (busy) return;
    const endDate = formatBillingDate(state.cancelAt ?? state.renewsAt, locale);
    const ok = await confirm({
      title: t("billing.cancelConfirm.title"),
      message: endDate
        ? t("billing.cancelConfirm.message", { date: endDate })
        : t("billing.cancelConfirm.messageNoDate"),
      confirmLabel: t("billing.cancelConfirm.confirm"),
      // Never "Cancel" here — it would read as confirming the cancellation.
      dismissLabel: t("billing.keepSubscription"),
      danger: true,
    });
    if (!ok) return;

    setBusy(true);
    try {
      const { cancelAt } = await apiFetch<{ cancelAt: string | null }>("/api/billing/cancel", {
        method: "POST",
        body: JSON.stringify({}),
      });
      const effective = formatBillingDate(cancelAt, locale);
      toast(
        effective
          ? t("billing.toast.cancelScheduled", { date: effective })
          : t("billing.toast.cancelScheduledNoDate"),
        "success",
      );
      await onChanged();
    } catch {
      toast(t("billing.error.cancelFailed"), "error");
    }
    setBusy(false);
  }

  async function keepSubscription() {
    if (busy) return;
    setBusy(true);
    try {
      await apiFetch<{ resumed: boolean }>("/api/billing/cancel/undo", {
        method: "POST",
        body: JSON.stringify({}),
      });
      toast(t("billing.toast.resumed"), "success");
      await onChanged();
    } catch {
      toast(t("billing.error.resumeFailed"), "error");
    }
    setBusy(false);
  }

  const showPortal = Boolean(state.hasPortal);
  if (!showPortal && !canCancel && !pendingCancel) {
    // Nothing to manage. For a FREE account that is self-evident, but a PAID
    // account with no billing record — an Enterprise agreement, a beta grant,
    // an admin comp, or an IAP subscriber looking at the web — was shown a
    // blank space and no way to tell why the cancel button is missing.
    if (!isPaidPlan(state.plan)) return null;
    return (
      <p className="max-w-xs text-role-caption leading-relaxed text-ink-mid sm:text-right">
        {t(state.plan === "ENTERPRISE" ? "billing.enterpriseBilling" : "billing.noWebSubscription")}
      </p>
    );
  }

  return (
    // Resuming is the recovery action, so it leads and carries the accent.
    // Cancel stays last and quiet: reachable, never the thing you hit by
    // reflex. shrink-0 keeps the group intact when the plan name is long.
    <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
      {pendingCancel && state.canCancelInApp && (
        <button
          type="button"
          onClick={keepSubscription}
          disabled={busy}
          className="ease-strong focus-ring min-h-11 rounded-control bg-accent-solid px-4 py-2 text-role-label font-semibold text-accent-solid-ink transition duration-150 hover:bg-accent-solid-hover active:scale-[0.97] disabled:opacity-50"
        >
          {t("billing.keepSubscription")}
        </button>
      )}
      {showPortal && (
        <button type="button" onClick={openPortal} disabled={busy} className={BUTTON}>
          {t("billing.manageSubscription")}
        </button>
      )}
      {canCancel && (
        <button
          type="button"
          onClick={cancelSubscription}
          disabled={busy}
          className="ease-strong focus-ring min-h-11 rounded-control px-4 py-2 text-role-label text-ink-mid underline-offset-4 transition duration-150 hover:text-ink hover:underline disabled:opacity-50"
        >
          {t("billing.cancelSubscription")}
        </button>
      )}
    </div>
  );
}
